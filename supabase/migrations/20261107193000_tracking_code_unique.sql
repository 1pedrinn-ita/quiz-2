do $$
declare
  v_duplicate_count bigint;
begin
  select count(*) into v_duplicate_count
    from (
      select tracking_code
        from public.pix_orders
       where tracking_code is not null
       group by tracking_code
      having count(*) > 1
    ) duplicates;
  if v_duplicate_count > 0 then
    raise exception 'Cannot make tracking codes unique: % duplicate codes exist', v_duplicate_count;
  end if;
end;
$$;

create unique index if not exists pix_orders_tracking_code_unique
  on public.pix_orders (tracking_code)
  where tracking_code is not null;
