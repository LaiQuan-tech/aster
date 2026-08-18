-- 0016 — 補完 0001~0015 未涵蓋的 13 張表的 RLS。
--
-- 背景：這些表原本連 ENABLE ROW LEVEL SECURITY 都沒有，Supabase security
-- advisors 列為 ERROR（rls_disabled_in_public）。因為 public schema 會被
-- PostgREST 曝露、且 anon/authenticated 預設有 SELECT grant，等於任何拿到
-- anon key（公開在前端 bundle）的人都能直接讀取——薪資調整、員工個資、
-- 稅務與健保眷屬、求職者個資全在其中。
--
-- API 走 service_role 會 bypass RLS，故這些 policy 不影響應用程式運作；
-- 它們是 anon key 的兜底防線（與 0001~0015 同一套模型）。
--
-- 分類：
--   GROUP B  本人或 HR 可讀、HR 可寫 —— 有 employee_id 的員工個人資料
--   HR ONLY  僅 HR 可讀寫 —— 求職者個資與非員工所得等營運機密
--   衍生     request_attachments 的可見性跟隨其母單 leave_requests

-- ── GROUP B：本人或 HR 可讀，HR 可寫 ──────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employee_profiles', 'employee_certifications', 'employee_educations',
    'employee_job_history', 'employee_work_history',
    'income_tax_dependents', 'nhi_dependents', 'salary_adjustments'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_self_or_hr_read', t);
    EXECUTE format($f$
      CREATE POLICY %I ON public.%I
        FOR SELECT USING (
          tenant_id = public.current_tenant_id()
          AND (
            employee_id IN (
              SELECT id FROM public.employees
              WHERE user_id = auth.uid() AND tenant_id = public.current_tenant_id()
            )
            OR public.is_hr_admin()
          )
        )$f$, t || '_self_or_hr_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_hr_write', t);
    EXECUTE format($f$
      CREATE POLICY %I ON public.%I
        FOR ALL USING (tenant_id = public.current_tenant_id() AND public.is_hr_admin())
        WITH CHECK (tenant_id = public.current_tenant_id() AND public.is_hr_admin())$f$,
      t || '_hr_write', t);
  END LOOP;
END $$;

-- ── HR ONLY：求職者個資與非員工所得，一般員工不得讀取 ─────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['candidates', 'interviews', 'offers', 'non_employee_income'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_hr_only', t);
    EXECUTE format($f$
      CREATE POLICY %I ON public.%I
        FOR ALL USING (tenant_id = public.current_tenant_id() AND public.is_hr_admin())
        WITH CHECK (tenant_id = public.current_tenant_id() AND public.is_hr_admin())$f$,
      t || '_hr_only', t);
  END LOOP;
END $$;

-- ── request_attachments：可見性跟隨母單 ───────────────────────────────
-- 刻意不複製 leave_requests 的判斷式：policy 內對 leave_requests 的子查詢
-- 本身也會套用該表的 RLS，因此「附件可見 ⟺ 母單可見」會自動成立，母單規則
-- 日後調整時這裡不必同步改。
ALTER TABLE public.request_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ra_follows_request_read ON public.request_attachments;
CREATE POLICY ra_follows_request_read ON public.request_attachments
  FOR SELECT USING (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.leave_requests r
      WHERE r.id = request_attachments.request_id
        AND r.tenant_id = public.current_tenant_id()
    )
  );
DROP POLICY IF EXISTS ra_hr_write ON public.request_attachments;
CREATE POLICY ra_hr_write ON public.request_attachments
  FOR ALL USING (tenant_id = public.current_tenant_id() AND public.is_hr_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.is_hr_admin());

-- ── current_tenant_id()：補上 search_path ─────────────────────────────
-- advisors function_search_path_mutable：未固定 search_path 的函式可能被
-- 呼叫端的 search_path 影響解析對象。
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid LANGUAGE sql STABLE SET search_path = public
AS $$ SELECT NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid $$;

-- ── SECURITY DEFINER 輔助函式：收回 anon 的 EXECUTE ───────────────────
-- advisors anon_security_definer_function_executable：未登入者不需要、也不
-- 應該能直接呼叫這些函式。authenticated 必須保留 —— RLS policy 是以查詢者
-- 的角色求值，收掉會讓所有已登入者的政策直接報錯。
REVOKE EXECUTE ON FUNCTION public.is_hr_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_project_lead(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_project_member(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.manages_project_dept(uuid) FROM anon;
