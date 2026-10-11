-- 2026-10-11 合約掃描檔的資料列（檔名、路徑）只給 HR 與該案經理／主辦看；一般專案文件維持租戶內可讀。
-- 對應 API 的 canSeeContractDocs（apps/api/src/services/project-scope.ts）；is_project_lead() 涵蓋
-- projects.lead_emp_id 與成員角色 lead／manager。已在正式庫以模擬 JWT 驗證（交易回滾）。
-- 前提：已套到 0062（sql/0052）。可重跑。
DROP POLICY IF EXISTS project_documents_tenant_read ON public.project_documents;
DROP POLICY IF EXISTS project_documents_scoped_read ON public.project_documents;
CREATE POLICY project_documents_scoped_read ON public.project_documents FOR SELECT
  USING (
    tenant_id = current_tenant_id()
    AND (contract_id IS NULL OR is_hr_admin() OR is_project_lead(project_id))
  );
