-- =====================================================================
-- 亞斯特 — 2026-09-14 P0 出勤基礎建設增量 SQL
--
-- 前提：正式庫已在 migration 0037 + sql/0025（目前的正式庫狀態，見
-- docs/交接-2026-09-13.md 第 0 節）。不相依任何其他待套增量。
-- 內容：
--   [1] migration 0038 —— tenants.timezone
--   [2] migration 0038 —— 新表 tenant_calendar_days（含 unique index、FK）
--   [3] migration 0038 —— leave_types.deduct_rate
--   [4] migration 0038 —— punch_records.request_id（刻意不設 FK，見 schema 註解）
--   [5] migration 0038 —— attendance_days 四個新欄位（leave_minutes /
--       leave_breakdown / outing_minutes / early_leave_minutes）
--   [6] sql/0026 —— tenant_calendar_days 啟用 RLS（不給 policy，比照 0024）
--       + day_type 合法值防呆 CHECK
--
-- 冪等，可重複執行：DDL 一律 IF NOT EXISTS／ADD COLUMN IF NOT EXISTS，
-- FK 用 DO $$ ... EXCEPTION WHEN duplicate_object 包起來（比照 migration
-- 0030/0037 的既有寫法）。套用方式：Supabase SQL Editor 整段貼上即可
-- （段間有相依：[2] 的 FK 指向 [1] 之前就已存在的 tenants，[6] 的 CHECK
-- 建在 [2] 剛建出的表上，故順序不可打散）。
-- 驗證見 docs/驗證-2026-09-14-P0.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0038 — tenants.timezone
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'Asia/Taipei' NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- [2] migration 0038 — 新表 tenant_calendar_days
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tenant_calendar_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"date" date NOT NULL,
	"day_type" text NOT NULL,
	"label" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_calendar_days" ADD CONSTRAINT "tenant_calendar_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_calendar_days_tenant_date_uq" ON "tenant_calendar_days" USING btree ("tenant_id","date");

-- ─────────────────────────────────────────────────────────────────
-- [3] migration 0038 — leave_types.deduct_rate
-- ─────────────────────────────────────────────────────────────────
-- NULL＝由 paid 推：paid=true→0、paid=false→1（見 schema 註解）。
ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "deduct_rate" numeric(3, 2);

-- ─────────────────────────────────────────────────────────────────
-- [4] migration 0038 — punch_records.request_id
-- ─────────────────────────────────────────────────────────────────
-- 指向核准的補打卡申請；刻意不設 FK（見 schema 註解），純追溯用途。
ALTER TABLE "punch_records" ADD COLUMN IF NOT EXISTS "request_id" uuid;

-- ─────────────────────────────────────────────────────────────────
-- [5] migration 0038 — attendance_days 四個新欄位
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "attendance_days" ADD COLUMN IF NOT EXISTS "leave_minutes" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD COLUMN IF NOT EXISTS "leave_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD COLUMN IF NOT EXISTS "outing_minutes" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD COLUMN IF NOT EXISTS "early_leave_minutes" integer DEFAULT 0 NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- [6] sql/0026 — tenant_calendar_days RLS + day_type 合法值防呆
-- ─────────────────────────────────────────────────────────────────
-- 比照 sql/0024：ENABLE 但不給 policy（前端從不直讀，皆經 API service_role）。
ALTER TABLE public.tenant_calendar_days ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 不掛禁刪／稽核 trigger：行事曆是可重建的參考資料（比照 sql/0018/0019 的排除邏輯）。
ALTER TABLE public.tenant_calendar_days DROP CONSTRAINT IF EXISTS tenant_calendar_days_day_type_chk;
--> statement-breakpoint
ALTER TABLE public.tenant_calendar_days ADD CONSTRAINT tenant_calendar_days_day_type_chk
  CHECK (day_type IN ('workday', 'rest_day', 'fixed_holiday'));

-- ── 還原（不可逆部分：新表刪除會連資料一起丟，先確認沒人用）────────────
-- ALTER TABLE public.tenant_calendar_days DROP CONSTRAINT IF EXISTS tenant_calendar_days_day_type_chk;
-- ALTER TABLE public.tenant_calendar_days DISABLE ROW LEVEL SECURITY;
-- DROP TABLE IF EXISTS public.tenant_calendar_days;
-- ALTER TABLE public.punch_records DROP COLUMN IF EXISTS request_id;
-- ALTER TABLE public.leave_types DROP COLUMN IF EXISTS deduct_rate;
-- ALTER TABLE public.attendance_days DROP COLUMN IF EXISTS leave_minutes, DROP COLUMN IF EXISTS leave_breakdown, DROP COLUMN IF EXISTS outing_minutes, DROP COLUMN IF EXISTS early_leave_minutes;
-- ALTER TABLE public.tenants DROP COLUMN IF EXISTS timezone;
