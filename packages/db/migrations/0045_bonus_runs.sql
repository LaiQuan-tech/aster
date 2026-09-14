CREATE TABLE "bonus_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"share_mode" text NOT NULL,
	"share_pct" numeric(6, 3),
	"share_amount" numeric(14, 2),
	"bonus_pool" numeric(14, 2),
	"contract_total" numeric(14, 2),
	"received_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"received_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"entitled_cumulative" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paid_before" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"overpaid" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonus_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"as_of" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"paid_on" date,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb,
	"note" text,
	"created_by_emp_id" uuid,
	"paid_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_emp_id" uuid,
	"delete_reason" text
);
--> statement-breakpoint
ALTER TABLE "bonus_run_items" ADD CONSTRAINT "bonus_run_items_run_id_bonus_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."bonus_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_run_items" ADD CONSTRAINT "bonus_run_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_run_items" ADD CONSTRAINT "bonus_run_items_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_created_by_emp_id_employees_id_fk" FOREIGN KEY ("created_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_paid_by_emp_id_employees_id_fk" FOREIGN KEY ("paid_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_deleted_by_emp_id_employees_id_fk" FOREIGN KEY ("deleted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_run_items_run_project_employee_uq" ON "bonus_run_items" USING btree ("run_id","project_id","employee_id");--> statement-breakpoint
CREATE INDEX "bonus_run_items_tenant_employee_idx" ON "bonus_run_items" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE INDEX "bonus_run_items_tenant_project_idx" ON "bonus_run_items" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bonus_runs_tenant_label_uq" ON "bonus_runs" USING btree ("tenant_id","label") WHERE "bonus_runs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "bonus_runs_tenant_status_idx" ON "bonus_runs" USING btree ("tenant_id","status");