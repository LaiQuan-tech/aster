-- =====================================================================
-- 亞斯特 — 2026-09-22 多級簽核（小主管 → 大主管 → HR 覆核）＋ 部門多位主管
-- 增量 SQL（合併檔：migration 0049 ＋ sql/0039）
--
-- 前提：正式庫已套到 migration 0048 + sql/0038（即 2026-09-22 上午
-- 「管理員設定員工密碼」套用後的狀態）。不相依任何其他待套增量。
-- 內容：
--   [0]  migration 0049 —— 三個新欄位：
--        departments.manager_emp_ids uuid[] NOT NULL DEFAULT '{}'（有序主管清單）
--        approval_steps.candidate_emp_ids uuid[]（同一關的候選簽核人）
--        approval_steps.step_kind text（關卡來源，列表顯示「HR 覆核：」用）
--   [1]  sql/0039 —— approval_flows.mode CHECK 改含 'manager_hr'
--   [2]  sql/0039 —— departments.manager_emp_ids backfill（ARRAY[manager_emp_id]）
--   [3]  sql/0039 —— RLS helper manages_project_dept() 也看 manager_emp_ids
--   [4]  sql/0039 —— 三個新欄位的 COMMENT
--
-- 為什麼要：業主 2026-09-22 需求——補打卡改「小主管簽 → 大主管簽 → HR 覆核」
-- 多關，部門主管要能設定多位（有層級）。API 端 services/approval-chain.ts 依
-- manager_emp_ids 順序逐關建 approval_steps，HR 關把全部在職 hr_admin 放進
-- candidate_emp_ids（任一人簽即過）。
--
-- 順序：先套本檔（DB），再部署 API／web。API 有欄位探測（lib/schema-compat.ts
-- columnsExist），先部署也不會 500，只是多主管／候選人不會落庫、mode=manager_hr
-- 會被 CHECK 擋（回 409 mode_not_supported）——套完本檔 60 秒內自動切到新行為。
--
-- 冪等，可重複執行：ADD COLUMN IF NOT EXISTS；CHECK 先 DROP IF EXISTS 再 ADD；
-- backfill 只補空陣列；函式 CREATE OR REPLACE；COMMENT 可重設。
-- 已用 `npm run db:replay -- --base-migration 48 --base-sql 38
--   --seed docs/test/replay-seed-multi-approval.sql docs/套用-2026-09-22-多級簽核.sql
--   --verify docs/驗證-2026-09-22-多級簽核.sql --compare-raw` 在 pglite 上重放兩次
-- （冪等）、驗 backfill、並與 raw 檔（migrations + sql/）比對 schema 一致。
--
-- 套用方式：Supabase SQL Editor 整段貼上即可（一個交易；任何一條失敗整檔回滾）。
-- 驗證見 docs/驗證-2026-09-22-多級簽核.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [0] migration 0049 — 三個新欄位
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "approval_steps" ADD COLUMN IF NOT EXISTS "candidate_emp_ids" uuid[];
ALTER TABLE "approval_steps" ADD COLUMN IF NOT EXISTS "step_kind" text;
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "manager_emp_ids" uuid[] DEFAULT '{}' NOT NULL;

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
