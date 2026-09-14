ALTER TABLE "clients" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "disbursements" ADD COLUMN "payee_bank_code" text;--> statement-breakpoint
ALTER TABLE "disbursements" ADD COLUMN "has_invoice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "disbursements" ADD COLUMN "invoice_no" text;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "settled_by_emp_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "settled_period" text;--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "requires_attachment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archive_reason" text;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_settled_by_emp_id_employees_id_fk" FOREIGN KEY ("settled_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_requests_tenant_settled_period_idx" ON "leave_requests" USING btree ("tenant_id","settled_period");