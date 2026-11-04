-- Phase 1 order schema and atomic RPC.
-- Fresh Supabase project only. Run once in SQL Editor as project owner.
-- Never return raw IP/phone or their hashes from the RPC; no anon/authenticated policies.
-- This script uses only built-in PostgreSQL functions/extensions already enabled in Supabase.

create sequence if not exists public.order_id_seq start with 1 increment by 1;

create table if not exists public.orders (
  id text primary key,
  idempotency_key uuid not null unique,
  customer_name text not null check (length(btrim(customer_name)) between 1 and 120),
  contact text not null check (contact ~ '^628[0-9]{7,12}$'),
  contact_hash text not null check (contact_hash ~ '^[0-9a-f]{64}$'),
  total bigint not null check (total >= 0),
  status text not null default 'menunggu pembayaran'
    check (status in ('menunggu pembayaran', 'sudah dibayar', 'siap diambil', 'selesai', 'batal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id text not null references public.orders(id) on delete cascade,
  product_id text not null check (product_id in ('risol-mayo', 'coffee-bun', 'matcha')),
  product_name text not null check (length(btrim(product_name)) between 1 and 120),
  variant text,
  quantity integer not null check (quantity between 1 and 20),
  unit_price bigint not null check (unit_price >= 0),
  subtotal bigint not null check (subtotal = unit_price * quantity),
  check (
    (product_id = 'risol-mayo' and variant is not null and variant in ('Original', 'Spicy', 'Mix'))
    or (product_id in ('coffee-bun', 'matcha') and variant is null)
  )
);

create index if not exists order_items_order_id_idx on public.order_items(order_id);
create unique index if not exists order_items_order_product_variant_uidx
  on public.order_items(order_id, product_id, (coalesce(variant, '')));
create index if not exists orders_created_at_idx on public.orders(created_at desc);

create table if not exists public.order_rate_events (
  id bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  contact_hash text not null check (contact_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists order_rate_events_ip_time_idx on public.order_rate_events(ip_hash, created_at desc);
create index if not exists order_rate_events_contact_time_idx on public.order_rate_events(contact_hash, created_at desc);
create index if not exists order_rate_events_created_at_idx on public.order_rate_events(created_at);

create or replace function public.set_order_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function public.set_order_updated_at() from public, anon, authenticated;
grant execute on function public.set_order_updated_at() to service_role;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
before update on public.orders
for each row execute function public.set_order_updated_at();

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
    raise exception using errcode = '22023', message = 'invalid_order_input';
  end if;

  -- Idempotent retries return original order without consuming rate-limit quota.
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
        or (x.product_id = 'risol-mayo' and x.variant not in ('Original', 'Spicy', 'Mix'))
        or (x.product_id in ('coffee-bun', 'matcha') and x.variant is not null)
        or x.product_id not in ('risol-mayo', 'coffee-bun', 'matcha')
        or pg_catalog.length(pg_catalog.btrim(x.product_name)) not between 1 and 120
    )
  then
    raise exception using errcode = '22023', message = 'invalid_order_items';
  end if;

  -- Keep limiter storage bounded; older events cannot affect a 10-minute window.
  delete from public.order_rate_events e where e.created_at <= pg_catalog.now() - interval '10 minutes';

  -- Stable lock order avoids deadlocks when requests share different identities.
  for v_hash in
    select h from (values
      (p_ip_hash),
      (p_contact_hash),
      ('idempotency:' || p_idempotency_key::text)
    ) as hashes(h) order by h
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_hash, 0));
  end loop;

  -- A concurrent retry may have committed while this call waited for the key lock.
  select o.* into v_order from public.orders o where o.idempotency_key = p_idempotency_key;
  if found then
    return query select v_order.id, v_order.total, v_order.status, v_order.created_at,
      (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'product_id', i.product_id, 'product_name', i.product_name, 'variant', i.variant,
        'quantity', i.quantity, 'unit_price', i.unit_price, 'subtotal', i.subtotal
      ) order by i.id), '[]'::jsonb) from public.order_items i where i.order_id = v_order.id), false;
    return;
  end if;

  if (select pg_catalog.count(*) from public.order_rate_events e
      where e.ip_hash = p_ip_hash and e.created_at > pg_catalog.now() - interval '10 minutes') >= 5
    or (select pg_catalog.count(*) from public.order_rate_events e
      where e.contact_hash = p_contact_hash and e.created_at > pg_catalog.now() - interval '10 minutes') >= 5
  then
    raise exception using errcode = 'P0001', message = 'order_rate_limited';
  end if;

  v_order_id := 'TIG-' || pg_catalog.lpad(
    pg_catalog.nextval('public.order_id_seq')::text,
    greatest(4, pg_catalog.length(pg_catalog.currval('public.order_id_seq')::text)),
    '0'
  );
  insert into public.orders(id, idempotency_key, customer_name, contact, contact_hash, total)
    values (v_order_id, p_idempotency_key, pg_catalog.btrim(p_customer_name), p_contact, p_contact_hash, p_total)
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

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_rate_events enable row level security;

revoke all on public.orders, public.order_items, public.order_rate_events from public, anon, authenticated;
revoke all on sequence public.order_id_seq from public, anon, authenticated;
revoke all on sequence public.order_items_id_seq, public.order_rate_events_id_seq from public, anon, authenticated;
grant all on public.orders, public.order_items, public.order_rate_events to service_role;
grant usage, select on sequence public.order_id_seq, public.order_items_id_seq, public.order_rate_events_id_seq to service_role;
revoke all on function public.create_order_atomic(uuid, text, text, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.create_order_atomic(uuid, text, text, text, text, jsonb, bigint) to service_role;
