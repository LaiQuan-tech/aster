CREATE TABLE IF NOT EXISTS "trip_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_request_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"payout_channel" text,
	"paid_at" timestamp with time zone,
	"paid_by_emp_id" uuid,
	"actual_total" numeric,
	"balance" numeric,
	"balance_handling" text,
	"recovery_period" text,
	"settled_at" timestamp with time zone,
	"settled_by_emp_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN "requires_trip_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD COLUMN "trip_request_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "trip_scope" text;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "estimated_cost" numeric;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "advance_requested" numeric;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "trip_report" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_trip_request_id_leave_requests_id_fk" FOREIGN KEY ("trip_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_paid_by_emp_id_employees_id_fk" FOREIGN KEY ("paid_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trip_advances" ADD CONSTRAINT "trip_advances_settled_by_emp_id_employees_id_fk" FOREIGN KEY ("settled_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trip_advances_tenant_employee_status_idx" ON "trip_advances" USING btree ("tenant_id","employee_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trip_advances_tenant_recovery_period_idx" ON "trip_advances" USING btree ("tenant_id","recovery_period");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_trip_request_id_leave_requests_id_fk" FOREIGN KEY ("trip_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
