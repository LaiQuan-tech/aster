ALTER TABLE "projects" ADD COLUMN "fiscal_year" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_tenant_code_uq" ON "projects" USING btree ("tenant_id","code");