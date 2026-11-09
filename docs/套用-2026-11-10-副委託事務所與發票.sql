-- 2026-11-10 副委託類型加「事務所」＋代扣日期／發票號碼／發票日期（migration 0089 ＝ sql/0079）。
-- 前提：已套 0088（sql/0078，docs/套用-2026-11-10-薪資投保歷程.sql）。純新增、冪等、包在交易內；不動既有資料
--   （新欄位既有列一律 NULL；kind CHECK 只是放寬集合）。
-- 套用前就部署的 API 會降級：沒有新欄位時讀取回 null、寫入略過新欄位；類型選「事務所」回 409 migration_required（不 500）。
-- 套用後跑 docs/驗證-2026-11-10-副委託事務所與發票.sql。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62 --seed docs/test/replay-seed-2026-11-10-subcontract-firm.sql
--   docs/套用-2026-11-10-副委託事務所與發票.sql --verify docs/驗證-2026-11-10-副委託事務所與發票.sql` 在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
--   （本檔只依賴 tenants／projects／project_subcontracts（sql/0028 的 kind CHECK），base 到 sql/0062 即具備。）
BEGIN;

-- 2026-11-10 專案頁「副委託與協力技師」：類型加「事務所」(firm)，並依類型記代扣日期或發票：
--   1. project_subcontracts.kind 允許 'firm'（事務所＝執行業務所得，顯示代扣率＋代扣日期）。
--      CHECK 照 sql/0028 的 DROP IF EXISTS＋ADD 重建（放寬集合）：既有列只可能是 subcontract／technician，新約束必定成立。
--   2. withholding_date date：代扣日期（只有 firm 用；其他類型由 API 存 NULL）。
--   3. invoice_no text（≤40）、invoice_date date：發票號碼／發票日期（firm 以外用；firm 由 API 存 NULL）。
-- 前提：已套到 0088（sql/0078）。純新增、可重跑（IF NOT EXISTS／DROP CONSTRAINT IF EXISTS）；不動既有資料。
ALTER TABLE public.project_subcontracts ADD COLUMN IF NOT EXISTS withholding_date date;
ALTER TABLE public.project_subcontracts ADD COLUMN IF NOT EXISTS invoice_no text;
ALTER TABLE public.project_subcontracts ADD COLUMN IF NOT EXISTS invoice_date date;

-- CHECK 重建：交易內 lock_timeout 5s（拿不到鎖就失敗重跑，不卡住線上寫入）＋ NOT VALID 加約束（只短暫持鎖、不掃表）
-- ＋ VALIDATE CONSTRAINT 另行驗證既有列（只需 SHARE UPDATE EXCLUSIVE，不擋讀寫）。DROP IF EXISTS 讓整段可重跑。
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_kind_chk;
ALTER TABLE public.project_subcontracts ADD CONSTRAINT project_subcontracts_kind_chk
  CHECK (kind IN ('subcontract', 'technician', 'firm')) NOT VALID;
ALTER TABLE public.project_subcontracts VALIDATE CONSTRAINT project_subcontracts_kind_chk;

ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_invoice_no_chk;
ALTER TABLE public.project_subcontracts ADD CONSTRAINT project_subcontracts_invoice_no_chk
  CHECK (invoice_no IS NULL OR char_length(invoice_no) <= 40) NOT VALID;
ALTER TABLE public.project_subcontracts VALIDATE CONSTRAINT project_subcontracts_invoice_no_chk;

COMMIT;
