-- Read-only Supabase Phase 1 audit. Run all statements in Supabase SQL Editor.
-- Returns metadata only; does not select customer/order values.

-- 1) Required table columns, types, defaults, nullability.
select table_name, column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('orders', 'order_items', 'order_rate_events')
order by table_name, ordinal_position;

-- 2) Primary/unique/check/foreign-key constraints for order tables.
select c.relname as table_name, con.conname as constraint_name,
       case con.contype when 'p' then 'PRIMARY KEY' when 'u' then 'UNIQUE'
         when 'c' then 'CHECK' when 'f' then 'FOREIGN KEY' else con.contype::text end as constraint_type,
       pg_get_constraintdef(con.oid, true) as definition
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('orders', 'order_items', 'order_rate_events')
order by c.relname, con.contype, con.conname;

-- 3) RLS state and policies; expect row_security=true and zero policies for public/anon/authenticated.
select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
where n.nspname = 'public' and c.relkind = 'r'
  and c.relname in ('orders', 'order_items', 'order_rate_events')
order by c.relname, p.policyname;

-- 4) Functions in public schema and EXECUTE grants. Expected: order RPC executable only by service_role;
-- no other app RPCs exposed to PUBLIC, anon, or authenticated.
select p.oid::regprocedure as function_name,
       r.rolname as grantee,
       a.privilege_type,
       a.is_grantable
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
left join pg_roles r on r.oid = a.grantee
where n.nspname = 'public' and a.privilege_type = 'EXECUTE'
order by function_name::text, grantee nulls first;

-- 5) Required sequence(s), ownership, value state, and grants.
select s.schemaname, s.sequencename, s.start_value, s.min_value, s.max_value,
       s.increment_by, s.cycle, s.cache_size, s.last_value,
       pg_get_userbyid(c.relowner) as owner
from pg_sequences s
join pg_class c on c.relname = s.sequencename
join pg_namespace n on n.oid = c.relnamespace and n.nspname = s.schemaname
where s.schemaname = 'public'
order by s.sequencename;

select c.relname as sequence_name, r.rolname as grantee,
       a.privilege_type, a.is_grantable
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a
left join pg_roles r on r.oid = a.grantee
where n.nspname = 'public' and c.relkind = 'S'
  and c.relname in ('order_id_seq', 'order_items_id_seq', 'order_rate_events_id_seq')
order by c.relname, grantee nulls first, a.privilege_type;

-- 6) Rate limit definition without reading event contents. Inspect function source for configured windows/limits;
-- table columns/indexes confirm hash-only persistence.
select p.oid::regprocedure as function_name, p.prosrc as function_definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'create_order_atomic';

select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'order_rate_events'
order by ordinal_position;

-- 7) Public API exposure inventory for tables/views and functions.
-- Supabase Data API exposure depends on exposed schemas plus grants/RLS; this lists public-schema objects.
select c.relname as object_name,
       case c.relkind when 'r' then 'table' when 'v' then 'view' when 'm' then 'materialized view'
         when 'f' then 'foreign table' else c.relkind::text end as object_type,
       c.relrowsecurity as rls_enabled,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
       has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'f')
order by object_type, object_name;

select p.oid::regprocedure as function_name,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by function_name::text;
