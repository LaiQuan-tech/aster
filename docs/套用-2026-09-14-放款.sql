-- =====================================================================
-- 亞斯特 — 2026-09-14 放款專區（匯款紀錄 × 專案連動，計畫 §一 資料模型）
-- 增量 SQL
--
-- 前提：正式庫已套到 migration 0040 + sql/0028（即
-- docs/套用-2026-09-14-P1P3.sql 套用後的狀態）。不相依任何其他待套增量。
-- 內容：
--   [1]  migration 0041 —— 新表 disbursement_allocations
--   [2]  migration 0041 —— 新表 disbursement_attachments
--   [3]  migration 0041 —— 新表 disbursements
--   [4]  migration 0041 —— 既有表新增欄位（project_subcontract_payments.
--        disbursement_id；vendors 收款帳戶四欄）
--   [5]  migration 0041 —— 新表的 FK
--   [6]  migration 0041 —— 新表的 index
--   [7]  migration 0041 —— 既有表新欄位的 FK（project_subcontract_payments.
--        disbursement_id → disbursements）
--   [8]  sql/0029 —— disbursements／disbursement_allocations／
--        disbursement_attachments 的 RLS
--   [9]  sql/0029 —— 上述三表的禁刪＋稽核＋updated_at trigger
--   [10] sql/0029 —— 上述表的合法值防呆 CHECK
--   [11] sql/0029 —— storage bucket disbursement-vouchers
--
-- 冪等，可重複執行：CREATE TABLE 一律 IF NOT EXISTS，ADD COLUMN 一律
-- IF NOT EXISTS，FK 用 DO $$ ... EXCEPTION WHEN duplicate_object 包起來
-- （比照 migration 0030/0037、docs/套用-2026-09-14-P1P3.sql 的既有寫法），
-- CREATE INDEX 一律 IF NOT EXISTS，CHECK 一律先 DROP CONSTRAINT IF EXISTS
-- 再 ADD CONSTRAINT，trigger 一律先 DROP TRIGGER IF EXISTS 再 CREATE，
-- storage bucket 用 ON CONFLICT DO NOTHING。
--
-- 套用方式：Supabase SQL Editor 整段貼上即可（段間有相依：[1][2][3] 建表
-- 互不相依但須早於 [5]/[6]；[5] 的 FK 指向 [1][2][3] 剛建出的表；[7] 的 FK
-- 指向 [3] 的 disbursements 且欄位須先由 [4] 加出來；[8][9][10] 建在
-- [1][2][3] 的表上；[11] 與其他段互不相依，故整體順序不可打散）。
-- 前提函式：sql/0018 forbid_hard_delete()、sql/0019 audit_row()、
-- sql/0027 set_updated_at() 已存在（前一輪已套用，見
-- docs/套用-2026-09-14-P1P3.sql）。
-- 驗證見 docs/驗證-2026-09-14-放款.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0041 — 新表 disbursement_allocations
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "disbursement_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"disbursement_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"subcontract_id" uuid,
	"subcontract_payment_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"withheld_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- [2] migration 0041 — 新表 disbursement_attachments
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "disbursement_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"disbursement_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"content_type" text,
	"uploaded_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- [3] migration 0041 — 新表 disbursements
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "disbursements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"disbursement_no" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payee_kind" text NOT NULL,
	"vendor_id" uuid,
	"payee_name" text NOT NULL,
	"payee_bank_name" text,
	"payee_bank_account" text,
	"paying_company_id" uuid NOT NULL,
	"paying_company_name" text,
	"paying_bank_account" text,
	"method" text NOT NULL,
	"paid_on" date,
	"amount" numeric(14, 2) NOT NULL,
	"withheld_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"receipt_issuer_company_id" uuid,
	"receipt_ref" text,
	"purpose" text,
	"note" text,
	"void_reason" text,
	"paid_by_emp_id" uuid,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- [4] migration 0041 — 既有表新增欄位
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "project_subcontract_payments" ADD COLUMN IF NOT EXISTS "disbursement_id" uuid;

ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "bank_name" text;
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "bank_code" text;
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "bank_account" text;
ALTER TABLE "vendors" ADD COLUMN IF NOT EXISTS "account_holder" text;

-- ─────────────────────────────────────────────────────────────────
-- [5] migration 0041 — 新表的 FK
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_subcontract_id_project_subcontracts_id_fk" FOREIGN KEY ("subcontract_id") REFERENCES "public"."project_subcontracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_subcontract_payment_id_project_subcontract_payments_id_fk" FOREIGN KEY ("subcontract_payment_id") REFERENCES "public"."project_subcontract_payments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_attachments" ADD CONSTRAINT "disbursement_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_attachments" ADD CONSTRAINT "disbursement_attachments_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_paying_company_id_companies_id_fk" FOREIGN KEY ("paying_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_receipt_issuer_company_id_companies_id_fk" FOREIGN KEY ("receipt_issuer_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [6] migration 0041 — 新表的 index
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "disbursement_allocations_tenant_payment_idx" ON "disbursement_allocations" USING btree ("tenant_id","subcontract_payment_id");
CREATE UNIQUE INDEX IF NOT EXISTS "disbursements_tenant_disbursement_no_uq" ON "disbursements" USING btree ("tenant_id","disbursement_no");
CREATE INDEX IF NOT EXISTS "disbursements_tenant_paid_on_idx" ON "disbursements" USING btree ("tenant_id","paid_on");
CREATE INDEX IF NOT EXISTS "disbursements_tenant_vendor_idx" ON "disbursements" USING btree ("tenant_id","vendor_id");
CREATE INDEX IF NOT EXISTS "disbursements_tenant_status_idx" ON "disbursements" USING btree ("tenant_id","status");

-- ─────────────────────────────────────────────────────────────────
-- [7] migration 0041 — 既有表新欄位的 FK（→ disbursements）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [8] sql/0029 — disbursements／disbursement_allocations／
--     disbursement_attachments 的 RLS
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.disbursements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disbursement_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disbursement_attachments ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────
-- [9] sql/0029 — 禁刪＋稽核＋updated_at trigger
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursements;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.disbursements
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.disbursements;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.disbursements
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.disbursements;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.disbursements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursement_allocations;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.disbursement_allocations
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.disbursement_allocations;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.disbursement_allocations
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS audit_all ON public.disbursement_attachments;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.disbursement_attachments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────
-- [10] sql/0029 — 合法值防呆 CHECK
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_status_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_status_chk
  CHECK (status IN ('draft', 'paid', 'void'));

ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_paid_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_paid_chk
  CHECK (status <> 'paid' OR paid_on IS NOT NULL);

ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_void_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_void_chk
  CHECK (status <> 'void' OR void_reason IS NOT NULL);

ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_amount_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_amount_chk
  CHECK (amount >= 0 AND withheld_amount >= 0);

ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_payee_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_payee_chk
  CHECK (payee_kind <> 'vendor' OR vendor_id IS NOT NULL);

ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_method_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_method_chk
  CHECK (method IN ('transfer', 'check', 'cash'));

ALTER TABLE public.disbursement_allocations
  DROP CONSTRAINT IF EXISTS disbursement_allocations_amount_chk;
ALTER TABLE public.disbursement_allocations
  ADD CONSTRAINT disbursement_allocations_amount_chk
  CHECK (amount > 0);

-- ─────────────────────────────────────────────────────────────────
-- [11] sql/0029 — storage bucket disbursement-vouchers（private，比照 0020）
-- ─────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('disbursement-vouchers', 'disbursement-vouchers', false)
on conflict (id) do nothing;

update storage.buckets
   set public = false
 where id = 'disbursement-vouchers'
   and public is distinct from false;

-- ── 還原（不可逆部分：新表刪除會連資料一起丟，先確認沒人用）────────────
-- delete from storage.objects where bucket_id = 'disbursement-vouchers';
-- delete from storage.buckets where id = 'disbursement-vouchers';
-- ALTER TABLE public.disbursement_allocations DROP CONSTRAINT IF EXISTS disbursement_allocations_amount_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_method_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_payee_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_amount_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_void_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_paid_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_status_chk;
-- DROP TRIGGER IF EXISTS audit_all ON public.disbursement_attachments;
-- DROP TRIGGER IF EXISTS audit_all ON public.disbursement_allocations;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursement_allocations;
-- DROP TRIGGER IF EXISTS set_updated_at ON public.disbursements;
-- DROP TRIGGER IF EXISTS audit_all ON public.disbursements;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursements;
-- ALTER TABLE "project_subcontract_payments" DROP CONSTRAINT IF EXISTS "project_subcontract_payments_disbursement_id_disbursements_id_fk";
-- ALTER TABLE "project_subcontract_payments" DROP COLUMN IF EXISTS disbursement_id;
-- ALTER TABLE "vendors" DROP COLUMN IF EXISTS bank_name, DROP COLUMN IF EXISTS bank_code, DROP COLUMN IF EXISTS bank_account, DROP COLUMN IF EXISTS account_holder;
-- DROP TABLE IF EXISTS public.disbursement_attachments;
-- DROP TABLE IF EXISTS public.disbursement_allocations;
-- DROP TABLE IF EXISTS public.disbursements;
-- （不 DISABLE RLS：一旦開了 anon/authenticated 就該一直被擋住。）
