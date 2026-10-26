-- =====================================================================
-- 2026-10-28 客戶統編允許重複（migration 0078 ＝ sql/0068）
--
-- 前提：已套到 0076（sql/0066，docs/套用-2026-10-27-客供商欄位.sql）。整份可重跑（冪等），包在 BEGIN／COMMIT 交易裡（一錯全回滾）。
-- 套用後跑 docs/驗證-2026-10-28-客戶統編允許重複.sql。
-- 順序：先套本檔再部署（或同時）。沒套之前新 API 遇到同統編仍會撞唯一索引，回 409 tax_id_taken（舊行為），不會壞資料。
-- 註：0077（sql/0067）是另一批進行中的變更（專案公會還款）；本檔不依賴它，可先套。
-- =====================================================================

BEGIN;

-- 2026-10-28 客戶統編允許重複：業主確認同一統編可對應多個客戶名稱（例：同一家公司的不同對外名稱／分部），
-- 名冊要能各建一筆、統編都填。原本的 partial unique index clients_tenant_tax_id_uq（同租戶、未軟刪、有填統編者唯一）
-- 改為一般索引 clients_tenant_tax_id_idx（同樣條件），查詢效能不變。
-- API：POST／PATCH /clients 不再回 409 tax_id_taken，照常存檔並在回應附 warnings[{code:'tax_id_shared', clients}] 提示。
-- 依賴檢查：統編只用在名冊顯示、專案申請單列印、建案預填（都以 client_id 關聯，不以統編反查），沒有功能靠統編唯一。
-- 不動 policy；寫入一律經 API（service role）。前提：已套到 0076（sql/0066）。可重跑（DROP … IF EXISTS／IF NOT EXISTS）。
DROP INDEX IF EXISTS public.clients_tenant_tax_id_uq;
CREATE INDEX IF NOT EXISTS clients_tenant_tax_id_idx ON public.clients (tenant_id, tax_id)
  WHERE tax_id IS NOT NULL AND deleted_at IS NULL;

COMMIT;

-- ── 還原（先確認沒有同租戶重複統編，否則建唯一索引會失敗）──────────────
-- DROP INDEX IF EXISTS public.clients_tenant_tax_id_idx;
-- CREATE UNIQUE INDEX IF NOT EXISTS clients_tenant_tax_id_uq ON public.clients (tenant_id, tax_id) WHERE tax_id IS NOT NULL AND deleted_at IS NULL;
