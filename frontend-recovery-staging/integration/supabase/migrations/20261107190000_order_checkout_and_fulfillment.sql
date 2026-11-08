alter table public.pix_orders
  add column if not exists order_items jsonb not null default '[]'::jsonb,
  add column if not exists shipping_address jsonb,
  add column if not exists idempotency_key_hash text,
  add column if not exists request_fingerprint text,
  add column if not exists delivery_status text not null default 'not_shipped',
  add column if not exists carrier text,
  add column if not exists tracking_code text,
  add column if not exists tracking_url text,
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists tracking_updated_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pix_orders_order_items_array' and conrelid = 'public.pix_orders'::regclass) then
    alter table public.pix_orders add constraint pix_orders_order_items_array
      check (jsonb_typeof(order_items) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pix_orders_idempotency_key_hash_format' and conrelid = 'public.pix_orders'::regclass) then
    alter table public.pix_orders add constraint pix_orders_idempotency_key_hash_format
      check (idempotency_key_hash is null or idempotency_key_hash ~ '^[a-f0-9]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pix_orders_request_fingerprint_format' and conrelid = 'public.pix_orders'::regclass) then
    alter table public.pix_orders add constraint pix_orders_request_fingerprint_format
      check (request_fingerprint is null or request_fingerprint ~ '^[a-f0-9]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pix_orders_delivery_status' and conrelid = 'public.pix_orders'::regclass) then
    alter table public.pix_orders add constraint pix_orders_delivery_status
      check (delivery_status in ('not_shipped', 'shipped', 'in_transit', 'delivered', 'exception', 'returned'));
  end if;
end;
$$;

create unique index if not exists pix_orders_idempotency_key_hash_unique
  on public.pix_orders (idempotency_key_hash)
  where idempotency_key_hash is not null;

create or replace function public.touch_pix_order_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pix_orders_touch_updated_at on public.pix_orders;
create trigger pix_orders_touch_updated_at
before update on public.pix_orders
for each row execute function public.touch_pix_order_updated_at();

create or replace function public.create_pix_order(
  p_id uuid,
  p_reference text,
  p_amount_cents integer,
  p_description text,
  p_customer jsonb,
  p_order_items jsonb,
  p_shipping_address jsonb,
  p_checkout_token_hash text,
  p_idempotency_key_hash text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.pix_orders%rowtype;
begin
  if p_id is null
     or p_reference is null
     or p_reference <> ('order-' || p_id::text)
     or p_amount_cents is null or p_amount_cents < 1
     or p_description is null or length(p_description) not between 1 and 255
     or p_customer is null or jsonb_typeof(p_customer) <> 'object'
     or p_customer->>'name' is null or p_customer->>'email' is null
     or p_customer->>'document' is null or p_customer->>'phone' is null
     or p_order_items is null or jsonb_typeof(p_order_items) <> 'array'
     or case
          when jsonb_typeof(p_order_items) = 'array'
            then jsonb_array_length(p_order_items) not between 1 and 20
          else true
        end
     or (p_shipping_address is not null and jsonb_typeof(p_shipping_address) <> 'object')
     or p_checkout_token_hash is null or p_checkout_token_hash !~ '^[a-f0-9]{64}$'
     or p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid order data';
  end if;

  insert into public.pix_orders (
    id, reference, amount_cents, description, customer, order_items,
    shipping_address, checkout_token_hash, idempotency_key_hash,
    request_fingerprint, status
  ) values (
    p_id, p_reference, p_amount_cents, p_description, p_customer, p_order_items,
    p_shipping_address, p_checkout_token_hash, p_idempotency_key_hash,
    p_request_fingerprint, 'pending'
  )
  on conflict (idempotency_key_hash) where idempotency_key_hash is not null
  do nothing
  returning * into v_order;

  if found then
    return jsonb_build_object('created', true, 'order', to_jsonb(v_order));
  end if;

  select * into v_order
    from public.pix_orders
   where idempotency_key_hash = p_idempotency_key_hash
   for update;

  if not found then
    raise exception 'Unable to resolve idempotent order';
  end if;
  if v_order.request_fingerprint <> p_request_fingerprint then
    return jsonb_build_object('created', false, 'order', to_jsonb(v_order));
  end if;

  return jsonb_build_object('created', false, 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.create_pix_order(
  uuid, text, integer, text, jsonb, jsonb, jsonb, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_pix_order(
  uuid, text, integer, text, jsonb, jsonb, jsonb, text, text, text
) to service_role;

grant select, insert, update on public.pix_orders to service_role;
