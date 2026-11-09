-- 2026-11-10 專案頁「副委託與協力技師」：類型加「事務所」(firm)，並依類型記代扣日期或發票：
--   1. project_subcontracts.kind 允許 'firm'（事務所＝執行業務所得，顯示代扣率＋代扣日期）。
--      CHECK 照 sql/0028 的 DROP IF EXISTS＋ADD 重建（放寬集合）：既有列只可能是 subcontract／technician，新約束必定成立。
--   2. withholding_date date：代扣日期（只有 firm 用；其他類型由 API 存 NULL）。
--   3. invoice_no text（≤40）、invoice_date date：發票號碼／發票日期（firm 以外用；firm 由 API 存 NULL）。
-- 前提：已套到 0088（sql/0078）。純新增、可重跑（IF NOT EXISTS／DROP CONSTRAINT IF EXISTS）；不動既有資料。
BEGIN;

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
