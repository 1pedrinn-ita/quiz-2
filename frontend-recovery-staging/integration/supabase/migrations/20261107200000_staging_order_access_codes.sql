-- Staging-only support for the original CR-... post-sale lookup code.
-- Stores only a SHA-256 digest; public/anon clients receive no direct table access.
alter table public.pix_orders
  add column if not exists legacy_access_code_hash text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'pix_orders_legacy_access_code_hash_format'
       and conrelid = 'public.pix_orders'::regclass
  ) then
    alter table public.pix_orders
      add constraint pix_orders_legacy_access_code_hash_format
      check (legacy_access_code_hash is null or legacy_access_code_hash ~ '^[a-f0-9]{64}$');
  end if;
end;
$$;

create unique index if not exists pix_orders_legacy_access_code_hash_unique
  on public.pix_orders (legacy_access_code_hash)
  where legacy_access_code_hash is not null;

revoke all on public.pix_orders from anon, authenticated;
grant select, insert, update on public.pix_orders to service_role;
