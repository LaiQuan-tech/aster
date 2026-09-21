ALTER TABLE "bonus_runs" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "bonus_runs" ADD COLUMN IF NOT EXISTS "reverses_run_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bonus_runs_reverses_uq" ON "bonus_runs" USING btree ("reverses_run_id") WHERE "bonus_runs"."deleted_at" is null;