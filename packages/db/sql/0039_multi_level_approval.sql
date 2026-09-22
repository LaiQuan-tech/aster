-- =====================================================================
-- 0039  多級簽核（小主管 → 大主管 → HR 覆核）＋ 部門多位主管
--
-- 表結構由 drizzle migration 0049 建立（departments.manager_emp_ids uuid[]
-- NOT NULL DEFAULT '{}'、approval_steps.candidate_emp_ids uuid[]、
-- approval_steps.step_kind text）。本檔放 drizzle 管不了的四件事：
--   [1] approval_flows.mode 的合法值 CHECK 改含 'manager_hr'
--       （比照 sql/0031 [1]；'manager_hr'＝主管逐級簽核 → 任一 HR 覆核）。
--   [2] departments.manager_emp_ids 對既有列 backfill：manager_emp_id 非 null
--       且陣列仍是空的 → ARRAY[manager_emp_id]（只補空的，重跑不覆蓋已編排
--       多位主管的列）。之後 API 寫入時兩欄同步（manager_emp_id＝陣列第 1 位）。
--   [3] RLS helper manages_project_dept()（sql/0015）改寫：呼叫者在部門的
--       manager_emp_ids 內（任一順位）也算該部門主管，與 manager_emp_id 並列。
--       函式簽名不變，policy 不用重掛；ACL 照 sql/0015 第 91–95 行重申一次
--       （CREATE OR REPLACE 不會動 ACL，重申只是防呆；不另外 REVOKE anon，理由見 [3]）。
--   [4] 三個新欄位的 COMMENT（語意寫在 DB 裡，dashboard 看得到）。
--
-- 前提：migration 0049 已套用（三個新欄位已存在）；sql/0015 的
-- manages_project_dept() 與 current_tenant_id() 已存在。
-- 套用方式：Supabase SQL Editor（或 docs/套用-2026-09-22-多級簽核.sql 合併檔）。
-- 冪等：CHECK 先 DROP CONSTRAINT IF EXISTS 再 ADD；backfill 用
-- cardinality(manager_emp_ids) = 0 收斂；函式 CREATE OR REPLACE；COMMENT 可重設。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] approval_flows.mode 合法值：manager / list / manager_hr
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.approval_flows DROP CONSTRAINT IF EXISTS approval_flows_mode_chk;
ALTER TABLE public.approval_flows ADD CONSTRAINT approval_flows_mode_chk
  CHECK (mode IN ('manager', 'list', 'manager_hr'));

-- ─────────────────────────────────────────────────────────────────
-- [2] departments.manager_emp_ids backfill（只補空陣列的列）
-- ─────────────────────────────────────────────────────────────────
UPDATE public.departments
   SET manager_emp_ids = ARRAY[manager_emp_id]
 WHERE manager_emp_id IS NOT NULL
   AND cardinality(manager_emp_ids) = 0;

-- ─────────────────────────────────────────────────────────────────
-- [3] manages_project_dept()：manager_emp_ids 內任一順位也算主管
-- ─────────────────────────────────────────────────────────────────
-- 呼叫者是否為某專案所屬部門的主管（含子部門，遞迴 parent_id）。
-- 主管＝departments.manager_emp_id 指向呼叫者的 employee id，
-- 或呼叫者的 employee id 在 departments.manager_emp_ids（有序多主管）內。
CREATE OR REPLACE FUNCTION public.manages_project_dept(p_project_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  WITH RECURSIVE me AS (
    SELECT id FROM public.employees
    WHERE user_id = auth.uid() AND tenant_id = public.current_tenant_id()
  ), managed AS (
    SELECT d.id
    FROM public.departments d
    WHERE d.tenant_id = public.current_tenant_id()
      AND (
        d.manager_emp_id IN (SELECT id FROM me)
        OR d.manager_emp_ids && ARRAY(SELECT id FROM me)
      )
    UNION
    SELECT c.id
    FROM public.departments c
    JOIN managed m ON c.parent_id = m.id
    WHERE c.tenant_id = public.current_tenant_id()
  )
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND p.tenant_id = public.current_tenant_id()
      AND p.dept_id IS NOT NULL
      AND p.dept_id IN (SELECT id FROM managed)
  );
$$;

-- ACL 與 sql/0015 第 91–95 行完全一致（REVOKE PUBLIC；GRANT anon／authenticated／service_role）。
-- 不另外 REVOKE anon：RLS policy 以查詢者角色求值，若 anon 角色求值時函式沒有 EXECUTE，
-- policy 會直接報 permission denied 而不是回 false。
REVOKE ALL ON FUNCTION public.manages_project_dept(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manages_project_dept(uuid) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────
-- [4] 欄位說明
-- ─────────────────────────────────────────────────────────────────
COMMENT ON COLUMN public.departments.manager_emp_ids IS
  '有序主管清單：[1]＝小主管（簽核第一關），之後依序往上（大主管…）。manager_emp_id 保留＝本欄第 1 位，API 寫入時同步。';
COMMENT ON COLUMN public.approval_steps.candidate_emp_ids IS
  '同一關的候選簽核人（任一人簽即過，如 HR 覆核關＝全部在職 hr_admin）。null／空＝只有 approver_emp_id 一人。有人簽後 approver_emp_id 改寫成實際簽的人。';
COMMENT ON COLUMN public.approval_steps.step_kind IS
  '關卡來源：manager 主管關／hr HR 覆核關／list 固定名單／fallback 老闆／hr_admin 第一位 HR 退路。舊列為 null。';

-- ── 還原 ────────────────────────────────────────────────────────────
-- （backfill 不可逆但無害——還原欄位本身即可：
--  ALTER TABLE public.departments DROP COLUMN IF EXISTS manager_emp_ids;
--  ALTER TABLE public.approval_steps DROP COLUMN IF EXISTS candidate_emp_ids;
--  ALTER TABLE public.approval_steps DROP COLUMN IF EXISTS step_kind;
--  此處只列 sql/0039 自己改的物件。）
-- ALTER TABLE public.approval_flows DROP CONSTRAINT IF EXISTS approval_flows_mode_chk;
-- ALTER TABLE public.approval_flows ADD CONSTRAINT approval_flows_mode_chk CHECK (mode IN ('manager', 'list'));
-- manages_project_dept()：重跑 sql/0015 第 66–91 行的版本即可還原。
