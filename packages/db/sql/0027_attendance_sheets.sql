-- =====================================================================
-- 0027  attendance_sheets / attendance_sheet_days：RLS + 禁刪與稽核 +
--       updated_at 自動更新 + 合法值防呆（亞斯特 P1 出勤月表）
--
-- 表結構由 drizzle migration 0039 建立。本檔放 drizzle 管不了的四件事，
-- 比照 sql/0023（project_billings 禁刪＋稽核）、sql/0024（API 專用表
-- RLS）、sql/0026（新表 CHECK）的既有做法。
--
-- ── RLS：比照 0024，ENABLE 但不給 policy ──────────────────────────────
-- 前端從不直接讀表，所有讀寫都經 API 的 service_role（bypass RLS）。
--
-- ── 禁刪＋稽核：月表是簽核與薪資計算的依據 ────────────────────────────
-- 已核准／鎖定的月表若被實體刪除，等於讓「這個月結算過什麼」憑空消失，
-- 而 snapshot 一旦丟失就再也重建不回來。比照 sql/0023 project_billings
-- 的做法：no_hard_delete（BEFORE DELETE，test/demo 租戶除外）＋
-- audit_all（INSERT/UPDATE/DELETE 全量留痕，非 punch_records/attendance_days
-- 那種「只增不改」的高量表，故用全量而非僅異動稽核）。
-- 前提：sql/0018 的 forbid_hard_delete() 與 sql/0019 的 audit_row() 已存在。
--
-- ── updated_at 自動更新 trigger：repo 目前沒有既有的 set_updated_at 函式
-- （vendors／advances／project_settings 等表的 updated_at 皆由應用層手動
-- 寫入），本檔新建一個通用版本，供本次與日後的表共用。
--
-- ── 合法值防呆 ────────────────────────────────────────────────────────
-- attendance_sheets.period／status、attendance_sheet_days 的人工覆寫理由。
-- 這批表是全新表、無既有資料要轉換，CHECK 可直接加（同 sql/0026 的理由）。
--
-- 套用方式：Supabase SQL Editor。
-- 冪等：DROP IF EXISTS + CREATE，可重複執行。
-- =====================================================================

-- ── updated_at 通用 trigger（repo 首次引入，供本檔與日後的表共用）──────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  '通用 updated_at 自動更新 trigger：BEFORE UPDATE 時把 updated_at 設為 now()。';

-- ── RLS：比照 0024，ENABLE 但不給 policy ──────────────────────────────
ALTER TABLE public.attendance_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_sheet_days ENABLE ROW LEVEL SECURITY;

-- ── attendance_sheets：禁刪＋稽核＋updated_at ──────────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheets;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.attendance_sheets
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.attendance_sheets;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_sheets
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.attendance_sheets;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.attendance_sheets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── attendance_sheet_days：禁刪＋稽核＋updated_at ──────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheet_days;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.attendance_sheet_days
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.attendance_sheet_days;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_sheet_days
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.attendance_sheet_days;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.attendance_sheet_days
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 合法值防呆 ──────────────────────────────────────────────────────
ALTER TABLE public.attendance_sheets DROP CONSTRAINT IF EXISTS attendance_sheets_period_chk;
ALTER TABLE public.attendance_sheets ADD CONSTRAINT attendance_sheets_period_chk
  CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE public.attendance_sheets DROP CONSTRAINT IF EXISTS attendance_sheets_status_chk;
ALTER TABLE public.attendance_sheets ADD CONSTRAINT attendance_sheets_status_chk
  CHECK (status IN ('draft', 'submitted', 'manager_reviewed', 'approved', 'locked', 'returned'));

-- 人工覆寫加班分鐘數必須有理由：偏離系統試算的數字是談出來的，要留得下痕跡
-- （比照 sql/0023 project_billings_override_chk 的同一套理由）。
ALTER TABLE public.attendance_sheet_days
  DROP CONSTRAINT IF EXISTS attendance_sheet_days_override_chk;
ALTER TABLE public.attendance_sheet_days ADD CONSTRAINT attendance_sheet_days_override_chk
  CHECK (
    overtime_minutes_override IS NULL
    OR (override_reason IS NOT NULL AND length(trim(override_reason)) > 0)
  );

-- ── 還原 ────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS no_hard_delete  ON public.attendance_sheets;
-- DROP TRIGGER IF EXISTS audit_all       ON public.attendance_sheets;
-- DROP TRIGGER IF EXISTS set_updated_at  ON public.attendance_sheets;
-- DROP TRIGGER IF EXISTS no_hard_delete  ON public.attendance_sheet_days;
-- DROP TRIGGER IF EXISTS audit_all       ON public.attendance_sheet_days;
-- DROP TRIGGER IF EXISTS set_updated_at  ON public.attendance_sheet_days;
-- ALTER TABLE public.attendance_sheets DROP CONSTRAINT IF EXISTS attendance_sheets_period_chk;
-- ALTER TABLE public.attendance_sheets DROP CONSTRAINT IF EXISTS attendance_sheets_status_chk;
-- ALTER TABLE public.attendance_sheet_days DROP CONSTRAINT IF EXISTS attendance_sheet_days_override_chk;
-- DROP FUNCTION IF EXISTS public.set_updated_at();
-- （不 DISABLE RLS：一旦開了 anon/authenticated 就該一直被擋住。）
