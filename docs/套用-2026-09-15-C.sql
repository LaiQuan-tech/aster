-- =====================================================================
-- 亞斯特 — 2026-09-15 C 批次（audit_row 記操作者／規則生效日／
-- 月結與月表快照表／時薪制欄位）
-- 增量 SQL
--
-- 前提：正式庫已套到 migration 0043 + sql/0032（即
-- docs/套用-2026-09-15-B.sql 套用後的狀態）。不相依任何其他待套增量。
-- 內容：
--   [1]  migration 0044 —— 新表 attendance_sheet_snapshots
--   [2]  migration 0044 —— 新表 period_closes
--   [3]  migration 0044 —— rule_configs 新增欄位 effective_from
--   [4]  migration 0044 —— salary_adjustments 新增欄位 changed_by_emp_id
--   [5]  migration 0044 —— salary_structures 新增欄位 agreed_hours_per_week
--   [6]  migration 0044 —— salary_structures 新增欄位 agreed_days_per_week
--   [7]  migration 0044 —— period_closes 的 FK（tenant_id → tenants）
--   [8]  migration 0044 —— period_closes 的 FK（closed_by_emp_id → employees）
--   [9]  migration 0044 —— attendance_sheet_snapshots 的 FK
--        （sheet_id → attendance_sheets）
--   [10] migration 0044 —— attendance_sheet_snapshots 的 FK
--        （employee_id → employees）
--   [11] migration 0044 —— attendance_sheet_snapshots 的 FK
--        （taken_by_emp_id → employees）
--   [12] migration 0044 —— salary_adjustments 新欄位的 FK
--        （changed_by_emp_id → employees）
--   [13] migration 0044 —— period_closes 新增 unique index
--        （tenant_id, period）
--   [14] migration 0044 —— attendance_sheet_snapshots 新增 unique index
--        （tenant_id, sheet_id, seq）
--   [15] migration 0044 —— attendance_sheet_snapshots 新增 index
--        （tenant_id, employee_id, period）
--   [16] sql/0033 —— audit_row() 改版：記操作者（actor_emp_id／context
--        讀 PostgREST request.headers GUC）
--   [17] sql/0033 —— 8 個既有表補掛 audit_all（employee_profiles／
--        departments／tenants／shifts／schedules／tenant_calendar_days／
--        approval_flows／expense_settings）
--   [18] sql/0033 —— onboardings 掛 audit_mutations（只 UPDATE/DELETE）
--   [19] sql/0033 —— rule_configs.effective_from backfill
--        （只動仍是 1900-01-01 的列）
--   [20] sql/0033 —— salary_structures_method_chk（新增，含 'hourly'）
--   [21] sql/0033 —— period_closes／attendance_sheet_snapshots
--        ENABLE ROW LEVEL SECURITY
--   [22] sql/0033 —— period_closes 掛 no_hard_delete／audit_all／
--        set_updated_at
--   [23] sql/0033 —— period_closes_status_chk
--   [24] sql/0033 —— attendance_sheet_snapshots 掛 no_hard_delete
--   [25] sql/0033 —— storage bucket tenant-snapshots
--
-- 冪等，可重複執行：CREATE TABLE 一律 IF NOT EXISTS，ADD COLUMN 一律
-- IF NOT EXISTS，FK 用 DO $$ ... EXCEPTION WHEN duplicate_object 包起來
-- （比照 migration 0030/0037、docs/套用-2026-09-14-放款.sql 的既有寫法），
-- CREATE INDEX 一律 IF NOT EXISTS，CHECK 一律先 DROP CONSTRAINT IF EXISTS
-- 再 ADD CONSTRAINT，trigger 一律先 DROP TRIGGER IF EXISTS 再 CREATE，
-- 函式一律 CREATE OR REPLACE，storage bucket 一律 ON CONFLICT DO NOTHING。
--
-- 套用方式：Supabase SQL Editor 整段貼上即可（[1][2] 兩張新表互不相依，
-- 但都須早於 [7]～[15]（FK／index 用到新表與新欄位）；[3][4][5][6] 加欄位
-- 互不相依，[4] 須早於 [12]（FK 指向 [4] 剛加出的欄位）；[16] 與其他段
-- 互不相依，但邏輯上是 [17][18] 的前提（trigger 呼叫的函式先換新版，
-- 順序其實不影響正確性，仍照邏輯順序排列）；[19] 依附 [3] 新加的
-- effective_from；[20] 依附既有 salary_structures.method 欄位，不依附本檔
-- 其他段；[21]～[24] 依附 [1][2] 兩張新表；[25] 與其他段互不相依。
-- 故整體順序不可打散）。
-- 前提函式：sql/0018 forbid_hard_delete()、sql/0019 audit_row()（本檔
-- [16] 會 CREATE OR REPLACE 成新版）、sql/0027 set_updated_at() 已存在
-- （前幾輪已套用）。
-- 驗證見 docs/驗證-2026-09-15-C.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0044 — 新表 attendance_sheet_snapshots
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "attendance_sheet_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sheet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"period" text NOT NULL,
	"seq" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"rule_config_version" integer,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_by_emp_id" uuid,
	"reason" text
);

-- ─────────────────────────────────────────────────────────────────
-- [2] migration 0044 — 新表 period_closes
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "period_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_emp_id" uuid,
	"sheet_count" integer DEFAULT 0 NOT NULL,
	"locked_count" integer DEFAULT 0 NOT NULL,
	"snapshot_manifest_path" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- [3] migration 0044 — rule_configs 新增欄位 effective_from
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "rule_configs" ADD COLUMN IF NOT EXISTS "effective_from" date DEFAULT '1900-01-01' NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- [4] migration 0044 — salary_adjustments 新增欄位 changed_by_emp_id
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "salary_adjustments" ADD COLUMN IF NOT EXISTS "changed_by_emp_id" uuid;

-- ─────────────────────────────────────────────────────────────────
-- [5] migration 0044 — salary_structures 新增欄位 agreed_hours_per_week
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "salary_structures" ADD COLUMN IF NOT EXISTS "agreed_hours_per_week" numeric(5, 2);

-- ─────────────────────────────────────────────────────────────────
-- [6] migration 0044 — salary_structures 新增欄位 agreed_days_per_week
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "salary_structures" ADD COLUMN IF NOT EXISTS "agreed_days_per_week" numeric(3, 1);

-- ─────────────────────────────────────────────────────────────────
-- [7] migration 0044 — period_closes 的 FK（tenant_id → tenants）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [8] migration 0044 — period_closes 的 FK（closed_by_emp_id → employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_closed_by_emp_id_employees_id_fk" FOREIGN KEY ("closed_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [9] migration 0044 — attendance_sheet_snapshots 的 FK
-- （sheet_id → attendance_sheets）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "attendance_sheet_snapshots" ADD CONSTRAINT "attendance_sheet_snapshots_sheet_id_attendance_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."attendance_sheets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [10] migration 0044 — attendance_sheet_snapshots 的 FK
-- （employee_id → employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "attendance_sheet_snapshots" ADD CONSTRAINT "attendance_sheet_snapshots_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [11] migration 0044 — attendance_sheet_snapshots 的 FK
-- （taken_by_emp_id → employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "attendance_sheet_snapshots" ADD CONSTRAINT "attendance_sheet_snapshots_taken_by_emp_id_employees_id_fk" FOREIGN KEY ("taken_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [12] migration 0044 — salary_adjustments 新欄位的 FK
-- （changed_by_emp_id → employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "salary_adjustments" ADD CONSTRAINT "salary_adjustments_changed_by_emp_id_employees_id_fk" FOREIGN KEY ("changed_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [13] migration 0044 — period_closes 新增 unique index（tenant_id, period）
-- ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "period_closes_tenant_period_uq" ON "period_closes" USING btree ("tenant_id","period");

-- ─────────────────────────────────────────────────────────────────
-- [14] migration 0044 — attendance_sheet_snapshots 新增 unique index
-- （tenant_id, sheet_id, seq）
-- ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_sheet_snapshots_tenant_sheet_seq_uq" ON "attendance_sheet_snapshots" USING btree ("tenant_id","sheet_id","seq");

-- ─────────────────────────────────────────────────────────────────
-- [15] migration 0044 — attendance_sheet_snapshots 新增 index
-- （tenant_id, employee_id, period）
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "attendance_sheet_snapshots_tenant_employee_period_idx" ON "attendance_sheet_snapshots" USING btree ("tenant_id","employee_id","period");

-- ─────────────────────────────────────────────────────────────────
-- [16] sql/0033 — audit_row() 改版：記操作者（actor_emp_id／context
-- 讀 PostgREST request.headers GUC）
-- ─────────────────────────────────────────────────────────────────
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
  v_actor uuid;
  v_ctx text;
BEGIN
  BEGIN
    v_actor := nullif(current_setting('request.headers', true)::json ->> 'x-actor-emp-id', '')::uuid;
    v_ctx := nullif(current_setting('request.headers', true)::json ->> 'x-actor-route', '');
  EXCEPTION WHEN others THEN
    v_actor := null;
    v_ctx := null;
  END;

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
    (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (
    nullif(v_any ->> 'tenant_id', '')::uuid,
    TG_TABLE_NAME,
    nullif(v_any ->> 'id', '')::uuid,
    TG_OP,
    v_old,
    v_new,
    current_user,
    v_actor,
    v_ctx
  );

  RETURN NULL; -- AFTER trigger，回傳值不被使用
END;
$$;

COMMENT ON FUNCTION public.audit_row() IS
  '把一列的 INSERT/UPDATE/DELETE 寫進 audit_logs（整列 jsonb）。C 批次起 actor_emp_id／context 優先讀 PostgREST 的 request.headers GUC（x-actor-emp-id／x-actor-route，已於正式庫實測可行）；GUC 不存在或值不合法時（migration／psql／pglite 等非 PostgREST 路徑）兩者皆為 null，不影響業務寫入（見 EXCEPTION WHEN others）。應用層 writeAuditLog 仍可能另外補一列，查核以 (table_name, record_id) 拼看。';

-- ─────────────────────────────────────────────────────────────────
-- [17] sql/0033 — 8 個既有表補掛 audit_all
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employee_profiles',
    'departments',
    'tenants',
    'shifts',
    'schedules',
    'tenant_calendar_days',
    'approval_flows',
    'expense_settings'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [18] sql/0033 — onboardings 掛 audit_mutations（只 UPDATE/DELETE）
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_mutations ON public.onboardings;
CREATE TRIGGER audit_mutations
  AFTER UPDATE OR DELETE ON public.onboardings
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────
-- [19] sql/0033 — rule_configs.effective_from backfill
-- （只動仍是 1900-01-01 的列）
-- ─────────────────────────────────────────────────────────────────
UPDATE public.rule_configs
   SET effective_from = (created_at AT TIME ZONE 'Asia/Taipei')::date
 WHERE effective_from = '1900-01-01';

-- ─────────────────────────────────────────────────────────────────
-- [20] sql/0033 — salary_structures_method_chk（新增，含 'hourly'）
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.salary_structures DROP CONSTRAINT IF EXISTS salary_structures_method_chk;
ALTER TABLE public.salary_structures ADD CONSTRAINT salary_structures_method_chk
  CHECK (method IN ('monthly', 'by_attendance_days', 'hourly'));

-- ─────────────────────────────────────────────────────────────────
-- [21] sql/0033 — period_closes／attendance_sheet_snapshots
-- ENABLE ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.period_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_sheet_snapshots ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────
-- [22] sql/0033 — period_closes 掛 no_hard_delete／audit_all／set_updated_at
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.period_closes;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.period_closes
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.period_closes;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.period_closes
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.period_closes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.period_closes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- [23] sql/0033 — period_closes_status_chk
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.period_closes DROP CONSTRAINT IF EXISTS period_closes_status_chk;
ALTER TABLE public.period_closes ADD CONSTRAINT period_closes_status_chk
  CHECK (status IN ('closed', 'reopened'));

-- ─────────────────────────────────────────────────────────────────
-- [24] sql/0033 — attendance_sheet_snapshots 掛 no_hard_delete
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheet_snapshots;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.attendance_sheet_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

-- ─────────────────────────────────────────────────────────────────
-- [25] sql/0033 — storage bucket tenant-snapshots
-- ─────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('tenant-snapshots', 'tenant-snapshots', false)
on conflict (id) do nothing;

update storage.buckets
   set public = false
 where id = 'tenant-snapshots'
   and public is distinct from false;

-- ── 還原 ────────────────────────────────────────────────────────────
-- delete from storage.objects where bucket_id = 'tenant-snapshots';
-- delete from storage.buckets where id = 'tenant-snapshots';
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheet_snapshots;
-- ALTER TABLE public.period_closes DROP CONSTRAINT IF EXISTS period_closes_status_chk;
-- DROP TRIGGER IF EXISTS set_updated_at ON public.period_closes;
-- DROP TRIGGER IF EXISTS audit_all ON public.period_closes;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.period_closes;
-- ALTER TABLE public.period_closes DISABLE ROW LEVEL SECURITY; -- 不建議：一旦開了就該一直被擋住
-- ALTER TABLE public.attendance_sheet_snapshots DISABLE ROW LEVEL SECURITY; -- 同上，不建議
-- ALTER TABLE public.salary_structures DROP CONSTRAINT IF EXISTS salary_structures_method_chk;
-- （rule_configs.effective_from 的 backfill 不可逆。）
-- DROP TRIGGER IF EXISTS audit_mutations ON public.onboardings;
-- DO $$ DECLARE t text; BEGIN
--   FOREACH t IN ARRAY ARRAY['employee_profiles','departments','tenants','shifts',
--     'schedules','tenant_calendar_days','approval_flows','expense_settings']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t); END LOOP;
-- END $$;
-- （audit_row() 改版對舊呼叫端完全相容，不建議還原成 sql/0019 舊版；
-- 如真要回退，把 [16] 換回 sql/0019 的原始定義即可。）
-- DROP INDEX IF EXISTS "attendance_sheet_snapshots_tenant_employee_period_idx";
-- DROP INDEX IF EXISTS "attendance_sheet_snapshots_tenant_sheet_seq_uq";
-- DROP INDEX IF EXISTS "period_closes_tenant_period_uq";
-- ALTER TABLE "salary_adjustments" DROP CONSTRAINT IF EXISTS "salary_adjustments_changed_by_emp_id_employees_id_fk";
-- ALTER TABLE "attendance_sheet_snapshots" DROP CONSTRAINT IF EXISTS "attendance_sheet_snapshots_taken_by_emp_id_employees_id_fk";
-- ALTER TABLE "attendance_sheet_snapshots" DROP CONSTRAINT IF EXISTS "attendance_sheet_snapshots_employee_id_employees_id_fk";
-- ALTER TABLE "attendance_sheet_snapshots" DROP CONSTRAINT IF EXISTS "attendance_sheet_snapshots_sheet_id_attendance_sheets_id_fk";
-- ALTER TABLE "period_closes" DROP CONSTRAINT IF EXISTS "period_closes_closed_by_emp_id_employees_id_fk";
-- ALTER TABLE "period_closes" DROP CONSTRAINT IF EXISTS "period_closes_tenant_id_tenants_id_fk";
-- ALTER TABLE "salary_structures" DROP COLUMN IF EXISTS agreed_days_per_week;
-- ALTER TABLE "salary_structures" DROP COLUMN IF EXISTS agreed_hours_per_week;
-- ALTER TABLE "salary_adjustments" DROP COLUMN IF EXISTS changed_by_emp_id;
-- ALTER TABLE "rule_configs" DROP COLUMN IF EXISTS effective_from;
-- DROP TABLE IF EXISTS "period_closes";
-- DROP TABLE IF EXISTS "attendance_sheet_snapshots";
-- （刪表會連資料一起丟，先確認沒人用。）
