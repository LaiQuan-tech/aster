CREATE TABLE IF NOT EXISTS "birthday_gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"given_on" date,
	"amount" numeric(12, 2),
	"photo_path" text,
	"photo_file_name" text,
	"note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "disbursement_approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"disbursement_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"step_order" integer NOT NULL,
	"approver_emp_id" uuid NOT NULL,
	"candidate_emp_ids" uuid[],
	"step_kind" text,
	"decision" text DEFAULT 'pending' NOT NULL,
	"comment" text,
	"acted_at" timestamp with time zone,
	"acted_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "duty_rosters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"duty_type" text NOT NULL,
	"work_date" date NOT NULL,
	"employee_id" uuid NOT NULL,
	"batch_id" uuid,
	"note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_profile_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_by_emp_id" uuid,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_emp_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "festival_bonuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"festival" text NOT NULL,
	"year" integer NOT NULL,
	"reference_date" date,
	"suggested_amount" numeric(14, 2),
	"prorate_months" integer,
	"final_amount" numeric(14, 2),
	"status" text DEFAULT 'draft' NOT NULL,
	"paid_on" date,
	"note" text,
	"created_by_emp_id" uuid,
	"paid_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "overtime_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"period" text NOT NULL,
	"source" text DEFAULT 'beyond_cap' NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"amount" numeric(14, 2),
	"channel" text DEFAULT 'cash' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"paid_on" date,
	"sheet_id" uuid,
	"note" text,
	"created_by_emp_id" uuid,
	"paid_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "leave_balances_tenant_emp_type_year_uq";--> statement-breakpoint
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "current_step" integer;--> statement-breakpoint
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "approval_round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "submitted_by_emp_id" uuid;--> statement-breakpoint
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "period_start" date;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "period_end" date;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "note" text;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "beyond_cap" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "beyond_cap_detail" jsonb;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "sent_to" text;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN IF NOT EXISTS "default_share_pct_by_role" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD COLUMN IF NOT EXISTS "accepted_on" date;--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD COLUMN IF NOT EXISTS "accepted_by_emp_id" uuid;--> statement-breakpoint
ALTER TABLE "project_subcontract_payments" ADD COLUMN IF NOT EXISTS "acceptance_note" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "birthday_gifts" ADD CONSTRAINT "birthday_gifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "birthday_gifts" ADD CONSTRAINT "birthday_gifts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disbursement_approval_steps" ADD CONSTRAINT "disbursement_approval_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disbursement_approval_steps" ADD CONSTRAINT "disbursement_approval_steps_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disbursement_approval_steps" ADD CONSTRAINT "disbursement_approval_steps_approver_emp_id_employees_id_fk" FOREIGN KEY ("approver_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "disbursement_approval_steps" ADD CONSTRAINT "disbursement_approval_steps_acted_by_emp_id_employees_id_fk" FOREIGN KEY ("acted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_profile_change_requests" ADD CONSTRAINT "employee_profile_change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_profile_change_requests" ADD CONSTRAINT "employee_profile_change_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "festival_bonuses" ADD CONSTRAINT "festival_bonuses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "festival_bonuses" ADD CONSTRAINT "festival_bonuses_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "overtime_settlements" ADD CONSTRAINT "overtime_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "overtime_settlements" ADD CONSTRAINT "overtime_settlements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "birthday_gifts_tenant_emp_year_uq" ON "birthday_gifts" USING btree ("tenant_id","employee_id","year");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "disbursement_approval_steps_disb_round_step_uq" ON "disbursement_approval_steps" USING btree ("disbursement_id","round","step_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "disbursement_approval_steps_tenant_disb_idx" ON "disbursement_approval_steps" USING btree ("tenant_id","disbursement_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "duty_rosters_tenant_type_date_uq" ON "duty_rosters" USING btree ("tenant_id","duty_type","work_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "duty_rosters_tenant_date_idx" ON "duty_rosters" USING btree ("tenant_id","work_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_profile_change_requests_tenant_status_idx" ON "employee_profile_change_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "festival_bonuses_tenant_emp_festival_year_uq" ON "festival_bonuses" USING btree ("tenant_id","employee_id","festival","year");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "overtime_settlements_beyond_cap_uq" ON "overtime_settlements" USING btree ("tenant_id","employee_id","period") WHERE "overtime_settlements"."source" = 'beyond_cap';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "overtime_settlements_tenant_period_idx" ON "overtime_settlements" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leave_balances_tenant_emp_type_period_uq" ON "leave_balances" USING btree ("tenant_id","employee_id","leave_type_id","period_start");
