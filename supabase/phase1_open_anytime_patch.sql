-- Phase 1 open-anytime replacement patch.
-- Rebuild SQL order: phase1_orders.sql -> phase1_patch.sql -> phase1_schedule_patch.sql -> phase1_open_anytime_patch.sql.
-- phase1_schedule_patch.sql (file 3) is superseded by phase1_open_anytime_patch.sql (file 4). Run file 4 after file 3 for upgrades.
-- No RLS policies are created. Safe to rerun; preserves existing order/deadline data.

begin;

drop trigger if exists orders_enforce_preorder_window on public.orders;
drop function if exists public.enforce_preorder_window();

alter table public.order_settings
  add column if not exists po_open boolean not null default true,
  drop column if exists po_open_day,
  drop column if exists po_open_time,
  drop column if exists po_close_day,
  drop column if exists po_close_time,
  drop column if exists pickup_day,
  drop column if exists pickup_open_time,
  drop column if exists pickup_close_time;
update public.order_settings set po_open = true where po_open is null;
alter table public.order_settings alter column po_open set default true;
alter table public.order_settings alter column po_open set not null;

-- Removed schedule columns: po_open_day, po_open_time, po_close_day,
-- po_close_time, pickup_day, pickup_open_time, pickup_close_time.
-- Keep po_deadline; it remains an independent closing limit.

alter table public.orders
  add column if not exists pickup_date date,
  add column if not exists pickup_note text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_pickup_note_length_check'
  ) then
    alter table public.orders add constraint orders_pickup_note_length_check
      check (pickup_note is null or pg_catalog.char_length(pickup_note) <= 300);
  end if;
end;
$$;

create or replace function public.create_order_atomic(
  p_idempotency_key uuid,
  p_customer_name text,
  p_contact text,
  p_contact_hash text,
  p_ip_hash text,
  p_items jsonb,
  p_total bigint
)
returns table (
  order_id text,
  total bigint,
  status text,
  created_at timestamptz,
  items jsonb,
  was_created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id text;
  v_order public.orders%rowtype;
  v_count integer;
  v_qty integer;
  v_sum bigint;
  v_hash text;
  v_po_open boolean;
  v_po_deadline timestamptz;
begin
  if p_idempotency_key is null
    or p_customer_name is null
    or pg_catalog.length(pg_catalog.btrim(p_customer_name)) not between 1 and 120
    or p_contact is null or p_contact !~ '^628[0-9]{7,12}$'
    or p_contact_hash is null or p_contact_hash !~ '^[0-9a-f]{64}$'
    or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
    or p_total is null or p_total < 0
    or pg_catalog.jsonb_typeof(p_items) <> 'array'
  then
    raise exception using errcode = '22023', message = 'Data pesanan tidak valid.';
  end if;

  -- Idempotent retry returns original order before open/deadline/rate checks.
  select o.* into v_order from public.orders o where o.idempotency_key = p_idempotency_key;
  if found then
    return query select v_order.id, v_order.total, v_order.status, v_order.created_at,
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'product_id', i.product_id, 'product_name', i.product_name, 'variant', i.variant,
        'quantity', i.quantity, 'unit_price', i.unit_price, 'subtotal', i.subtotal
      ) order by i.id), '[]'::jsonb) from public.order_items i where i.order_id = v_order.id), false;
    return;
  end if;

  select pg_catalog.count(*), coalesce(pg_catalog.sum(x.quantity), 0),
    coalesce(pg_catalog.sum(x.subtotal), 0)
    into v_count, v_qty, v_sum
  from pg_catalog.jsonb_to_recordset(p_items) as x(
    product_id text, product_name text, variant text, quantity integer, unit_price bigint, subtotal bigint
  );

  if v_count < 1 or v_count > 5 or v_qty < 1 or v_qty > 20 or v_sum <> p_total
    or exists (
      select 1 from pg_catalog.jsonb_to_recordset(p_items) as x(
        product_id text, product_name text, variant text, quantity integer, unit_price bigint, subtotal bigint
      )
      where x.product_id is null or x.product_name is null or x.quantity is null or x.quantity < 1 or x.quantity > 20
        or x.unit_price is null or x.unit_price < 0 or x.subtotal is null or x.subtotal <> x.unit_price * x.quantity
        or (x.product_id = 'risol-mayo' and (x.variant is null or x.variant not in ('Original', 'Spicy', 'Mix')))
        or (x.product_id in ('coffee-bun', 'matcha') and x.variant is not null)
        or x.product_id not in ('risol-mayo', 'coffee-bun', 'matcha')
        or pg_catalog.length(pg_catalog.btrim(x.product_name)) not between 1 and 120
    )
  then
    raise exception using errcode = '22023', message = 'Isi pesanan tidak valid.';
  end if;

  -- Stable lock order serializes duplicate idempotency keys and both rate-limit identities.
  for v_hash in
    select h from (values
      (p_ip_hash),
      (p_contact_hash),
      ('idempotency:' || p_idempotency_key::text)
    ) as hashes(h) order by h
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_hash, 0));
  end loop;

  -- Recheck after waiting for the idempotency lock.
  select o.* into v_order from public.orders o where o.idempotency_key = p_idempotency_key;
  if found then
    return query select v_order.id, v_order.total, v_order.status, v_order.created_at,
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'product_id', i.product_id, 'product_name', i.product_name, 'variant', i.variant,
        'quantity', i.quantity, 'unit_price', i.unit_price, 'subtotal', i.subtotal
      ) order by i.id), '[]'::jsonb) from public.order_items i where i.order_id = v_order.id), false;
    return;
  end if;

  select s.po_open, s.po_deadline into v_po_open, v_po_deadline
  from public.order_settings s where s.singleton = true;
  if v_po_open is false then
    raise exception using errcode = 'P0001', message = 'Pre-order sedang ditutup.';
  end if;
  if v_po_deadline is not null and pg_catalog.now() >= v_po_deadline then
    raise exception using errcode = 'P0001', message = 'Periode pre-order telah ditutup.';
  end if;

  -- Purge stale events; they cannot affect either 10-minute window.
  delete from public.order_rate_events e
  where e.created_at < pg_catalog.now() - interval '1 day';

  if (select pg_catalog.count(*) from public.order_rate_events e
      where e.contact_hash = p_contact_hash
        and e.created_at > pg_catalog.now() - interval '10 minutes') >= 5
    or (select pg_catalog.count(*) from public.order_rate_events e
      where e.ip_hash = p_ip_hash
        and e.created_at > pg_catalog.now() - interval '10 minutes') >= 30
  then
    raise exception using errcode = 'P0001', message = 'Terlalu banyak pesanan. Coba lagi nanti.';
  end if;

  v_order_id := 'TIG-' || pg_catalog.lpad(
    pg_catalog.nextval('public.order_id_seq')::text,
    greatest(4, pg_catalog.length(pg_catalog.currval('public.order_id_seq')::text)),
    '0'
  );

  insert into public.orders(id, idempotency_key, customer_name, contact, contact_hash, total, source)
    values (v_order_id, p_idempotency_key, pg_catalog.btrim(p_customer_name), p_contact,
      p_contact_hash, p_total, 'preorder')
    on conflict (idempotency_key) do nothing
    returning * into v_order;

  if not found then
    raise exception using errcode = '40001', message = 'idempotency_retry';
  end if;

  insert into public.order_items(order_id, product_id, product_name, variant, quantity, unit_price, subtotal)
  select v_order.id, x.product_id, x.product_name, x.variant, x.quantity, x.unit_price, x.subtotal
  from pg_catalog.jsonb_to_recordset(p_items) as x(
    product_id text, product_name text, variant text, quantity integer, unit_price bigint, subtotal bigint
  );

  insert into public.order_rate_events(ip_hash, contact_hash) values (p_ip_hash, p_contact_hash);

  return query select v_order.id, v_order.total, v_order.status, v_order.created_at,
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'product_id', i.product_id, 'product_name', i.product_name, 'variant', i.variant,
      'quantity', i.quantity, 'unit_price', i.unit_price, 'subtotal', i.subtotal
    ) order by i.id), '[]'::jsonb) from public.order_items i where i.order_id = v_order.id), true;
end;
$$;

revoke execute on function public.create_order_atomic(uuid, text, text, text, text, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.create_order_atomic(uuid, text, text, text, text, jsonb, bigint)
  to service_role;

commit;

-- Read-only verification; every ok value must be true.
select 'schedule trigger absent' as check_name,
       not exists (
         select 1 from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'orders'
           and t.tgname = 'orders_enforce_preorder_window' and not t.tgisinternal
       ) as ok
union all
select 'schedule function absent',
       not exists (
         select 1 from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'enforce_preorder_window'
       )
union all
select 'pickup_date, pickup_note and po_open columns exist',
       (select pg_catalog.count(*) = 3 from information_schema.columns
        where (table_schema, table_name, column_name) in
          (('public','orders','pickup_date'), ('public','orders','pickup_note'), ('public','order_settings','po_open')))
union all
select 'pickup_note length constraint exists',
       exists (select 1 from pg_catalog.pg_constraint
               where conrelid = 'public.orders'::regclass and conname = 'orders_pickup_note_length_check')
union all
select 'create_order_atomic has one 7-argument version',
       (select pg_catalog.count(*) = 1 from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'create_order_atomic' and p.pronargs = 7)
union all
select 'RPC grant is service_role only',
       (exists (
          select 1 from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          join pg_catalog.pg_roles r on r.oid = a.grantee
          where n.nspname = 'public' and p.proname = 'create_order_atomic' and p.pronargs = 7
            and r.rolname = 'service_role' and a.privilege_type = 'EXECUTE'
        ) and not exists (
          select 1 from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where n.nspname = 'public' and p.proname = 'create_order_atomic' and p.pronargs = 7
            and a.privilege_type = 'EXECUTE'
            and (a.grantee = 0 or a.grantee in (
              (select oid from pg_catalog.pg_roles where rolname = 'anon'),
              (select oid from pg_catalog.pg_roles where rolname = 'authenticated')
            ))
        ));
