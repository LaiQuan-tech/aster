ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
WITH contractor_contracts AS (
  SELECT id, tenant_id, project_id, supersedes_id
  FROM contracts
  WHERE deleted_at IS NULL AND doc_type = 'contract' AND our_role = 'contractor'
), leaves AS (
  SELECT contract.*
  FROM contractor_contracts contract
  WHERE NOT EXISTS (
    SELECT 1 FROM contractor_contracts child WHERE child.supersedes_id = contract.id
  )
), eligible AS (
  SELECT tenant_id, project_id, max(id::text)::uuid AS primary_id
  FROM leaves
  WHERE NOT EXISTS (
    SELECT 1 FROM contracts existing
    WHERE existing.tenant_id = leaves.tenant_id
      AND existing.project_id = leaves.project_id
      AND existing.is_primary = true
      AND existing.deleted_at IS NULL
  )
  GROUP BY tenant_id, project_id
  HAVING count(*) = 1
)
UPDATE contracts
SET is_primary = true
FROM eligible
WHERE contracts.id = eligible.primary_id;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contracts_active_primary_uq" ON "contracts" USING btree ("tenant_id","project_id") WHERE "contracts"."is_primary" = true AND "contracts"."deleted_at" IS NULL;
