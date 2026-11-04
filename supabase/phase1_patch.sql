-- Phase 1 patch for existing orders schema.
-- Run the entire file once in Supabase SQL Editor as project owner. Safe to rerun.
-- This script does not create access policies or expose customer data.

begin;

-- 1. Add order source, defaulting all existing/new rows to preorder.
alter table public.orders
  add column if not exists source text;
update public.orders set source = 'preorder' where source is null;
alter table public.orders alter column source set default 'preorder';
alter table public.orders alter column source set not null;
alter table public.orders drop constraint if exists orders_source_check;
alter table public.orders add constraint orders_source_check
  check (source in ('preorder', 'kasir'));

-- 2. Nullable deadline means pre-orders stay open until a deadline is configured.
create table if not exists public.order_settings (
  singleton boolean primary key default true check (singleton),
  po_deadline timestamptz
);
insert into public.order_settings(singleton, po_deadline)
values (true, null)
on conflict (singleton) do nothing;
alter table public.order_settings enable row level security;
revoke all on public.order_settings from public, anon, authenticated;
grant select on public.order_settings to service_role;

-- 3. Keep only one day's rate events. Hashes remain the only persisted identifiers.
-- Rate limit: 5 orders / 10 minutes / WhatsApp hash; 30 / 10 minutes / IP hash.

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

  -- Idempotent retry returns the original order, before deadline/rate checks.
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

  -- Another same-key request may have committed while this call waited for its lock.
  select o.* into v_order from public.orders o where o.idempotency_key = p_idempotency_key;
  if found then
    return query select v_order.id, v_order.total, v_order.status, v_order.created_at,
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'product_id', i.product_id, 'product_name', i.product_name, 'variant', i.variant,
        'quantity', i.quantity, 'unit_price', i.unit_price, 'subtotal', i.subtotal
      ) order by i.id), '[]'::jsonb) from public.order_items i where i.order_id = v_order.id), false;
    return;
  end if;

  select s.po_deadline into v_po_deadline
  from public.order_settings s where s.singleton = true;
  if v_po_deadline is not null and pg_catalog.now() >= v_po_deadline then
    raise exception using errcode = 'P0001', message = 'Periode pre-order telah ditutup.';
  end if;

  -- Purge stale rate events; they cannot affect either 10-minute window.
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

-- 4. Reinforce RPC access: only service_role may execute.
revoke execute on function public.create_order_atomic(uuid, text, text, text, text, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function public.create_order_atomic(uuid, text, text, text, text, jsonb, bigint)
  to service_role;

commit;

-- 5. Read-only verification; run after the patch. All rows should report ok=true.
select 'orders.source exists, default preorder, not-null' as check_name,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'orders' and column_name = 'source'
           and is_nullable = 'NO' and column_default like '%preorder%'
       ) as ok
union all
select 'orders.source allows preorder/kasir',
       exists (
         select 1 from pg_constraint
         where conrelid = 'public.orders'::regclass and conname = 'orders_source_check'
       )
union all
select 'RPC execute denied to PUBLIC, anon, authenticated',
       not exists (
         select 1
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where n.nspname = 'public' and p.proname = 'create_order_atomic'
           and p.pronargs = 7 and a.privilege_type = 'EXECUTE'
           and (a.grantee = 0 or a.grantee in (
             (select oid from pg_roles where rolname = 'anon'),
             (select oid from pg_roles where rolname = 'authenticated')
           ))
       )
union all
select 'RPC execute granted to service_role',
       exists (
         select 1
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         join pg_roles r on r.oid = a.grantee
         where n.nspname = 'public' and p.proname = 'create_order_atomic'
           and p.pronargs = 7 and a.privilege_type = 'EXECUTE' and r.rolname = 'service_role'
       );

-- Deadline is open when NULL. Review configured deadline without reading order/customer data.
select po_deadline, (po_deadline is null or po_deadline > now()) as preorder_open
from public.order_settings where singleton = true;

-- Rate-limit parameters embedded in the deployed RPC (confirm expected 5/30 and 10-minute windows).
select position('>= 5' in p.prosrc) > 0
       and position('>= 30' in p.prosrc) > 0
       and position('interval ''10 minutes''' in p.prosrc) > 0 as rate_limits_match_expected
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'create_order_atomic' and p.pronargs = 7;
