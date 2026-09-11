CREATE TABLE IF NOT EXISTS "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"nature" text DEFAULT 'reimbursement' NOT NULL,
	"requires_receipt" boolean DEFAULT true NOT NULL,
	"cross_check_attendance" boolean DEFAULT false NOT NULL,
	"monthly_cap" numeric,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense_claim_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"content_type" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"nature" text DEFAULT 'reimbursement' NOT NULL,
	"amount" numeric NOT NULL,
	"incurred_on" date NOT NULL,
	"period" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"status_reason" text,
	"settlement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expense_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reimbursement_total" numeric DEFAULT '0' NOT NULL,
	"allowance_total" numeric DEFAULT '0' NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"note" text,
	"settled_by_emp_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_claim_attachments" ADD CONSTRAINT "expense_claim_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_claim_attachments" ADD CONSTRAINT "expense_claim_attachments_claim_id_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_settlement_id_expense_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."expense_settlements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_settlements" ADD CONSTRAINT "expense_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_settlements" ADD CONSTRAINT "expense_settlements_settled_by_emp_id_employees_id_fk" FOREIGN KEY ("settled_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "expense_categories_tenant_code_uq" ON "expense_categories" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_claim_attachments_tenant_claim_idx" ON "expense_claim_attachments" USING btree ("tenant_id","claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_claims_tenant_period_status_idx" ON "expense_claims" USING btree ("tenant_id","period","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expense_claims_tenant_employee_incurred_idx" ON "expense_claims" USING btree ("tenant_id","employee_id","incurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "expense_settlements_tenant_period_uq" ON "expense_settlements" USING btree ("tenant_id","period");