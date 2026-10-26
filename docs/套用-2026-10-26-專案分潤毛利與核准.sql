-- =====================================================================
-- 2026-10-26 專案分潤改版——獎金批次核准（migration 0073 ＝ sql/0063）
--
-- 前提：已套到 0072（sql/0062，docs/套用-2026-10-25-員工所屬公司.sql）。整份可重跑（冪等），包在 BEGIN／COMMIT 交易裡（一錯全回滾）。
-- 套用後跑 docs/驗證-2026-10-26-專案分潤毛利與核准.sql。
-- 順序：**先套本檔、再部署 API 與網頁**。API 會探測欄位（lib/schema-compat bonusRunsHaveApproval）：
--   沒套時批次列表／明細照常可讀，但送審／核准／退回／發放一律回 409 schema_not_ready
--   （發放改成只收「已核准」，沒有核准欄位就無從核准）。
-- 獎金池改毛利制、封存專案納入規則、入帳超過合約警示都是應用層計算，**不需要** DB 變更。
-- =====================================================================

BEGIN;

-- ── 1. 欄位（＝ migration 0073）──────────────────────────────────────
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

-- ── 2. 合法值與一致性 CHECK（＝ sql/0063）──────────────────────────────
ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_status_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_status_chk
  CHECK (status IN ('draft', 'pending_approval', 'approved', 'paid'));

-- 送審中／已核准一定有送審時間；已核准一定有核准時間與金額指紋。
ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_submitted_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_submitted_chk
  CHECK (status NOT IN ('pending_approval', 'approved') OR submitted_at IS NOT NULL);

ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_approved_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_approved_chk
  CHECK (status <> 'approved' OR (approved_at IS NOT NULL AND approved_fingerprint IS NOT NULL));

COMMIT;

-- ── 還原 ────────────────────────────────────────────────────────────
-- 先部署回不讀這些欄位的 API，並把 pending_approval／approved 的批次改回 draft：
--   UPDATE public.bonus_runs SET status = 'draft' WHERE status IN ('pending_approval', 'approved');
-- ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_approved_chk;
-- ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_submitted_chk;
-- ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_status_chk;
-- ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_status_chk CHECK (status IN ('draft', 'paid'));
-- ALTER TABLE public.bonus_runs DROP COLUMN IF EXISTS submitted_at, DROP COLUMN IF EXISTS submitted_by_emp_id,
--   DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS approved_by_emp_id, DROP COLUMN IF EXISTS approved_amount,
--   DROP COLUMN IF EXISTS approved_fingerprint, DROP COLUMN IF EXISTS returned_at, DROP COLUMN IF EXISTS returned_by_emp_id,
--   DROP COLUMN IF EXISTS return_reason;
