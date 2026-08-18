-- 0017 — 修正 leave_requests ↔ approval_steps 的 RLS policy 無限遞迴。
--
-- 症狀：以 anon/authenticated 讀這兩張表（及參照它們的 request_attachments）
-- 一律回 42P17 infinite recursion，RLS 形同失效（fail-closed，不外洩但也不可用）。
--
-- 成因：0004 裡兩條 policy 互相參照對方的表 ——
--   lr_read 用 EXISTS(approval_steps ...) 判斷「我是不是簽核者」
--   as_read 用 EXISTS(leave_requests ...) 判斷「這關卡屬不屬於我的單」
-- policy 內對他表的子查詢會再套用該表的 RLS，於是 A→B→A 無限循環。
--
-- 解法：把這兩個跨表判斷各自收進 SECURITY DEFINER 函式。SECURITY DEFINER
-- 以函式擁有者（postgres，BYPASSRLS）執行，不會再觸發對方的 policy，循環即斷。
-- 這與 0001 用 is_hr_admin() 迴避 employees 遞迴是同一個手法。

-- 呼叫者是否為該單的簽核者之一
CREATE OR REPLACE FUNCTION public.is_request_approver(p_request_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.approval_steps s
    JOIN public.employees e ON e.id = s.approver_emp_id
    WHERE s.request_id = p_request_id
      AND e.user_id = auth.uid()
      AND e.tenant_id = public.current_tenant_id()
  );
$$;

-- 呼叫者是否為該單的申請人
CREATE OR REPLACE FUNCTION public.owns_request(p_request_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.leave_requests r
    JOIN public.employees e ON e.id = r.employee_id
    WHERE r.id = p_request_id
      AND e.user_id = auth.uid()
      AND e.tenant_id = public.current_tenant_id()
  );
$$;

REVOKE ALL ON FUNCTION public.is_request_approver(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owns_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_request_approver(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.owns_request(uuid) TO authenticated, service_role;

-- 申請單：本人 or HR or 該單簽核者
DROP POLICY IF EXISTS lr_read ON public.leave_requests;
CREATE POLICY lr_read ON public.leave_requests
  FOR SELECT USING (
    tenant_id = public.current_tenant_id()
    AND (
      employee_id IN (
        SELECT id FROM public.employees
        WHERE user_id = auth.uid() AND tenant_id = public.current_tenant_id()
      )
      OR public.is_hr_admin()
      OR public.is_request_approver(leave_requests.id)
    )
  );

-- 簽核關卡：HR or 我是這關的簽核者 or 這單是我送的
DROP POLICY IF EXISTS as_read ON public.approval_steps;
CREATE POLICY as_read ON public.approval_steps
  FOR SELECT USING (
    tenant_id = public.current_tenant_id()
    AND (
      public.is_hr_admin()
      OR approver_emp_id IN (
        SELECT id FROM public.employees
        WHERE user_id = auth.uid() AND tenant_id = public.current_tenant_id()
      )
      OR public.owns_request(approval_steps.request_id)
    )
  );
