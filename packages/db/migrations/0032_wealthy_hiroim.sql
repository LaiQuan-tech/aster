ALTER TABLE "projects" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status_effective_on" date;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "status_changed_by_emp_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;