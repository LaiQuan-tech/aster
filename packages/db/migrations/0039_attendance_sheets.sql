CREATE TABLE "attendance_sheet_days" (
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
--> statement-breakpoint
CREATE TABLE "attendance_sheets" (
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
--> statement-breakpoint
ALTER TABLE "attendance_sheet_days" ADD CONSTRAINT "attendance_sheet_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sheet_days" ADD CONSTRAINT "attendance_sheet_days_sheet_id_attendance_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."attendance_sheets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sheet_days" ADD CONSTRAINT "attendance_sheet_days_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sheets" ADD CONSTRAINT "attendance_sheets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sheets" ADD CONSTRAINT "attendance_sheets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sheet_days_sheet_work_date_uq" ON "attendance_sheet_days" USING btree ("sheet_id","work_date");--> statement-breakpoint
CREATE INDEX "attendance_sheet_days_tenant_sheet_idx" ON "attendance_sheet_days" USING btree ("tenant_id","sheet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sheets_tenant_employee_period_uq" ON "attendance_sheets" USING btree ("tenant_id","employee_id","period");--> statement-breakpoint
CREATE INDEX "attendance_sheets_tenant_period_status_idx" ON "attendance_sheets" USING btree ("tenant_id","period","status");--> statement-breakpoint
CREATE UNIQUE INDEX "punch_records_request_dedupe_uidx" ON "punch_records" USING btree ("tenant_id","employee_id","type","punch_at") WHERE "punch_records"."request_id" is not null;