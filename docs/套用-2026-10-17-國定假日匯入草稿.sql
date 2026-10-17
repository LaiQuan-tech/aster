-- =====================================================================
-- 2026-10-17 國定假日年度匯入草稿（migration 0071 ＝ sql/0061）
--
-- 前提：已套到 0070（sql/0060，晚餐勾選）。本檔不依賴 0070 的物件；0070 尚未套用時也可先套本檔，但正式庫順序請維持 0070 → 0071。
-- 整份可重跑（冪等）：CREATE TABLE／INDEX IF NOT EXISTS、CHECK 以 duplicate_object 略過、trigger 先 DROP 再建、
-- 函式 CREATE OR REPLACE（核准原子化 approve_calendar_import_draft）、抓取狀態表 calendar_import_fetch_status。
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

-- 核准（2026-10-17 驗收 S6）：「草稿標 approved」與「同年其他 approved 標 superseded」在同一交易裡做。
--   依租戶＋年份取 advisory lock 序列化；草稿必須仍為 draft（FOR UPDATE）才動，否則回 0 列（API 回 409）、不作廢任何人；
--   作廢條件排除自己。同時核准兩次 → 第二個拿不到 draft → 最後恰好一筆 approved。
--   只給 service_role 執行（API 走 service role；anon／authenticated 一律 revoke）。
CREATE OR REPLACE FUNCTION public.approve_calendar_import_draft(p_tenant_id uuid, p_draft_id uuid, p_actor_emp_id uuid)
RETURNS SETOF public.calendar_import_drafts
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_year integer;
  v_row public.calendar_import_drafts%ROWTYPE;
BEGIN
  SELECT year INTO v_year FROM public.calendar_import_drafts WHERE id = p_draft_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('calendar_import_drafts:' || p_tenant_id::text || ':' || v_year::text, 0));
  SELECT * INTO v_row FROM public.calendar_import_drafts
    WHERE id = p_draft_id AND tenant_id = p_tenant_id AND status = 'draft'
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE public.calendar_import_drafts SET status = 'superseded', updated_at = now()
    WHERE tenant_id = p_tenant_id AND year = v_year AND status = 'approved' AND id <> p_draft_id;
  UPDATE public.calendar_import_drafts
    SET status = 'approved', approved_by_emp_id = p_actor_emp_id, approved_at = now(), updated_at = now()
    WHERE id = p_draft_id
    RETURNING * INTO v_row;
  RETURN NEXT v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_calendar_import_draft(uuid, uuid, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.approve_calendar_import_draft(uuid, uuid, uuid) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.approve_calendar_import_draft(uuid, uuid, uuid) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- 抓取狀態（S10b）：每個年份一列（全平台共用，政府資料與租戶無關）——連續失敗天數、上次通知日。
--   排程每天記一次；連續失敗 3 天或 12 月仍沒有下一年 → 通知 HR（7 天內不重發）。只有 API（service role）讀寫。
CREATE TABLE IF NOT EXISTS public.calendar_import_fetch_status (
  year integer PRIMARY KEY,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_attempt_on date,
  last_outcome text,
  last_error text,
  alerted_on date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE public.calendar_import_fetch_status ADD CONSTRAINT calendar_import_fetch_status_outcome_chk
    CHECK (last_outcome IS NULL OR last_outcome IN ('ok', 'not_published', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.calendar_import_fetch_status ENABLE ROW LEVEL SECURITY;

-- ── 還原 ────────────────────────────────────────────────────────────
-- 草稿只是暫存＋核准紀錄，刪表不影響已寫入的行事曆（tenant_calendar_days）：
-- DROP FUNCTION IF EXISTS public.approve_calendar_import_draft(uuid, uuid, uuid);
-- DROP TABLE IF EXISTS public.calendar_import_fetch_status;
-- DROP TABLE IF EXISTS public.calendar_import_drafts;
