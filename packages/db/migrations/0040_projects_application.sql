CREATE TABLE "clients" (
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
--> statement-breakpoint
CREATE TABLE "companies" (
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
--> statement-breakpoint
CREATE TABLE "project_subcontract_payments" (
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
--> statement-breakpoint
CREATE TABLE "project_subcontracts" (
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
--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "project_billings" ADD COLUMN "invoice_no" text;--> statement-breakpoint
ALTER TABLE "project_billings" ADD COLUMN "invoiced_on" date;--> statement-breakpoint
ALTER TABLE "project_billings" ADD COLUMN "received_on" date;--> statement-breakpoint
ALTER TABLE "project_billings" ADD COLUMN "received_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "project_billings" ADD COLUMN "kind" text DEFAULT 'installment' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "code_prefix" text DEFAULT 'AT' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "code_year_style" text DEFAULT 'roc' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "code_seq_digits" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "vat_rate" numeric(5, 4) DEFAULT '0.05' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "disciplines" jsonb DEFAULT '["電機","空調","消防","汙水"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "parent_project_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "reserved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "site_address" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "site_area_m2" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "design_scope" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "invoice_type" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "payment_method" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closing_day" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "payment_day" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "other_expenses" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "engineers" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_subcontract_id_project_subcontracts_id_fk" FOREIGN KEY ("subcontract_id") REFERENCES "public"."project_subcontracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_paying_company_id_companies_id_fk" FOREIGN KEY ("paying_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD CONSTRAINT "project_subcontract_payments_receipt_issuer_company_id_companies_id_fk" FOREIGN KEY ("receipt_issuer_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clients_tenant_name_idx" ON "clients" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_tax_id_uq" ON "clients" USING btree ("tenant_id","tax_id") WHERE "clients"."tax_id" is not null and "clients"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_tenant_name_uq" ON "companies" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_subcontract_payments_subcontract_installment_uq" ON "project_subcontract_payments" USING btree ("subcontract_id","installment_no");--> statement-breakpoint
CREATE INDEX "project_subcontracts_tenant_project_idx" ON "project_subcontracts" USING btree ("tenant_id","project_id");--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;