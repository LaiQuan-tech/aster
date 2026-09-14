-- =====================================================================
-- 亞斯特 — 2026-09-14 P1（出勤月表）＋ P3（專案申請單／客戶／副委託／
-- 期款開票入帳）增量 SQL
--
-- 前提：正式庫已套到 migration 0038 + sql/0026（即 2026-09-14 P0 套用後的
-- 狀態，見 docs/套用-2026-09-14-P0.sql）。不相依任何其他待套增量。
-- 內容：
--   [1]  migration 0039 —— 新表 attendance_sheet_days
--   [2]  migration 0039 —— 新表 attendance_sheets
--   [3]  migration 0039 —— attendance_sheet_days／attendance_sheets 的 FK
--   [4]  migration 0039 —— attendance_sheet_days／attendance_sheets 的 index
--   [5]  migration 0039 —— punch_records 補打卡落地冪等（partial unique index）
--   [6]  migration 0040 —— 新表 clients／companies／
--        project_subcontract_payments／project_subcontracts
--   [7]  migration 0040 —— 既有表新增欄位（contracts／project_billings／
--        project_settings／projects）
--   [8]  migration 0040 —— 新表的 FK
--   [9]  migration 0040 —— 新表的 index
--   [10] migration 0040 —— 既有表新欄位的 FK（contracts.client_id／
--        projects.client_id → clients）
--   [11] sql/0027 —— attendance_sheets／attendance_sheet_days 的
--        set_updated_at 函式、RLS、禁刪＋稽核＋updated_at trigger、CHECK
--   [12] sql/0028 —— clients／companies／project_subcontracts／
--        project_subcontract_payments 的 RLS、禁刪＋稽核、CHECK；
--        project_billings／projects／project_settings 的新 CHECK
--
-- 冪等，可重複執行：CREATE TABLE 一律 IF NOT EXISTS，ADD COLUMN 一律
-- IF NOT EXISTS，FK 用 DO $$ ... EXCEPTION WHEN duplicate_object 包起來
-- （比照 migration 0030/0037、docs/套用-2026-09-14-P0.sql 的既有寫法），
-- CREATE INDEX 一律 IF NOT EXISTS，CHECK 一律先 DROP CONSTRAINT IF EXISTS
-- 再 ADD CONSTRAINT，trigger 一律先 DROP TRIGGER IF EXISTS 再 CREATE。
--
-- 套用方式：Supabase SQL Editor 整段貼上即可（段間有相依：[3] 的 FK 指向
-- [1][2] 剛建出的表，[6] 的新表在 [7] 之前建好即可（[7] 只是既有表加欄，
-- 互不相依），[8] 的 FK 指向 [6] 的新表，[10] 的 FK 指向 [6] 的 clients
-- 且欄位須先由 [7] 加出來，[11] 的 trigger／CHECK 建在 [1][2] 的表上，
-- [12] 建在 [6] 的新表與 [7] 加出的欄位上，故整體順序不可打散）。
-- 驗證見 docs/驗證-2026-09-14-P1P3.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0039 — 新表 attendance_sheet_days
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "attendance_sheet_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sheet_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"weekday" smallint,
	"day_type" text,
	"first_in" timestamp with time zone,
	"last_out" timestamp with time zone,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"late_minutes" integer DEFAULT 0,
	"early_leave_minutes" integer DEFAULT 0,
	"overtime_minutes_computed" integer DEFAULT 0 NOT NULL,
	"ot_tier1_minutes" integer DEFAULT 0,
	"ot_tier2_minutes" integer DEFAULT 0,
	"ot_tier3_minutes" integer DEFAULT 0,
	"outing_minutes" integer DEFAULT 0,
	"leave_minutes_computed" integer DEFAULT 0,
	"leave_summary" text,
	"wfh" boolean DEFAULT false NOT NULL,
	"anomalies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overtime_minutes_override" integer,
	"override_reason" text,
	"content" text,
	"outing_note" text,
	"project_id" uuid,
	"note" text,
	"anomaly_ack" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- [2] migration 0039 — 新表 attendance_sheets
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "attendance_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"manager_emp_id" uuid,
	"submitted_at" timestamp with time zone,
	"submitted_by" uuid,
	"manager_reviewed_at" timestamp with time zone,
	"manager_reviewed_by" uuid,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"locked_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"returned_by" uuid,
	"return_reason" text,
	"reopen_reason" text,
	"rule_config_version" integer,
	"computed_at" timestamp with time zone,
	"month_anomalies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- [3] migration 0039 — attendance_sheet_days／attendance_sheets 的 FK
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "attendance_sheet_days" ADD CONSTRAINT "attendance_sheet_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "attendance_sheet_days" ADD CONSTRAINT "attendance_sheet_days_sheet_id_attendance_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."attendance_sheets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "attendance_sheet_days" ADD CONSTRAINT "attendance_sheet_days_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "attendance_sheets" ADD CONSTRAINT "attendance_sheets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "attendance_sheets" ADD CONSTRAINT "attendance_sheets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [4] migration 0039 — attendance_sheet_days／attendance_sheets 的 index
-- ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_sheet_days_sheet_work_date_uq" ON "attendance_sheet_days" USING btree ("sheet_id","work_date");
CREATE INDEX IF NOT EXISTS "attendance_sheet_days_tenant_sheet_idx" ON "attendance_sheet_days" USING btree ("tenant_id","sheet_id");
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_sheets_tenant_employee_period_uq" ON "attendance_sheets" USING btree ("tenant_id","employee_id","period");
CREATE INDEX IF NOT EXISTS "attendance_sheets_tenant_period_status_idx" ON "attendance_sheets" USING btree ("tenant_id","period","status");

-- ─────────────────────────────────────────────────────────────────
-- [5] migration 0039 — punch_records 補打卡落地冪等
-- ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "punch_records_request_dedupe_uidx" ON "punch_records" USING btree ("tenant_id","employee_id","type","punch_at") WHERE "punch_records"."request_id" is not null;

-- ─────────────────────────────────────────────────────────────────
-- [6] migration 0040 — 新表 clients／companies／
--     project_subcontract_payments／project_subcontracts
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tax_id" text,
	"phone" text,
	"fax" text,
	"invoice_address" text,
	"contact_name" text,
	"contact_phone" text,
	"email" text,
	"invoice_type" text,
	"payment_method" text,
	"closing_day" text,
	"payment_day" text,
	"note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tax_id" text,
	"bank_name" text,
	"bank_account" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "project_subcontract_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subcontract_id" uuid NOT NULL,
	"installment_no" integer NOT NULL,
	"percentage" numeric(7, 4),
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"override_amount" numeric(14, 2),
	"override_reason" text,
	"due_when" text,
	"paid_on" date,
	"paid_amount" numeric(14, 2),
	"withheld_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paying_company_id" uuid,
	"receipt_issuer_company_id" uuid,
	"receipt_ref" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "project_subcontracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text DEFAULT 'subcontract' NOT NULL,
	"discipline" text,
	"vendor_id" uuid,
	"vendor_name" text,
	"contact" text,
	"item" text,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"billing_basis" text,
	"order_type" text,
	"contract_id" uuid,
	"withholding_rate" numeric(5, 4) DEFAULT '0.10' NOT NULL,
	"withholding_threshold" integer DEFAULT 20000 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"delete_reason" text
);

-- ─────────────────────────────────────────────────────────────────
-- [7] migration 0040 — 既有表新增欄位
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "client_id" uuid;

ALTER TABLE "project_billings" ADD COLUMN IF NOT EXISTS "invoice_no" text;
ALTER TABLE "project_billings" ADD COLUMN IF NOT EXISTS "invoiced_on" date;
ALTER TABLE "project_billings" ADD COLUMN IF NOT EXISTS "received_on" date;
ALTER TABLE "project_billings" ADD COLUMN IF NOT EXISTS "received_amount" numeric(14, 2);
ALTER TABLE "project_billings" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'installment' NOT NULL;

ALTER TABLE "project_settings" ADD COLUMN IF NOT EXISTS "code_prefix" text DEFAULT 'AT' NOT NULL;
ALTER TABLE "project_settings" ADD COLUMN IF NOT EXISTS "code_year_style" text DEFAULT 'roc' NOT NULL;
ALTER TABLE "project_settings" ADD COLUMN IF NOT EXISTS "code_seq_digits" integer DEFAULT 3 NOT NULL;
ALTER TABLE "project_settings" ADD COLUMN IF NOT EXISTS "vat_rate" numeric(5, 4) DEFAULT '0.05' NOT NULL;
ALTER TABLE "project_settings" ADD COLUMN IF NOT EXISTS "disciplines" jsonb DEFAULT '["電機","空調","消防","汙水"]'::jsonb NOT NULL;

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "client_id" uuid;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "parent_project_id" uuid;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'main' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "reserved_at" timestamp with time zone;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "site_address" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "site_area_m2" numeric(12, 2);
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "design_scope" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "invoice_type" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "payment_method" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "closing_day" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "payment_day" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "other_expenses" numeric(14, 2) DEFAULT '0' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "engineers" jsonb DEFAULT '{}'::jsonb NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- [8] migration 0040 — 新表的 FK
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_subcontract_id_project_subcontracts_id_fk" FOREIGN KEY ("subcontract_id") REFERENCES "public"."project_subcontracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_paying_company_id_companies_id_fk" FOREIGN KEY ("paying_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_receipt_issuer_company_id_companies_id_fk" FOREIGN KEY ("receipt_issuer_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [9] migration 0040 — 新表的 index
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "clients_tenant_name_idx" ON "clients" USING btree ("tenant_id","name");
CREATE UNIQUE INDEX IF NOT EXISTS "clients_tenant_tax_id_uq" ON "clients" USING btree ("tenant_id","tax_id") WHERE "clients"."tax_id" is not null and "clients"."deleted_at" is null;
CREATE UNIQUE INDEX IF NOT EXISTS "companies_tenant_name_uq" ON "companies" USING btree ("tenant_id","name");
CREATE UNIQUE INDEX IF NOT EXISTS "project_subcontract_payments_subcontract_installment_uq" ON "project_subcontract_payments" USING btree ("subcontract_id","installment_no");
CREATE INDEX IF NOT EXISTS "project_subcontracts_tenant_project_idx" ON "project_subcontracts" USING btree ("tenant_id","project_id");

-- ─────────────────────────────────────────────────────────────────
-- [10] migration 0040 — 既有表新欄位的 FK（→ clients）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "contracts" ADD CONSTRAINT "contracts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [11] sql/0027 — attendance_sheets／attendance_sheet_days：
--      set_updated_at 函式、RLS、禁刪＋稽核＋updated_at trigger、CHECK
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.set_updated_at() IS
  '通用 updated_at 自動更新 trigger：BEFORE UPDATE 時把 updated_at 設為 now()。';

ALTER TABLE public.attendance_sheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_sheet_days ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheets;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.attendance_sheets
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.attendance_sheets;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_sheets
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.attendance_sheets;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.attendance_sheets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheet_days;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.attendance_sheet_days
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.attendance_sheet_days;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.attendance_sheet_days
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.attendance_sheet_days;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.attendance_sheet_days
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.attendance_sheets DROP CONSTRAINT IF EXISTS attendance_sheets_period_chk;
ALTER TABLE public.attendance_sheets ADD CONSTRAINT attendance_sheets_period_chk
  CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

ALTER TABLE public.attendance_sheets DROP CONSTRAINT IF EXISTS attendance_sheets_status_chk;
ALTER TABLE public.attendance_sheets ADD CONSTRAINT attendance_sheets_status_chk
  CHECK (status IN ('draft', 'submitted', 'manager_reviewed', 'approved', 'locked', 'returned'));

ALTER TABLE public.attendance_sheet_days
  DROP CONSTRAINT IF EXISTS attendance_sheet_days_override_chk;
ALTER TABLE public.attendance_sheet_days ADD CONSTRAINT attendance_sheet_days_override_chk
  CHECK (
    overtime_minutes_override IS NULL
    OR (override_reason IS NOT NULL AND length(trim(override_reason)) > 0)
  );

-- ─────────────────────────────────────────────────────────────────
-- [12] sql/0028 — clients／companies／project_subcontracts／
--      project_subcontract_payments：RLS、禁刪＋稽核、CHECK；
--      project_billings／projects／project_settings 的新 CHECK
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_subcontracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_subcontract_payments ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS no_hard_delete ON public.project_subcontracts;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.project_subcontracts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.project_subcontracts;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.project_subcontracts
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS no_hard_delete ON public.project_subcontract_payments;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.project_subcontract_payments
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.project_subcontract_payments;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.project_subcontract_payments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS audit_all ON public.clients;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS audit_all ON public.companies;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_invoice_type_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_invoice_type_chk
  CHECK (invoice_type IS NULL OR invoice_type IN ('duplicate', 'triplicate'));

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_payment_method_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_payment_method_chk
  CHECK (payment_method IS NULL OR payment_method IN ('transfer', 'check'));

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_kind_chk;
ALTER TABLE public.projects ADD CONSTRAINT projects_kind_chk
  CHECK (kind IN ('main', 'change', 'addition', 'advance'));

ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_kind_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_kind_chk
  CHECK (kind IN ('installment', 'guild_advance'));

ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_received_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_received_chk
  CHECK (received_on IS NULL OR received_amount IS NOT NULL);

ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_kind_chk;
ALTER TABLE public.project_subcontracts ADD CONSTRAINT project_subcontracts_kind_chk
  CHECK (kind IN ('subcontract', 'technician'));

ALTER TABLE public.project_subcontracts
  DROP CONSTRAINT IF EXISTS project_subcontracts_order_type_chk;
ALTER TABLE public.project_subcontracts ADD CONSTRAINT project_subcontracts_order_type_chk
  CHECK (order_type IS NULL OR order_type IN ('quotation', 'contract'));

ALTER TABLE public.project_subcontract_payments
  DROP CONSTRAINT IF EXISTS project_subcontract_payments_override_chk;
ALTER TABLE public.project_subcontract_payments
  ADD CONSTRAINT project_subcontract_payments_override_chk
  CHECK (override_amount IS NULL OR override_reason IS NOT NULL);

ALTER TABLE public.project_subcontract_payments
  DROP CONSTRAINT IF EXISTS project_subcontract_payments_paid_chk;
ALTER TABLE public.project_subcontract_payments
  ADD CONSTRAINT project_subcontract_payments_paid_chk
  CHECK (paid_on IS NULL OR paid_amount IS NOT NULL);

ALTER TABLE public.project_settings
  DROP CONSTRAINT IF EXISTS project_settings_code_year_style_chk;
ALTER TABLE public.project_settings ADD CONSTRAINT project_settings_code_year_style_chk
  CHECK (code_year_style IN ('roc', 'ad'));

-- ── 還原（不可逆部分：新表刪除會連資料一起丟，先確認沒人用）────────────
-- ALTER TABLE public.project_settings DROP CONSTRAINT IF EXISTS project_settings_code_year_style_chk;
-- ALTER TABLE public.project_subcontract_payments DROP CONSTRAINT IF EXISTS project_subcontract_payments_paid_chk;
-- ALTER TABLE public.project_subcontract_payments DROP CONSTRAINT IF EXISTS project_subcontract_payments_override_chk;
-- ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_order_type_chk;
-- ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_kind_chk;
-- ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_received_chk;
-- ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_kind_chk;
-- ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_kind_chk;
-- ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_payment_method_chk;
-- ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_invoice_type_chk;
-- DROP TRIGGER IF EXISTS audit_all ON public.companies;
-- DROP TRIGGER IF EXISTS audit_all ON public.clients;
-- DROP TRIGGER IF EXISTS audit_all ON public.project_subcontract_payments;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.project_subcontract_payments;
-- DROP TRIGGER IF EXISTS audit_all ON public.project_subcontracts;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.project_subcontracts;
-- ALTER TABLE public.attendance_sheet_days DROP CONSTRAINT IF EXISTS attendance_sheet_days_override_chk;
-- ALTER TABLE public.attendance_sheets DROP CONSTRAINT IF EXISTS attendance_sheets_status_chk;
-- ALTER TABLE public.attendance_sheets DROP CONSTRAINT IF EXISTS attendance_sheets_period_chk;
-- DROP TRIGGER IF EXISTS set_updated_at ON public.attendance_sheet_days;
-- DROP TRIGGER IF EXISTS audit_all ON public.attendance_sheet_days;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheet_days;
-- DROP TRIGGER IF EXISTS set_updated_at ON public.attendance_sheets;
-- DROP TRIGGER IF EXISTS audit_all ON public.attendance_sheets;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheets;
-- DROP FUNCTION IF EXISTS public.set_updated_at();
-- ALTER TABLE "projects" DROP COLUMN IF EXISTS client_id, DROP COLUMN IF EXISTS parent_project_id, DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS reserved_at, DROP COLUMN IF EXISTS site_address, DROP COLUMN IF EXISTS site_area_m2, DROP COLUMN IF EXISTS design_scope, DROP COLUMN IF EXISTS invoice_type, DROP COLUMN IF EXISTS payment_method, DROP COLUMN IF EXISTS closing_day, DROP COLUMN IF EXISTS payment_day, DROP COLUMN IF EXISTS other_expenses, DROP COLUMN IF EXISTS engineers;
-- ALTER TABLE "project_settings" DROP COLUMN IF EXISTS code_prefix, DROP COLUMN IF EXISTS code_year_style, DROP COLUMN IF EXISTS code_seq_digits, DROP COLUMN IF EXISTS vat_rate, DROP COLUMN IF EXISTS disciplines;
-- ALTER TABLE "project_billings" DROP COLUMN IF EXISTS invoice_no, DROP COLUMN IF EXISTS invoiced_on, DROP COLUMN IF EXISTS received_on, DROP COLUMN IF EXISTS received_amount, DROP COLUMN IF EXISTS kind;
-- ALTER TABLE "contracts" DROP COLUMN IF EXISTS client_id;
-- DROP TABLE IF EXISTS public.project_subcontracts;
-- DROP TABLE IF EXISTS public.project_subcontract_payments;
-- DROP TABLE IF EXISTS public.companies;
-- DROP TABLE IF EXISTS public.clients;
-- DROP INDEX IF EXISTS public.punch_records_request_dedupe_uidx;
-- DROP TABLE IF EXISTS public.attendance_sheets;
-- DROP TABLE IF EXISTS public.attendance_sheet_days;
