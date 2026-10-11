-- 2026-10-11 收緊 RLS 寫入：資料寫入一律經 API（service role，不受 RLS 影響），網頁從不直連資料表。
-- 修補（已在正式庫以模擬 JWT 實測確認、交易回滾不留資料）：
--   • 一般員工可用自己的 JWT 經 PostgREST 直接寫入任意時間的打卡、以及 status='approved' 的假單；
--   • 非 HR 的專案負責人／部門主管可直接改專案欄位（獎金池等）、成員分潤與分潤歷程，
--     繞過 API 的驗證、簽核與分潤歷程 RPC。
-- 讀取 policy 不動；HR 管理員寫入保留。前提：已套到 0058（sql/0048）。可重跑。
DROP POLICY IF EXISTS lr_self_insert ON public.leave_requests;
DROP POLICY IF EXISTS punch_self_insert ON public.punch_records;

DROP POLICY IF EXISTS projects_hr_or_lead_write ON public.projects;
DROP POLICY IF EXISTS projects_hr_write ON public.projects;
CREATE POLICY projects_hr_write ON public.projects FOR ALL
  USING ((tenant_id = current_tenant_id()) AND is_hr_admin())
  WITH CHECK ((tenant_id = current_tenant_id()) AND is_hr_admin());

DROP POLICY IF EXISTS project_members_manage_write ON public.project_members;
DROP POLICY IF EXISTS project_members_hr_write ON public.project_members;
CREATE POLICY project_members_hr_write ON public.project_members FOR ALL
  USING ((tenant_id = current_tenant_id()) AND is_hr_admin())
  WITH CHECK ((tenant_id = current_tenant_id()) AND is_hr_admin());

DROP POLICY IF EXISTS project_share_adj_manage_write ON public.project_share_adjustments;
DROP POLICY IF EXISTS project_share_adj_hr_write ON public.project_share_adjustments;
CREATE POLICY project_share_adj_hr_write ON public.project_share_adjustments FOR ALL
  USING ((tenant_id = current_tenant_id()) AND is_hr_admin())
  WITH CHECK ((tenant_id = current_tenant_id()) AND is_hr_admin());

DROP POLICY IF EXISTS project_documents_write ON public.project_documents;
DROP POLICY IF EXISTS project_documents_hr_write ON public.project_documents;
CREATE POLICY project_documents_hr_write ON public.project_documents FOR ALL
  USING ((tenant_id = current_tenant_id()) AND is_hr_admin())
  WITH CHECK ((tenant_id = current_tenant_id()) AND is_hr_admin());
