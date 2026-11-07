-- Phase 2: add paid_at to public.orders.
--
-- Apply order in Supabase SQL Editor (as project owner):
--   1. supabase/phase1_orders.sql             (fresh project only)
--   2. supabase/phase1_patch.sql
--   3. supabase/phase1_schedule_patch.sql     (superseded, kept for rebuild order)
--   4. supabase/phase1_open_anytime_patch.sql
--   5. supabase/phase2_paid_at_patch.sql      <- this file
--   6. supabase/phase3_admin_patch.sql
--
-- Steps 1-4 are already applied in this project. Run step 5, then step 6.
-- Safe to rerun. No data is rewritten; existing orders keep paid_at NULL.

begin;

alter table public.orders
  add column if not exists paid_at timestamptz;

comment on column public.orders.paid_at is
  'Waktu pembayaran dikonfirmasi admin. NULL = belum dibayar. Dikosongkan lagi saat status kembali ke menunggu pembayaran.';

commit;

-- Read-only verification. Every ok value must be true.
select 'orders.paid_at exists and is nullable' as check_name,
       exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'orders' and column_name = 'paid_at'
           and data_type = 'timestamp with time zone' and is_nullable = 'YES'
       ) as ok;

select 'orders.paid_at has no default (filled only by admin transitions)' as check_name,
       not exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'orders' and column_name = 'paid_at'
           and column_default is not null
       ) as ok;
