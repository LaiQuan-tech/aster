CREATE TABLE "disbursement_allocations" (
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
--> statement-breakpoint
CREATE TABLE "disbursement_attachments" (
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
--> statement-breakpoint
CREATE TABLE "disbursements" (
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
--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD COLUMN "disbursement_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "bank_code" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "bank_account" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "account_holder" text;--> statement-breakpoint
ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_subcontract_id_project_subcontracts_id_fk" FOREIGN KEY ("subcontract_id") REFERENCES "public"."project_subcontracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_allocations" ADD CONSTRAINT "disbursement_allocations_subcontract_payment_id_project_subcontract_payments_id_fk" FOREIGN KEY ("subcontract_payment_id") REFERENCES "public"."project_subcontract_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_attachments" ADD CONSTRAINT "disbursement_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_attachments" ADD CONSTRAINT "disbursement_attachments_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_paying_company_id_companies_id_fk" FOREIGN KEY ("paying_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_receipt_issuer_company_id_companies_id_fk" FOREIGN KEY ("receipt_issuer_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disbursement_allocations_tenant_payment_idx" ON "disbursement_allocations" USING btree ("tenant_id","subcontract_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disbursements_tenant_disbursement_no_uq" ON "disbursements" USING btree ("tenant_id","disbursement_no");--> statement-breakpoint
CREATE INDEX "disbursements_tenant_paid_on_idx" ON "disbursements" USING btree ("tenant_id","paid_on");--> statement-breakpoint
CREATE INDEX "disbursements_tenant_vendor_idx" ON "disbursements" USING btree ("tenant_id","vendor_id");--> statement-breakpoint
CREATE INDEX "disbursements_tenant_status_idx" ON "disbursements" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;