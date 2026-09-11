CREATE TABLE IF NOT EXISTS "announcement_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text DEFAULT 'consent_to_change' NOT NULL,
	"viewed_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signature_sheet_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcement_signature_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"sheet_no" integer NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"content_type" text,
	"content_hash" text,
	"note" text,
	"uploaded_by_emp_id" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcement_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"change_type" text DEFAULT 'initial' NOT NULL,
	"change_note" text,
	"effective_from" date,
	"effective_to" date,
	"requires_signature" boolean DEFAULT false NOT NULL,
	"is_adverse_change" boolean DEFAULT false NOT NULL,
	"content_hash" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"table_name" text NOT NULL,
	"record_id" uuid,
	"action" text NOT NULL,
	"old_row" jsonb,
	"new_row" jsonb,
	"actor_emp_id" uuid,
	"db_user" text,
	"context" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_acknowledgements" ADD CONSTRAINT "announcement_acknowledgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_acknowledgements" ADD CONSTRAINT "announcement_acknowledgements_version_id_announcement_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."announcement_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_acknowledgements" ADD CONSTRAINT "announcement_acknowledgements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_acknowledgements" ADD CONSTRAINT "announcement_acknowledgements_signature_sheet_id_announcement_signature_sheets_id_fk" FOREIGN KEY ("signature_sheet_id") REFERENCES "public"."announcement_signature_sheets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_signature_sheets" ADD CONSTRAINT "announcement_signature_sheets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_signature_sheets" ADD CONSTRAINT "announcement_signature_sheets_version_id_announcement_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."announcement_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_signature_sheets" ADD CONSTRAINT "announcement_signature_sheets_uploaded_by_emp_id_employees_id_fk" FOREIGN KEY ("uploaded_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_created_by_emp_id_employees_id_fk" FOREIGN KEY ("created_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "announcement_acks_version_employee_uq" ON "announcement_acknowledgements" USING btree ("tenant_id","version_id","employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcement_acks_tenant_employee_signed_idx" ON "announcement_acknowledgements" USING btree ("tenant_id","employee_id","signed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "announcement_sheets_version_sheet_uq" ON "announcement_signature_sheets" USING btree ("tenant_id","version_id","sheet_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "announcement_versions_ann_version_uq" ON "announcement_versions" USING btree ("tenant_id","announcement_id","version_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcement_versions_tenant_effective_idx" ON "announcement_versions" USING btree ("tenant_id","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_table_record_idx" ON "audit_logs" USING btree ("tenant_id","table_name","record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_at_idx" ON "audit_logs" USING btree ("tenant_id","at");