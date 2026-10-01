-- 主合約是專案合約金額的唯一來源；作廢後可以另立新的主合約。
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS contracts_active_primary_uq
  ON public.contracts (tenant_id, project_id)
  WHERE is_primary = true AND deleted_at IS NULL;
