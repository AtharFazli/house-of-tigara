-- WARNING: SUPERSEDED by phase1_open_anytime_patch.sql. Do not run this file again on a
-- database that already applied phase1_open_anytime_patch.sql: it would re-add the dropped
-- schedule columns and recreate the weekly preorder-window trigger.
-- Weekly preorder/pickup schedule agreed by the owner.
-- Run this entire script once in Supabase SQL Editor as project owner; safe to rerun.
-- Schedule: preorder Thu 00:00 through Fri 23:59:59.999999 WIB; pickup Mon 07:00-11:00 WIB.

begin;

alter table public.order_settings
  add column if not exists po_open_day smallint not null default 4,
  add column if not exists po_open_time time not null default time '00:00:00',
  add column if not exists po_close_day smallint not null default 5,
  add column if not exists po_close_time time not null default time '23:59:59.999999',
  add column if not exists pickup_day smallint not null default 1,
  add column if not exists pickup_open_time time not null default time '07:00:00',
  add column if not exists pickup_close_time time not null default time '11:00:00';

-- Apply agreed schedule to singleton even if row existed before this patch.
insert into public.order_settings (
  singleton, po_deadline, po_open_day, po_open_time, po_close_day, po_close_time,
  pickup_day, pickup_open_time, pickup_close_time
) values (
  true, null, 4, time '00:00:00', 5, time '23:59:59.999999',
  1, time '07:00:00', time '11:00:00'
)
on conflict (singleton) do update set
  po_open_day = excluded.po_open_day,
  po_open_time = excluded.po_open_time,
  po_close_day = excluded.po_close_day,
  po_close_time = excluded.po_close_time,
  pickup_day = excluded.pickup_day,
  pickup_open_time = excluded.pickup_open_time,
  pickup_close_time = excluded.pickup_close_time;

-- Keep runtime enforcement in database so RPC cannot bypass the PO window.
create or replace function public.enforce_preorder_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.order_settings%rowtype;
  v_local timestamp;
  v_day integer;
  v_time time;
  v_is_open boolean;
begin
  if new.source <> 'preorder' then
    return new;
  end if;

  select s.* into v_settings
  from public.order_settings s
  where s.singleton = true;

  -- Missing singleton config intentionally leaves preorder open rather than blocking sales.
  if not found then
    return new;
  end if;

  v_local := timezone('Asia/Jakarta', pg_catalog.now());
  v_day := extract(isodow from v_local)::integer;
  v_time := v_local::time;

  if v_settings.po_open_day <= v_settings.po_close_day then
    v_is_open :=
      (v_day = v_settings.po_open_day and v_time >= v_settings.po_open_time)
      or (v_day = v_settings.po_close_day and v_time <= v_settings.po_close_time)
      or (v_day > v_settings.po_open_day and v_day < v_settings.po_close_day);
  else
    v_is_open :=
      (v_day = v_settings.po_open_day and v_time >= v_settings.po_open_time)
      or (v_day = v_settings.po_close_day and v_time <= v_settings.po_close_time)
      or v_day > v_settings.po_open_day or v_day < v_settings.po_close_day;
  end if;

  if v_settings.po_deadline is not null and pg_catalog.now() >= v_settings.po_deadline then
    v_is_open := false;
  end if;

  if not v_is_open then
    raise exception using errcode = 'P0001', message = 'Periode pre-order sedang ditutup.';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_preorder_window() from public, anon, authenticated;
grant execute on function public.enforce_preorder_window() to service_role;
drop trigger if exists orders_enforce_preorder_window on public.orders;
create trigger orders_enforce_preorder_window
before insert on public.orders
for each row execute function public.enforce_preorder_window();

commit;

-- Read-only confirmation of configured schedule; use after the patch.
select po_open_day, po_open_time, po_close_day, po_close_time,
       pickup_day, pickup_open_time, pickup_close_time, po_deadline
from public.order_settings where singleton = true;
