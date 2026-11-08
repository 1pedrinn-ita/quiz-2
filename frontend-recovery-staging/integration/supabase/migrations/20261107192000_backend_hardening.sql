alter table public.pix_orders
  add column if not exists checkout_token_key_version smallint not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pix_orders_id_reference_unique'
       and conrelid = 'public.pix_orders'::regclass
  ) then
    alter table public.pix_orders
      add constraint pix_orders_id_reference_unique unique (id, reference);
  end if;
end;
$$;

do $$
declare
  v_mismatch_count bigint;
begin
  select count(*) into v_mismatch_count
    from public.pix_payments p
    left join public.pix_orders o on o.id = p.order_id and o.reference = p.reference
   where o.id is null or o.amount_cents <> p.amount_cents;
  if v_mismatch_count > 0 then
    raise exception 'Cannot add payment/order integrity constraints: % mismatched payment rows', v_mismatch_count;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'pix_payments_order_reference_fkey'
       and conrelid = 'public.pix_payments'::regclass
  ) then
    alter table public.pix_payments
      add constraint pix_payments_order_reference_fkey
      foreign key (order_id, reference)
      references public.pix_orders (id, reference);
  end if;
end;
$$;

do $$
declare
  v_duplicate_count bigint;
begin
  select count(*) into v_duplicate_count
    from (
      select gateway_transaction_id
        from public.pix_payments
       where gateway_transaction_id is not null
       group by gateway_transaction_id
      having count(*) > 1
    ) duplicates;
  if v_duplicate_count > 0 then
    raise exception 'Cannot enforce unique gateway transactions: % duplicated IDs', v_duplicate_count;
  end if;
end;
$$;

create unique index if not exists pix_payments_gateway_transaction_id_unique
  on public.pix_payments (gateway_transaction_id)
  where gateway_transaction_id is not null;

create or replace function public.check_pix_payment_order_amount()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_order_amount integer;
begin
  select amount_cents into v_order_amount
    from public.pix_orders
   where id = new.order_id and reference = new.reference
   for key share;
  if not found or v_order_amount <> new.amount_cents then
    raise exception 'Payment order, reference, or amount mismatch';
  end if;
  return new;
end;
$$;

revoke all on function public.check_pix_payment_order_amount()
  from public, anon, authenticated;

drop trigger if exists pix_payments_check_order_amount on public.pix_payments;
create trigger pix_payments_check_order_amount
before insert or update of order_id, reference, amount_cents on public.pix_payments
for each row execute function public.check_pix_payment_order_amount();

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pix_orders_checkout_token_key_version'
       and conrelid = 'public.pix_orders'::regclass
  ) then
    alter table public.pix_orders
      add constraint pix_orders_checkout_token_key_version
      check (checkout_token_key_version between 1 and 9999);
  end if;
end;
$$;

create table if not exists public.pix_order_tracking_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.pix_orders(id),
  previous_status text not null,
  new_status text not null,
  carrier text,
  tracking_code text,
  tracking_url text,
  actor text not null,
  created_at timestamptz not null default now(),
  check (previous_status in ('not_shipped', 'shipped', 'in_transit', 'delivered', 'exception', 'returned')),
  check (new_status in ('not_shipped', 'shipped', 'in_transit', 'delivered', 'exception', 'returned'))
);

create index if not exists pix_order_tracking_events_order_created_idx
  on public.pix_order_tracking_events (order_id, created_at desc);

alter table public.pix_order_tracking_events enable row level security;
revoke all on public.pix_order_tracking_events from anon, authenticated;
grant all on public.pix_order_tracking_events to service_role;

create table if not exists public.api_rate_limits (
  bucket_hash text not null check (bucket_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null,
  primary key (bucket_hash, window_started_at)
);

create index if not exists api_rate_limits_expires_idx
  on public.api_rate_limits (expires_at);

alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from anon, authenticated;
grant all on public.api_rate_limits to service_role;

create or replace function public.consume_api_rate_limit(
  p_bucket_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_bucket_hash is null or p_bucket_hash !~ '^[a-f0-9]{64}$'
     or p_limit is null or p_limit < 1 or p_limit > 100000
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Invalid rate limit parameters';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.api_rate_limits (bucket_hash, window_started_at, request_count, expires_at)
  values (p_bucket_hash, v_window_start, 1, v_window_start + make_interval(secs => p_window_seconds))
  on conflict (bucket_hash, window_started_at)
  do update set request_count = public.api_rate_limits.request_count + 1
  where public.api_rate_limits.request_count < p_limit
  returning request_count into v_count;

  delete from public.api_rate_limits where expires_at < clock_timestamp();
  return v_count is not null;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, integer, integer)
  to service_role;

create or replace function public.create_pix_order(
  p_id uuid,
  p_reference text,
  p_amount_cents integer,
  p_description text,
  p_customer jsonb,
  p_order_items jsonb,
  p_shipping_address jsonb,
  p_checkout_token_hash text,
  p_checkout_token_key_version smallint,
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
     or p_order_items is null
     or case
          when jsonb_typeof(p_order_items) = 'array'
            then jsonb_array_length(p_order_items) not between 1 and 20
          else true
        end
     or (p_shipping_address is not null and jsonb_typeof(p_shipping_address) <> 'object')
     or p_checkout_token_hash is null or p_checkout_token_hash !~ '^[a-f0-9]{64}$'
     or p_checkout_token_key_version is null or p_checkout_token_key_version not between 1 and 9999
     or p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$'
     or p_request_fingerprint is null or p_request_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid order data';
  end if;

  insert into public.pix_orders (
    id, reference, amount_cents, description, customer, order_items,
    shipping_address, checkout_token_hash, checkout_token_key_version,
    idempotency_key_hash, request_fingerprint, status
  ) values (
    p_id, p_reference, p_amount_cents, p_description, p_customer, p_order_items,
    p_shipping_address, p_checkout_token_hash, p_checkout_token_key_version,
    p_idempotency_key_hash, p_request_fingerprint, 'pending'
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
  return jsonb_build_object('created', false, 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.create_pix_order(
  uuid, text, integer, text, jsonb, jsonb, jsonb, text, smallint, text, text
) from public, anon, authenticated;
grant execute on function public.create_pix_order(
  uuid, text, integer, text, jsonb, jsonb, jsonb, text, smallint, text, text
) to service_role;

create or replace function public.apply_pix_gateway_status(
  p_reference text,
  p_amount_cents integer,
  p_gateway_transaction_id text,
  p_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_payment_status text;
begin
  if p_status not in (
    'approved', 'pending', 'processing', 'under_review',
    'failed', 'refunded', 'chargeback'
  ) or p_status is null or p_gateway_transaction_id is null
     or length(p_gateway_transaction_id) not between 1 and 200 then
    raise exception 'Unsupported gateway status';
  end if;

  select order_id, status
    into v_order_id, v_payment_status
    from public.pix_payments
   where reference = p_reference
     and amount_cents = p_amount_cents
   for update;
  if not found then return false; end if;

  if v_payment_status = 'approved' then
    if p_status not in ('refunded', 'chargeback') then return true; end if;
  elsif v_payment_status = 'chargeback' then
    return true;
  elsif v_payment_status = 'refunded' then
    if p_status <> 'chargeback' then return true; end if;
  elsif v_payment_status = 'failed'
        and p_status not in ('pending', 'processing', 'under_review', 'failed', 'approved') then
    return true;
  elsif v_payment_status = 'processing' and p_status = 'pending' then
    return true;
  elsif v_payment_status = 'under_review'
        and p_status in ('pending', 'processing') then
    return true;
  end if;

  update public.pix_payments
     set status = p_status,
         gateway_transaction_id = p_gateway_transaction_id,
         updated_at = now()
   where reference = p_reference;

  update public.pix_orders
     set status = case p_status when 'approved' then 'paid' else p_status end
   where id = v_order_id;
  return true;
end;
$$;

revoke all on function public.apply_pix_gateway_status(text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_pix_gateway_status(text, integer, text, text)
  to service_role;

create or replace function public.update_pix_order_tracking(
  p_order_id uuid,
  p_delivery_status text,
  p_carrier text,
  p_tracking_code text,
  p_tracking_url text,
  p_set_carrier boolean,
  p_set_tracking_code boolean,
  p_set_tracking_url boolean,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.pix_orders%rowtype;
  v_previous_status text;
  v_now timestamptz := clock_timestamp();
  v_allowed boolean;
begin
  if p_order_id is null
     or p_delivery_status not in ('not_shipped', 'shipped', 'in_transit', 'delivered', 'exception', 'returned')
     or p_actor <> 'operations-token'
     or (p_set_carrier and length(coalesce(p_carrier, '')) > 120)
     or (p_set_tracking_code and length(coalesce(p_tracking_code, '')) > 120)
     or (p_set_tracking_url and p_tracking_url is not null
         and (length(p_tracking_url) > 2048 or p_tracking_url !~* '^https://')) then
    raise exception 'Invalid tracking update';
  end if;

  select * into v_order
    from public.pix_orders
   where id = p_order_id and status = 'paid'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'order_not_found_or_unpaid');
  end if;

  v_previous_status := v_order.delivery_status;
  v_allowed := p_delivery_status = v_previous_status or
    case v_previous_status
      when 'not_shipped' then p_delivery_status in ('shipped', 'exception')
      when 'shipped' then p_delivery_status in ('in_transit', 'delivered', 'exception', 'returned')
      when 'in_transit' then p_delivery_status in ('delivered', 'exception', 'returned')
      when 'exception' then p_delivery_status in ('in_transit', 'delivered', 'returned')
      when 'delivered' then false
      when 'returned' then false
      else false
    end;
  if not v_allowed then
    return jsonb_build_object('ok', false, 'error', 'invalid_delivery_transition');
  end if;

  update public.pix_orders
     set delivery_status = p_delivery_status,
         carrier = case when p_set_carrier then nullif(btrim(p_carrier), '') else carrier end,
         tracking_code = case when p_set_tracking_code then nullif(btrim(p_tracking_code), '') else tracking_code end,
         tracking_url = case when p_set_tracking_url then p_tracking_url else tracking_url end,
         shipped_at = case when p_delivery_status = 'shipped' then coalesce(shipped_at, v_now) else shipped_at end,
         delivered_at = case when p_delivery_status = 'delivered' then coalesce(delivered_at, v_now) else delivered_at end,
         tracking_updated_at = v_now
   where id = p_order_id
   returning * into v_order;

  insert into public.pix_order_tracking_events (
    order_id, previous_status, new_status, carrier, tracking_code, tracking_url, actor, created_at
  ) values (
    p_order_id, v_previous_status, p_delivery_status, v_order.carrier,
    v_order.tracking_code, v_order.tracking_url, p_actor, v_now
  );

  return jsonb_build_object('ok', true, 'delivery', jsonb_build_object(
    'status', v_order.delivery_status,
    'carrier', v_order.carrier,
    'tracking_code', v_order.tracking_code,
    'tracking_url', v_order.tracking_url,
    'shipped_at', v_order.shipped_at,
    'delivered_at', v_order.delivered_at,
    'tracking_updated_at', v_order.tracking_updated_at
  ));
end;
$$;

revoke all on function public.update_pix_order_tracking(
  uuid, text, text, text, text, boolean, boolean, boolean, text
) from public, anon, authenticated;
grant execute on function public.update_pix_order_tracking(
  uuid, text, text, text, text, boolean, boolean, boolean, text
) to service_role;
