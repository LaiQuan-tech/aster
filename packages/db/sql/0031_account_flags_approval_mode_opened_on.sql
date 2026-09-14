-- =====================================================================
-- 0031  帳號旗標／簽核模式／開案日期
--       （A 批次：帳號邀請、假單直屬主管簽核、開案日期三個 WP 的資料層前置）
--
-- 表結構由 drizzle migration 0042 建立（employees.must_change_password、
-- employees_user_id_uq partial unique index、approval_flows.mode、
-- approval_steps.acted_by_emp_id＋FK、projects.opened_on）。本檔放
-- drizzle 管不了的三件事：
--   [1] approval_flows.mode 的合法值 CHECK（比照 sql/0028 的既有做法）。
--   [2] employees 掛 audit_all 稽核 trigger（比照 sql/0019 的掛法；帳號
--       旗標與登入綁定屬敏感異動，值得留痕）。
--   [3] projects.opened_on 對既有列 backfill 成 created_at 的台北時區當天
--       （新建案改由 API 視流程另填；此欄位可空，backfill 只是替舊資料
--       補一個合理預設值，不影響之後再人工覆寫）。
--
-- 前提：sql/0019 的 audit_row() 已存在；migration 0042 已套用（各表新欄位
-- 已存在）。
-- 套用方式：Supabase SQL Editor。
-- 冪等：CHECK 一律先 DROP CONSTRAINT IF EXISTS 再 ADD CONSTRAINT，trigger
-- 一律先 DROP TRIGGER IF EXISTS 再 CREATE，backfill 用 WHERE opened_on IS
-- NULL 收斂，重跑不影響已有值的列。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] approval_flows.mode 合法值防呆
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.approval_flows DROP CONSTRAINT IF EXISTS approval_flows_mode_chk;
ALTER TABLE public.approval_flows ADD CONSTRAINT approval_flows_mode_chk
  CHECK (mode IN ('manager', 'list'));

-- ─────────────────────────────────────────────────────────────────
-- [2] employees：帳號旗標與登入綁定屬敏感異動，掛稽核
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_all ON public.employees;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────
-- [3] projects.opened_on：既有列 backfill（新案由 API 另填，不覆蓋已填值）
-- ─────────────────────────────────────────────────────────────────
UPDATE public.projects
   SET opened_on = (created_at AT TIME ZONE 'Asia/Taipei')::date
 WHERE opened_on IS NULL;

-- ── 還原 ────────────────────────────────────────────────────────────
-- （opened_on 的 backfill 不可逆——還原欄位本身即可，見 migration 0042 對應
--  的 DROP COLUMN；此處只列 sql/0031 新增的物件。）
-- DROP TRIGGER IF EXISTS audit_all ON public.employees;
-- ALTER TABLE public.approval_flows DROP CONSTRAINT IF EXISTS approval_flows_mode_chk;
