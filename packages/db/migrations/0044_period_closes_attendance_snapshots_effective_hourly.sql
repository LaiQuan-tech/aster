CREATE TABLE "attendance_sheet_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sheet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"period" text NOT NULL,
	"seq" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"rule_config_version" integer,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_by_emp_id" uuid,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "period_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'closed' NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by_emp_id" uuid,
	"sheet_count" integer DEFAULT 0 NOT NULL,
	"locked_count" integer DEFAULT 0 NOT NULL,
	"snapshot_manifest_path" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rule_configs" ADD COLUMN "effective_from" date DEFAULT '1900-01-01' NOT NULL;--> statement-breakpoint
ALTER TABLE "salary_adjustments" ADD COLUMN "changed_by_emp_id" uuid;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD COLUMN "agreed_hours_per_week" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "salary_structures" ADD COLUMN "agreed_days_per_week" numeric(3, 1);--> statement-breakpoint
ALTER TABLE "attendance_sheet_snapshots" ADD CONSTRAINT "attendance_sheet_snapshots_sheet_id_attendance_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."attendance_sheets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sheet_snapshots" ADD CONSTRAINT "attendance_sheet_snapshots_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sheet_snapshots" ADD CONSTRAINT "attendance_sheet_snapshots_taken_by_emp_id_employees_id_fk" FOREIGN KEY ("taken_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_closed_by_emp_id_employees_id_fk" FOREIGN KEY ("closed_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sheet_snapshots_tenant_sheet_seq_uq" ON "attendance_sheet_snapshots" USING btree ("tenant_id","sheet_id","seq");--> statement-breakpoint
CREATE INDEX "attendance_sheet_snapshots_tenant_employee_period_idx" ON "attendance_sheet_snapshots" USING btree ("tenant_id","employee_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "period_closes_tenant_period_uq" ON "period_closes" USING btree ("tenant_id","period");--> statement-breakpoint
ALTER TABLE "salary_adjustments" ADD CONSTRAINT "salary_adjustments_changed_by_emp_id_employees_id_fk" FOREIGN KEY ("changed_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;