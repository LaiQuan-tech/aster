-- 2026-11-10 專案申請單「版本」：合約金額（銷售金額未稅）改了 → 申請單變下一版；舊版可調出來看（唯讀、可列印）。
--   project_application_versions：每個專案的申請單版本（version_no 專案內 1、2、3…遞增，unique(project_id, version_no)）。
--     snapshot jsonb ＝申請單當時的完整內容（與 GET /projects/:id/application 的 application 段同形狀：專案欄位、
--     客戶、設計內容、訂單、銷售金額未稅／營業稅／總額、付款方式、付款階段各列、審迄還款、發包各列、其他支出、利潤、毛利率…）。
--     trigger：initial（第一次改合約金額時，把改之前的內容存成第 1 版）／contract_amount_changed（改後的內容）／manual（手動另存）。
--     amount_before／amount_after：合約金額（未稅）改前／改後（manual 只記當時金額於 amount_after）。
--     superseded_at：被下一版取代的時間；取代當下 API 會把這一版的 snapshot 更新成「被取代前的最後內容」
--       （版本在成為舊版之前＝即時資料，其他欄位修改不建新版），之後不再變動。NULL＝目前版。
-- 前提：已套到 0089（sql/0079）。純新增、可重跑（IF NOT EXISTS／duplicate_object）；不動任何既有表或資料。
-- 只由 API（service role）存取：RLS 開、不給 policy；掛 audit_all。版本不提供刪除。
CREATE TABLE IF NOT EXISTS public.project_application_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  version_no integer NOT NULL,
  snapshot jsonb NOT NULL,
  trigger text NOT NULL,
  amount_before numeric,
  amount_after numeric,
  note text,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS project_application_versions_project_no_uq
  ON public.project_application_versions (project_id, version_no);
CREATE INDEX IF NOT EXISTS project_application_versions_tenant_project_idx
  ON public.project_application_versions (tenant_id, project_id);
DO $$ BEGIN
  ALTER TABLE public.project_application_versions ADD CONSTRAINT project_application_versions_trigger_chk
    CHECK (trigger IN ('initial', 'contract_amount_changed', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.project_application_versions ADD CONSTRAINT project_application_versions_no_chk CHECK (version_no >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.project_application_versions ADD CONSTRAINT project_application_versions_note_chk
    CHECK (note IS NULL OR char_length(note) <= 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.project_application_versions ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.project_application_versions;
CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.project_application_versions
  FOR EACH ROW EXECUTE FUNCTION audit_row();
