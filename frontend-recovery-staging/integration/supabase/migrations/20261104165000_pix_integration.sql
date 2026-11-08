create table if not exists public.pix_orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  amount_cents integer not null check (amount_cents > 0),
  description text not null check (length(description) between 1 and 255),
  customer jsonb not null,
  checkout_token_hash text not null check (checkout_token_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending'
    check (status in (
      'pending',
      'paid',
      'processing',
      'under_review',
      'failed',
      'refunded',
      'chargeback'
    )),
  created_at timestamptz not null default now()
);

create table if not exists public.pix_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.pix_orders(id),
  reference text not null unique references public.pix_orders(reference),
  amount_cents integer not null check (amount_cents > 0),
  gateway_transaction_id text,
  status text not null default 'creating'
    check (status in (
      'creating',
      'pending',
      'approved',
      'processing',
      'under_review',
      'failed',
      'refunded',
      'chargeback'
    )),
  qr_code text,
  qr_code_base64 text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pix_orders enable row level security;
alter table public.pix_payments enable row level security;

revoke all on public.pix_orders from anon, authenticated;
revoke all on public.pix_payments from anon, authenticated;
grant all on public.pix_orders to service_role;
grant all on public.pix_payments to service_role;

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
  v_order_status text;
begin
  if p_status not in (
    'approved',
    'pending',
    'processing',
    'under_review',
    'failed',
    'refunded',
    'chargeback'
  ) then
    raise exception 'Unsupported gateway status';
  end if;

  select order_id, status
    into v_order_id, v_payment_status
    from public.pix_payments
   where reference = p_reference
     and amount_cents = p_amount_cents
   for update;

  if not found then
    return false;
  end if;

  if v_payment_status = 'approved'
     and p_status not in ('refunded', 'chargeback') then
    return true;
  elsif v_payment_status in ('refunded', 'chargeback')
        and p_status = v_payment_status then
    return true;
  elsif v_payment_status = 'failed'
     and p_status in ('pending', 'processing', 'under_review', 'failed') then
    return true;
  elsif v_payment_status = 'processing'
     and p_status = 'pending' then
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

  v_order_status := case p_status
    when 'approved' then 'paid'
    else p_status
  end;

  update public.pix_orders
     set status = v_order_status
   where id = v_order_id;

  return true;
end;
$$;

revoke all on function public.apply_pix_gateway_status(text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_pix_gateway_status(text, integer, text, text)
  to service_role;
