-- =====================================================================
-- 0063  獎金批次核准（配合 migration 0073：bonus_runs 送審／核准／退回欄位）
--
-- 狀態機（應用層 services/bonus-run-store.ts；這裡只放 DB 防呆）：
--   draft ──送審(HR)──▶ pending_approval ──核准(老闆)──▶ approved ──發放(HR)──▶ paid
--                        │ 退回(老闆，需原因) ▼              │ 重算後金額改變 ▼
--                        └──────────────▶ draft ◀───────────┘
--   paid 仍由 sql/0034 forbid_paid_bonus_mutation 凍結；approved／pending_approval 不凍結
--   （入帳／成本變動時系統要能重算，金額變了就退回 draft）。
--   2026-10-26 前已發放的批次沒有核准欄位，CHECK 不回頭要求（paid 不檢查 approved_at）。
-- 前提：sql/0034、0036 與 migration 0073 已套用。冪等，可重複執行；整段包在 BEGIN／COMMIT，一錯全回滾。
-- =====================================================================

BEGIN;

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
-- 先把 pending_approval／approved 的批次改回 draft，再：
-- ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_approved_chk;
-- ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_submitted_chk;
-- ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_status_chk;
-- ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_status_chk CHECK (status IN ('draft', 'paid'));
