CREATE TABLE IF NOT EXISTS "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"our_role" text DEFAULT 'contractor' NOT NULL,
	"title" text NOT NULL,
	"counterparty" text,
	"amount" numeric,
	"signed_on" date,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"copies" integer DEFAULT 1 NOT NULL,
	"stamp_duty_required" text DEFAULT 'auto' NOT NULL,
	"stamp_duty_rate" numeric,
	"stamp_duty_amount" numeric,
	"stamp_duty_paid_on" date,
	"stamp_duty_note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_emp_id" uuid,
	"delete_reason" text
);
--> statement-breakpoint
ALTER TABLE "project_documents" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "stamp_duty_rate" numeric DEFAULT '0.001' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "stamp_duty_lookback_years" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contracts" ADD CONSTRAINT "contracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_project_idx" ON "contracts" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contracts_signed_idx" ON "contracts" USING btree ("tenant_id","signed_on");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
