-- 2026-11-17 特殊假日（颱風假、停班、防疫…）（本檔 ＝ sql/0100；0109／sql/0099 留給並行中的另一張遷移）。
--
-- 業主：後台「打卡紀錄維護」最右邊新增分頁「特殊假別」，管理員可針對特定日期設定有薪／無薪的特殊假日，
-- 例如 10/13 颱風假。適用範圍可為全公司、指定部門或指定員工（颱風常只停某縣市）。
--
-- 效果（API 結算時套用，見 apps/api/src/services/special-leave-days.ts）：
--   • 適用員工在該日不算曠職、不算遲到早退、不產生缺卡提醒；
--   • 有薪＝視同出勤不扣薪；無薪＝依時薪×當日約定工時扣薪（同事假）；兩者都不影響全勤；
--   • 已核准／鎖定的月表與已結算月份不追溯（月表快照、period lock 照舊）。
--
-- 一列＝一段日期（start_date～end_date，單日時兩者相同，最長 31 天）。
-- scope：'all' 全公司｜'departments' department_ids 內的部門｜'employees' employee_ids 內的員工。
-- 刪除＝軟刪除（deleted_at／deleted_by_emp_id），結算一律只讀 deleted_at IS NULL。
--
-- 只由 API（service role）存取：RLS 開、不給 policy、revoke anon／authenticated。
-- 純新增、可重跑（IF NOT EXISTS／duplicate_object）；不動任何既有資料列。

CREATE TABLE IF NOT EXISTS public.special_leave_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  start_date date NOT NULL,
  end_date date NOT NULL,
  name text NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'all',
  department_ids uuid[] NOT NULL DEFAULT '{}',
  employee_ids uuid[] NOT NULL DEFAULT '{}',
  note text,
  created_by_emp_id uuid REFERENCES public.employees(id),
  updated_by_emp_id uuid REFERENCES public.employees(id),
  deleted_by_emp_id uuid REFERENCES public.employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

DO $$ BEGIN
  ALTER TABLE public.special_leave_days ADD CONSTRAINT special_leave_days_range_chk
    CHECK (end_date >= start_date AND end_date - start_date <= 30);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.special_leave_days ADD CONSTRAINT special_leave_days_scope_chk
    CHECK (scope IN ('all', 'departments', 'employees'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.special_leave_days ADD CONSTRAINT special_leave_days_text_chk
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 40 AND (note IS NULL OR char_length(note) <= 500));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.special_leave_days ADD CONSTRAINT special_leave_days_targets_chk
    CHECK (
      (scope <> 'departments' OR cardinality(department_ids) BETWEEN 1 AND 200)
      AND (scope <> 'employees' OR cardinality(employee_ids) BETWEEN 1 AND 500)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS special_leave_days_tenant_range_idx
  ON public.special_leave_days (tenant_id, start_date, end_date) WHERE deleted_at IS NULL;

ALTER TABLE public.special_leave_days ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  REVOKE ALL ON TABLE public.special_leave_days FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT ALL ON TABLE public.special_leave_days TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- 留痕：比照 vendor_bank_change_requests（0103）掛 audit_all（audit_row() 不存在的環境略過）；API 另寫 audit_logs。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'audit_row') THEN
    EXECUTE 'DROP TRIGGER IF EXISTS audit_all ON public.special_leave_days';
    EXECUTE 'CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.special_leave_days FOR EACH ROW EXECUTE FUNCTION public.audit_row()';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
