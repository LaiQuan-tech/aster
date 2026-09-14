ALTER TABLE "approval_flows" ADD COLUMN "mode" text DEFAULT 'list' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD COLUMN "acted_by_emp_id" uuid;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "opened_on" date;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_acted_by_emp_id_employees_id_fk" FOREIGN KEY ("acted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_user_id_uq" ON "employees" USING btree ("user_id") WHERE "employees"."user_id" is not null;