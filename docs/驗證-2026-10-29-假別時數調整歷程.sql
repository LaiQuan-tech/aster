set transaction read only;
-- =====================================================================
-- 假別時數手動調整歷程（docs/套用-2026-10-29-假別時數調整歷程.sql ＝ migration 0081 ＝ sql/0071）。
-- 全部唯讀。套用後跑。
-- （在 SQL editor 裡若 `set transaction read only` 需要交易，整份包 begin; … rollback; 執行。）
-- =====================================================================

-- ── 1. 表與欄位在（預期 11 rows）──────────────────────────────────
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'leave_balance_adjustments'
order by ordinal_position;

-- ── 2. 檢查約束（預期 2 rows：delta_chk、reason_chk）─────────────────
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.leave_balance_adjustments'::regclass and contype = 'c'
order by conname;

-- ── 3. RLS 已開、沒有 policy（預期 relrowsecurity = true、policies = 0）─
select c.relrowsecurity,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'leave_balance_adjustments') as policies
from pg_class c
where c.oid = 'public.leave_balance_adjustments'::regclass;

-- ── 4. 稽核 trigger 在（預期 1 row：audit_all）────────────────────────
select tgname from pg_trigger
where tgrelid = 'public.leave_balance_adjustments'::regclass and not tgisinternal;

-- ── 5. 歷程與餘額桶對得上（套用後有人調整才會有資料；預期 mismatch = 0）──
-- 每個餘額桶「最後一次調整後的 entitled」若之後沒有被 PUT／年度給假改過，應等於目前 entitled。僅供觀察。
select a.balance_id, a.entitled_after, b.entitled as entitled_now, a.created_at
from public.leave_balance_adjustments a
join public.leave_balances b on b.id = a.balance_id
where a.created_at = (select max(created_at) from public.leave_balance_adjustments x where x.balance_id = a.balance_id)
  and a.entitled_after <> b.entitled
limit 20;

-- ── 6. 最近 20 筆調整 ───────────────────────────────────────────────
select created_at, tenant_id, employee_id, leave_type_id, delta_hours, entitled_before, entitled_after, reason, created_by_emp_id
from public.leave_balance_adjustments
order by created_at desc
limit 20;
