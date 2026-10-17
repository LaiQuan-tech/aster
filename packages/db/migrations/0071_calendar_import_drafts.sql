-- 2026-10-17 國定假日年度匯入草稿（calendar_import_drafts）。
--   API（services/holiday-import.ts）從人事行政總處辦公日曆表（data.gov.tw 14718）抓年度資料、與新北市資料交叉比對，
--   寫成「草稿」；HR 在後台預覽、可改（補假日、選舉投票日）、核准後才寫入 tenant_calendar_days。
--   worker 每日排程：7/1 起下一年度沒有已核准行事曆 → 自動建草稿並通知 HR；每月 1 日重抓當年與下一年，
--   官方修正版與已核准不同 → 建新草稿並通知，不自動覆蓋。
--   status：draft（待核准，每租戶每年最多一筆）→ approved（每租戶每年最多一筆現行版）／superseded（被新草稿或新核准取代）。
--   payload：{ year, source, resource, official(官方原始解析結果), holidays(HR 可編輯的清單), officialKey, edited, … }
--   diff：與新北資料的差異清單（{ available, reason?, items[] }）。
-- 前提：已套到 0069（sql/0059），且 0070（sql/0060）晚餐勾選需先或同時套用（本檔不依賴 0070 的物件）。可重跑。
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
