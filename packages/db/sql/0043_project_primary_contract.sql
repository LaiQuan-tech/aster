-- 主合約是專案合約金額的唯一來源；作廢後可以另立新的主合約。
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

WITH contractor_contracts AS (
  SELECT id, tenant_id, project_id, supersedes_id
  FROM public.contracts
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
    SELECT 1 FROM public.contracts existing
    WHERE existing.tenant_id = leaves.tenant_id
      AND existing.project_id = leaves.project_id
      AND existing.is_primary = true
      AND existing.deleted_at IS NULL
  )
  GROUP BY tenant_id, project_id
  HAVING count(*) = 1
)
UPDATE public.contracts
SET is_primary = true
FROM eligible
WHERE contracts.id = eligible.primary_id;

CREATE UNIQUE INDEX IF NOT EXISTS contracts_active_primary_uq
  ON public.contracts (tenant_id, project_id)
  WHERE is_primary = true AND deleted_at IS NULL;
