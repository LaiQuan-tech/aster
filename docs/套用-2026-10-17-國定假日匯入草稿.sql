-- =====================================================================
-- 2026-10-17 國定假日年度匯入草稿（migration 0071 ＝ sql/0061）
--
-- 前提：已套到 0070（sql/0060，晚餐勾選）。本檔不依賴 0070 的物件；0070 尚未套用時也可先套本檔，但正式庫順序請維持 0070 → 0071。
-- 整份可重跑（冪等）：CREATE TABLE／INDEX IF NOT EXISTS、CHECK 以 duplicate_object 略過、trigger 先 DROP 再建。
-- 套用後跑 docs/驗證-2026-10-17-國定假日匯入草稿.sql。
-- 順序：先套本檔、再部署 API／worker（舊 API 不認得這張表，不影響；新 API 在表未建時 /calendar/import/* 回 503、
-- 排程端點回 200 skipped，不會壞）。
-- 不動任何既有資料：草稿要 HR 在後台核准後才會寫入 tenant_calendar_days。
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.calendar_import_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  year integer NOT NULL,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  diff jsonb,
  status text NOT NULL DEFAULT 'draft',
  created_by_emp_id uuid,
  approved_by_emp_id uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_import_drafts_tenant_year_idx ON public.calendar_import_drafts (tenant_id, year, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_import_drafts_one_draft_uq
  ON public.calendar_import_drafts (tenant_id, year) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS calendar_import_drafts_one_approved_uq
  ON public.calendar_import_drafts (tenant_id, year) WHERE status = 'approved';
DO $$ BEGIN
  ALTER TABLE public.calendar_import_drafts ADD CONSTRAINT calendar_import_drafts_status_chk
    CHECK (status IN ('draft', 'approved', 'superseded'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.calendar_import_drafts ADD CONSTRAINT calendar_import_drafts_source_chk
    CHECK (source IN ('dgpa', 'ntpc'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.calendar_import_drafts ADD CONSTRAINT calendar_import_drafts_year_chk
    CHECK (year BETWEEN 2000 AND 2100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.calendar_import_drafts ADD CONSTRAINT calendar_import_drafts_approved_chk
    CHECK (status <> 'approved' OR approved_at IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- API 走 service role；RLS 開啟不給 policy＝前端直連一律擋。
ALTER TABLE public.calendar_import_drafts ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.calendar_import_drafts;
CREATE TRIGGER audit_all AFTER INSERT OR DELETE OR UPDATE ON public.calendar_import_drafts
  FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ── 還原 ────────────────────────────────────────────────────────────
-- 草稿只是暫存＋核准紀錄，刪表不影響已寫入的行事曆（tenant_calendar_days）：
-- DROP TABLE IF EXISTS public.calendar_import_drafts;
