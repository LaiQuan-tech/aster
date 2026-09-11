ALTER TABLE "announcements" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "deleted_by_emp_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "delete_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcements" ADD CONSTRAINT "announcements_deleted_by_emp_id_employees_id_fk" FOREIGN KEY ("deleted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
