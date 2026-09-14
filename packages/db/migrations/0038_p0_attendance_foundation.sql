CREATE TABLE "tenant_calendar_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"date" date NOT NULL,
	"day_type" text NOT NULL,
	"label" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_days" ADD COLUMN "leave_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD COLUMN "leave_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD COLUMN "outing_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_days" ADD COLUMN "early_leave_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_types" ADD COLUMN "deduct_rate" numeric(3, 2);--> statement-breakpoint
ALTER TABLE "punch_records" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "timezone" text DEFAULT 'Asia/Taipei' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_calendar_days" ADD CONSTRAINT "tenant_calendar_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_calendar_days_tenant_date_uq" ON "tenant_calendar_days" USING btree ("tenant_id","date");