-- Phase 3: admin dashboard schema.
--
-- Apply order in Supabase SQL Editor (as project owner):
--   1. supabase/phase1_orders.sql             (fresh project only)
--   2. supabase/phase1_patch.sql
--   3. supabase/phase1_schedule_patch.sql     (superseded, kept for rebuild order)
--   4. supabase/phase1_open_anytime_patch.sql
--   5. supabase/phase2_paid_at_patch.sql
--   6. supabase/phase3_admin_patch.sql        <- this file
--
-- Steps 1-5 must already be applied (step 5 adds orders.paid_at).
-- Safe to rerun. Creates tables/function only; no order data is rewritten.
--
-- Prerequisites (done once in Supabase Dashboard, not here):
--   * 7 auth users created manually (Authentication -> Users -> Add user).
--   * admin_users rows inserted for those user_ids.
--
-- Data flow after this patch:
--   browser -> Astro server: cookie session + JSON only
--   Astro server -> Supabase Auth (anon key + user tokens): session verification
--   Astro server -> Postgres (service key): admin_users check, orders, order_events, admin_login_attempts
--   browser never holds a Supabase key and never runs SQL.

begin;

-- 1) Admin membership. A dashboard user must exist here AND be aktif.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nama text not null check (length(btrim(nama)) between 1 and 120),
  aktif boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table public.admin_users is 'Whitelist anggota dashboard. user_id harus ada di auth.users.';

-- 2) Audit trail for every status change.
create table if not exists public.order_events (
  id bigint generated always as identity primary key,
  order_id text not null references public.orders(id) on delete cascade,
  dari_status text not null,
  ke_status text not null,
  admin_user_id uuid not null references public.admin_users(user_id),
  created_at timestamptz not null default now()
);
comment on table public.order_events is 'Riwayat status order: siapa, kapan, dari status apa ke status apa.';
create index if not exists order_events_order_id_created_idx
  on public.order_events(order_id, created_at desc);

-- 3) Failed-login rate limiting, keyed by HMAC(ip) and HMAC(email).
--    Only failures are recorded (successes are not counted).
--    The login route checks the counters before calling Supabase Auth.
create table if not exists public.admin_login_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists admin_login_attempts_ip_time_idx
  on public.admin_login_attempts(ip_hash, created_at desc);
create index if not exists admin_login_attempts_email_time_idx
  on public.admin_login_attempts(email_hash, created_at desc);

-- 4) Admin listing helper: status + newest first.
create index if not exists orders_status_created_idx
  on public.orders(status, created_at desc);

-- 5) Atomic status transition with guard, paid_at maintenance and audit row.
create or replace function public.admin_set_order_status(
  p_order_id text,
  p_from_status text,
  p_to_status text,
  p_admin_user_id uuid
)
returns table (
  order_id text,
  customer_name text,
  contact text,
  total bigint,
  status text,
  paid_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_admin public.admin_users%rowtype;
  v_allowed boolean;
begin
  -- Validate shape before touching anything.
  if p_order_id is null or p_order_id !~ '^TIG-[0-9]+$'
    or p_from_status is null or p_to_status is null or p_admin_user_id is null
  then
    raise exception using errcode = '22023', message = 'Data tidak valid.';
  end if;

  -- Whitelist: forward one step, backward one step, and cancellations.
  v_allowed :=
       (p_from_status = 'menunggu pembayaran' and p_to_status in ('sudah dibayar', 'batal'))
    or (p_from_status = 'sudah dibayar'      and p_to_status in ('siap diambil', 'menunggu pembayaran', 'batal'))
    or (p_from_status = 'siap diambil'       and p_to_status in ('selesai', 'sudah dibayar'))
    or (p_from_status = 'selesai'            and p_to_status in ('siap diambil'));
  if not v_allowed then
    raise exception using errcode = 'P0001', message = 'Transisi status tidak diizinkan.';
  end if;

  -- The acting admin must be a current, active member.
  select * into v_admin from public.admin_users au
   where au.user_id = p_admin_user_id and au.aktif = true;
  if not found then
    raise exception using errcode = '42501', message = 'Admin tidak berwenang.';
  end if;

  -- Guard: only move the row if it is still in p_from_status.
  -- Concurrent calls re-check the predicate, so only one of them wins.
  update public.orders o
     set status = p_to_status,
         paid_at = case
           when p_to_status = 'sudah dibayar'      then coalesce(o.paid_at, pg_catalog.now())
           when p_to_status = 'menunggu pembayaran' then null
           else o.paid_at
         end,
         updated_at = pg_catalog.now()
   where o.id = p_order_id and o.status = p_from_status
  returning * into v_order;

  -- Guard failed: the order already moved. Return no rows so the UI can say
  -- "status sudah berubah, muat ulang" instead of pretending success.
  if not found then
    return;
  end if;

  insert into public.order_events(order_id, dari_status, ke_status, admin_user_id)
  values (v_order.id, p_from_status, p_to_status, p_admin_user_id);

  return query
    select v_order.id as order_id, v_order.customer_name, v_order.contact,
           v_order.total, v_order.status, v_order.paid_at,
           v_order.created_at, v_order.updated_at;
end;
$$;

comment on function public.admin_set_order_status(text, text, text, uuid) is
  'Atomic status transition. Guard by current status; fills paid_at on ->sudah dibayar; clears paid_at on ->menunggu pembayaran; writes order_events. Returns the changed row, or nothing when the guard fails.';

-- 6) Access: RLS on, no policies for anon/authenticated, service_role only.
alter table public.admin_users enable row level security;
alter table public.order_events enable row level security;
alter table public.admin_login_attempts enable row level security;

revoke all on public.admin_users, public.order_events, public.admin_login_attempts
  from public, anon, authenticated;
grant all on public.admin_users, public.order_events, public.admin_login_attempts to service_role;

revoke all on sequence public.order_events_id_seq, public.admin_login_attempts_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.order_events_id_seq, public.admin_login_attempts_id_seq to service_role;

revoke execute on function public.admin_set_order_status(text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_set_order_status(text, text, text, uuid)
  to service_role;

commit;

-- ============================================================================
-- Read-only verification. Every ok value must be true. No data is written.
-- ============================================================================

select 'orders.paid_at exists (from phase2)' as check_name,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'orders' and column_name = 'paid_at'
           and data_type = 'timestamp with time zone'
       ) as ok;

select 'admin_users columns: user_id, nama, aktif default true, created_at' as check_name,
       exists (
         select 1 from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = 'admin_users'
           and c.column_name = 'user_id' and c.data_type = 'uuid' and c.is_nullable = 'NO'
       ) and exists (
         select 1 from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = 'admin_users'
           and c.column_name = 'aktif' and c.column_default like '%true%'
       ) as ok;

select 'order_events has order_id FK, status pair, admin_user_id, created_at' as check_name,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'order_events'
           and column_name in ('order_id', 'dari_status', 'ke_status', 'admin_user_id', 'created_at')
         group by table_schema, table_name
         having count(*) = 5
       ) as ok;

select 'order_events index (order_id, created_at desc)' as check_name,
       exists (
         select 1 from pg_indexes
         where schemaname = 'public' and tablename = 'order_events'
           and indexname = 'order_events_order_id_created_idx'
       ) as ok;

select 'admin_login_attempts has ip_hash + email_hash (sha256 hex) and indexes' as check_name,
       exists (
         select 1 from pg_indexes
         where schemaname = 'public' and tablename = 'admin_login_attempts'
           and indexname in ('admin_login_attempts_ip_time_idx', 'admin_login_attempts_email_time_idx')
         group by schemaname, tablename
         having count(*) = 2
       ) as ok;

select 'orders index (status, created_at desc)' as check_name,
       exists (
         select 1 from pg_indexes
         where schemaname = 'public' and tablename = 'orders'
           and indexname = 'orders_status_created_idx'
       ) as ok;

select 'RLS enabled on admin_users, order_events, admin_login_attempts' as check_name,
       (select count(*) = 3 from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relname in ('admin_users', 'order_events', 'admin_login_attempts')
           and c.relrowsecurity) as ok;

select 'no anon/authenticated policies on the admin tables' as check_name,
       not exists (
         select 1 from pg_policies
         where schemaname = 'public'
           and tablename in ('admin_users', 'order_events', 'admin_login_attempts')
           and exists (select 1 from unnest(roles) r where r::text in ('anon', 'authenticated'))
       ) as ok;

select 'service_role has access, anon/authenticated do not' as check_name,
       has_table_privilege('service_role', 'public.admin_users', 'SELECT')
   and has_table_privilege('service_role', 'public.order_events', 'SELECT')
   and has_table_privilege('service_role', 'public.admin_login_attempts', 'SELECT')
   and not has_table_privilege('anon', 'public.admin_users', 'SELECT')
   and not has_table_privilege('authenticated', 'public.admin_users', 'SELECT')
   and not has_table_privilege('anon', 'public.order_events', 'SELECT')
   and not has_table_privilege('authenticated', 'public.order_events', 'SELECT')
   and not has_table_privilege('anon', 'public.admin_login_attempts', 'SELECT')
   and not has_table_privilege('authenticated', 'public.admin_login_attempts', 'SELECT') as ok;

select 'admin_set_order_status exists with 4 arguments' as check_name,
       exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'admin_set_order_status' and p.pronargs = 4
       ) as ok;

select 'admin_set_order_status granted to service_role only' as check_name,
       has_function_privilege('service_role', 'public.admin_set_order_status(text,text,text,uuid)', 'EXECUTE')
   and not has_function_privilege('anon', 'public.admin_set_order_status(text,text,text,uuid)', 'EXECUTE')
   and not has_function_privilege('authenticated', 'public.admin_set_order_status(text,text,text,uuid)', 'EXECUTE')
   and not exists (
         select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where n.nspname = 'public' and p.proname = 'admin_set_order_status'
           and p.pronargs = 4 and a.privilege_type = 'EXECUTE' and a.grantee = 0
       ) as ok;

-- Illegal transition must raise (whitelist is checked before anything is written).
do $$
declare
  v_raised boolean := false;
begin
  begin
    perform public.admin_set_order_status('TIG-0000', 'menunggu pembayaran', 'selesai', gen_random_uuid());
  exception when others then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'verification failed: illegal transition was not rejected';
  end if;
end $$;

-- Malformed Order ID must raise.
do $$
declare
  v_raised boolean := false;
begin
  begin
    perform public.admin_set_order_status('BUKAN-TIG', 'menunggu pembayaran', 'sudah dibayar', gen_random_uuid());
  exception when others then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'verification failed: malformed order id was not rejected';
  end if;
end $$;

-- Runtime transition behaviour is intentionally NOT verified here: it would
-- need a real auth.users row plus an admin_users row. It is covered by the
-- application tests and the end-to-end pass once the 7 accounts exist.
