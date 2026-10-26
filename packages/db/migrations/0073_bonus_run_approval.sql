-- 2026-10-26 專案分潤改版 #7：獎金批次加入核准（草稿 →（HR）送審 →（老闆）核准 → 發放）。
--   status 新增兩態 'pending_approval'（送審中）／'approved'（已核准）；合法值 CHECK 在 sql/0063。
--   老闆＝tenants.features.approval.fallbackApproverEmpId（應用層判斷，DB 不存核准人名單）。
--   approved_fingerprint：送審時記下「每列金額」的指紋（應用層算），核准沿用。送審／核准後重算／資料變動使金額改變
--   → 應用層把批次退回 draft 並清掉核准欄位、寫 returned_*（return_reason 記原因），需重新送審。
--   *_emp_id 只留痕、不設 FK（同 disbursements.submitted_by_emp_id）。
-- 寫入一律經 API（service role）；不加 policy。audit_all trigger 整列 to_jsonb，新欄位自動入稽核。
-- 前提：已套到 0072（sql/0062）。可重跑（ADD COLUMN IF NOT EXISTS）。
ALTER TABLE public.bonus_runs
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_by_emp_id uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by_emp_id uuid,
  ADD COLUMN IF NOT EXISTS approved_amount numeric(14, 2),
  ADD COLUMN IF NOT EXISTS approved_fingerprint text,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_by_emp_id uuid,
  ADD COLUMN IF NOT EXISTS return_reason text;
COMMENT ON COLUMN public.bonus_runs.submitted_at IS '最近一次送審時間（draft → pending_approval）';
COMMENT ON COLUMN public.bonus_runs.approved_fingerprint IS '送審／核准當下每列金額的指紋；重算後不同 → 退回草稿需重新送審（2026-10-26）';
COMMENT ON COLUMN public.bonus_runs.return_reason IS '最近一次退回草稿的原因（老闆退回需填；金額變動自動退回由系統填）';
