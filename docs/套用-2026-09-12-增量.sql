-- =====================================================================
-- 亞斯特 — 2026-09-12 增量 SQL（出差預支，模組三第 2 條）
--
-- 前提：已套用 2026-09-12 的第一批（migration 0026~0029、sql/0018~0020）。
-- 本批只有兩件事：
--   [1] migration 0030 —— 新增 trip_advances 表，並為三張既有表加欄位
--   [2] 把 trip_advances 納入既有的禁刪與稽核 trigger
--       （trip_advances 是金流表：現金撥款與沖抵都必須留痕）
--
-- 全部冪等，重複執行無害。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0030
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "trip_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_request_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"payout_channel" text,
	"paid_at" timestamp with time zone,
	"paid_by_emp_id" uuid,
	"actual_total" numeric,
	"balance" numeric,
	"balance_handling" text,
	"recovery_period" text,
	"settled_at" timestamp with time zone,
	"settled_by_emp_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "requires_trip_approval" boolean DEFAULT false NOT NULL;
ALTER TABLE "expense_claims" ADD COLUMN IF NOT EXISTS "trip_request_id" uuid;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "trip_scope" text;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "estimated_cost" numeric;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "advance_requested" numeric;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "trip_report" text;
DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_trip_request_id_leave_requests_id_fk" FOREIGN KEY ("trip_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_paid_by_emp_id_employees_id_fk" FOREIGN KEY ("paid_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_settled_by_emp_id_employees_id_fk" FOREIGN KEY ("settled_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "trip_advances_tenant_employee_status_idx" ON "trip_advances" USING btree ("tenant_id","employee_id","status");
CREATE INDEX IF NOT EXISTS "trip_advances_tenant_recovery_period_idx" ON "trip_advances" USING btree ("tenant_id","recovery_period");
DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_trip_request_id_leave_requests_id_fk" FOREIGN KEY ("trip_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [2] 把 trip_advances 納入禁刪與稽核
-- ─────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS no_hard_delete ON public.trip_advances;
CREATE TRIGGER no_hard_delete BEFORE DELETE ON public.trip_advances
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.trip_advances;
CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.trip_advances
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────
-- 驗證（**分開跑**，一次只跑這一條）
-- ─────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from information_schema.tables
--     where table_schema='public' and table_name='trip_advances')   as "trip_advances 表(預期1)",
--   (select count(*) from information_schema.columns
--     where table_schema='public' and (
--       (table_name='leave_requests' and column_name in
--         ('trip_scope','estimated_cost','advance_requested','trip_report'))
--       or (table_name='expense_categories' and column_name='requires_trip_approval')
--       or (table_name='expense_claims' and column_name='trip_request_id')))  as "新欄位(預期6)",
--   (select count(*) from pg_trigger t
--      join pg_class c on c.oid=t.tgrelid
--      join pg_namespace n on n.oid=c.relnamespace
--     where n.nspname='public' and not t.tgisinternal
--       and c.relname='trip_advances')                              as "trip_advances trigger(預期2)";
