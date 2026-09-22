ALTER TABLE "approval_steps" ADD COLUMN IF NOT EXISTS "candidate_emp_ids" uuid[];--> statement-breakpoint
ALTER TABLE "approval_steps" ADD COLUMN IF NOT EXISTS "step_kind" text;--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "manager_emp_ids" uuid[] DEFAULT '{}' NOT NULL;
