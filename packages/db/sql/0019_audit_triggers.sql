-- =====================================================================
-- 0019  稽核軌跡 audit triggers
--
-- 專案硬約束：「經手金額的表一律掛 audit trigger」。
-- 本檔是帳本「移植五個缺口」第 1 項（audit_logs）的 DB 層；
-- 表結構由 drizzle migration 0028 建立，本檔只掛 trigger。
--
-- 為何 trigger 而非只靠應用層：
--   API 全程使用 service_role key，BYPASS RLS。應用層的
--   services/audit.ts 可被繞過（漏呼叫、直接對 DB 下 SQL）；
--   trigger 不會。兩者互補：
--     • trigger  → 保證「什麼被改了」不會漏，但不知道應用層的操作者是誰
--       （PostgREST 的 request.jwt.claims 在 service_role 下只有服務身分，
--        沒有使用者），故 actor_emp_id 為 null、只記 db_user。
--     • 應用層   → 補上 actor_emp_id 與 context，但可被繞過。
--   查核時以 (table_name, record_id) 把兩邊的列拼起來看。
--
-- 兩種掛法：
--   A. 全量稽核（INSERT/UPDATE/DELETE）—— 經手金額的表與低量證據表。
--   B. 僅異動稽核（UPDATE/DELETE）—— punch_records / attendance_days
--      這類「只增不改」的高量表。每天每人數筆打卡，稽核 INSERT 只是把寫入
--      量翻倍而毫無資訊（打卡列本身就是那筆紀錄）；**竄改才是要抓的**，
--      而竄改一定是 UPDATE 或 DELETE。
--
-- audit_logs 自身為 append-only：UPDATE 與 DELETE 皆被擋下
-- （可改可刪的稽核軌跡等於沒有）。例外同 0018，僅 test/demo 租戶放行，
-- 否則整合測試會在共用 Supabase 上無限累積列。
--
-- 相依：0018（提供 public.is_disposable_tenant）。請先套用 0018。
-- 套用方式：經 Supabase Management API query 端點（同 0001~0018）。
-- 冪等：DROP TRIGGER IF EXISTS 後重建，可重複執行。
-- 可逆：見檔末。
-- =====================================================================

CREATE OR REPLACE FUNCTION public.audit_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_any jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
  ELSE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
  END IF;

  v_any := coalesce(v_new, v_old);

  INSERT INTO public.audit_logs
    (tenant_id, table_name, record_id, action, old_row, new_row, db_user)
  VALUES (
    nullif(v_any ->> 'tenant_id', '')::uuid,
    TG_TABLE_NAME,
    nullif(v_any ->> 'id', '')::uuid,
    TG_OP,
    v_old,
    v_new,
    current_user
  );

  RETURN NULL; -- AFTER trigger，回傳值不被使用
END;
$$;

COMMENT ON FUNCTION public.audit_row() IS
  '把一列的 INSERT/UPDATE/DELETE 寫進 audit_logs（整列 jsonb）。actor_emp_id 由應用層補。';

-- ── A. 全量稽核：經手金額的表 + 低量證據表 ──────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- 經手金額（硬約束明列）
    'payslips',
    'salary_structures',
    'salary_adjustments',
    'leave_balances',
    'comp_time_ledger',
    'non_employee_income',
    'rule_configs',              -- 薪資規則決定算出來的錢，等同經手金額
    'projects',                  -- bonus_pool
    'project_members',           -- share_pct / share_amount
    'project_share_adjustments',
    -- 報銷（模組三）—— nature 欄位決定課稅與投保歸屬，改動必須留痕
    'expense_categories',
    'expense_claims',
    'expense_settlements',
    'trip_advances',             -- 出差預支：現金撥款與沖抵，必須留痕
    -- 證據（模組二）
    'leave_requests',
    'approval_steps',
    'announcements',
    'announcement_versions',
    'announcement_signature_sheets',
    'announcement_acknowledgements'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- ── B. 僅異動稽核：高量、只增不改的表（見檔頭說明）──────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'punch_records',
    'attendance_days'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_mutations ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_mutations AFTER UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- ── audit_logs 自身：append-only ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.forbid_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 同 0018：僅 test/demo 租戶放行，供整合測試清理。
  IF public.is_disposable_tenant(OLD.tenant_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'audit_logs 為 append-only，不可 % （可改可刪的稽核軌跡等於沒有）。', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.forbid_audit_mutation();

-- ── 還原 ────────────────────────────────────────────────────────────
-- DO $$ DECLARE t text; BEGIN
--   FOREACH t IN ARRAY ARRAY['payslips','salary_structures','salary_adjustments',
--     'leave_balances','comp_time_ledger','non_employee_income','rule_configs',
--     'projects','project_members','project_share_adjustments',
--     'expense_categories','expense_claims','expense_settlements','trip_advances','leave_requests',
--     'approval_steps','announcements','announcement_versions',
--     'announcement_signature_sheets','announcement_acknowledgements']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t); END LOOP;
--   FOREACH t IN ARRAY ARRAY['punch_records','attendance_days']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS audit_mutations ON public.%I', t); END LOOP;
-- END $$;
-- DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
-- DROP FUNCTION IF EXISTS public.forbid_audit_mutation();
-- DROP FUNCTION IF EXISTS public.audit_row();
