CREATE TABLE IF NOT EXISTS "project_billings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"installment_no" integer NOT NULL,
	"percentage" numeric,
	"milestone" text,
	"planned_on" date,
	"calculated_amount" numeric,
	"residue_applied" numeric,
	"override_amount" numeric,
	"override_reason" text,
	"billed_on" date,
	"billed_amount" numeric,
	"note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_emp_id" uuid,
	"delete_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_billings" ADD CONSTRAINT "project_billings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_billings" ADD CONSTRAINT "project_billings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_billings_no_uq" ON "project_billings" USING btree ("tenant_id","project_id","installment_no") WHERE "project_billings"."deleted_at" is null;