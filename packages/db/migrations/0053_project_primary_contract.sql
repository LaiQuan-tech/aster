ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contracts_active_primary_uq" ON "contracts" USING btree ("tenant_id","project_id") WHERE "contracts"."is_primary" = true AND "contracts"."deleted_at" IS NULL;
