-- =====================================================================
-- 套用後驗證（docs/套用-2026-10-26-專案分潤毛利與核准.sql ＝ migration 0073 ＝ sql/0063）
--
-- 用 `npm run db:apply -- docs/驗證-2026-10-26-專案分潤毛利與核准.sql` 會把每一條的結果都印出來。
-- 用 SQL Editor 的話**一次貼一條**（它只顯示最後一條的結果）。全部都是唯讀 select。
-- =====================================================================

-- ── 1. 9 個新欄位都在 ────────────────────────────────────────────────
-- 預期 9 rows：approved_amount numeric、approved_at timestamptz、approved_by_emp_id uuid、approved_fingerprint text、
--   return_reason text、returned_at timestamptz、returned_by_emp_id uuid、submitted_at timestamptz、submitted_by_emp_id uuid
select column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'bonus_runs' and column_name in ('submitted_at', 'submitted_by_emp_id', 'approved_at', 'approved_by_emp_id', 'approved_amount', 'approved_fingerprint', 'returned_at', 'returned_by_emp_id', 'return_reason') order by column_name;

-- ── 2. status CHECK 含四態 ────────────────────────────────────────────
-- 預期 1 row，定義含 'draft', 'pending_approval', 'approved', 'paid'
select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.bonus_runs'::regclass and conname = 'bonus_runs_status_chk';

-- ── 3. 送審／核准一致性 CHECK ─────────────────────────────────────────
-- 預期 2 rows：bonus_runs_approved_chk、bonus_runs_submitted_chk
select conname from pg_constraint where conrelid = 'public.bonus_runs'::regclass and conname in ('bonus_runs_submitted_chk', 'bonus_runs_approved_chk') order by conname;

-- ── 4. 既有批次狀態不受影響 ───────────────────────────────────────────
-- 預期：只有 draft／paid（套用當下還沒有人送審）
select status, count(*) from public.bonus_runs where deleted_at is null group by status order by status;

-- ── 5. paid 凍結 trigger 仍在 ─────────────────────────────────────────
-- 預期 2 rows：bonus_runs、bonus_run_items 各一條 forbid_paid_bonus_mutation
select event_object_table, trigger_name from information_schema.triggers where trigger_name = 'forbid_paid_bonus_mutation' group by event_object_table, trigger_name order by event_object_table;
