-- 2026-11-10 專案頁「副委託與協力技師」：類型加「事務所」(firm)，並依類型記代扣日期或發票：
--   1. project_subcontracts.kind 允許 'firm'（事務所＝執行業務所得，顯示代扣率＋代扣日期）。
--      CHECK 照 sql/0028 的 DROP IF EXISTS＋ADD 重建（放寬集合）：既有列只可能是 subcontract／technician，新約束必定成立。
--   2. withholding_date date：代扣日期（只有 firm 用；其他類型由 API 存 NULL）。
--   3. invoice_no text（≤40）、invoice_date date：發票號碼／發票日期（firm 以外用；firm 由 API 存 NULL）。
-- 前提：已套到 0088（sql/0078）。純新增、可重跑（IF NOT EXISTS／DROP CONSTRAINT IF EXISTS）；不動既有資料。
ALTER TABLE public.project_subcontracts ADD COLUMN IF NOT EXISTS withholding_date date;
ALTER TABLE public.project_subcontracts ADD COLUMN IF NOT EXISTS invoice_no text;
ALTER TABLE public.project_subcontracts ADD COLUMN IF NOT EXISTS invoice_date date;

ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_kind_chk;
ALTER TABLE public.project_subcontracts ADD CONSTRAINT project_subcontracts_kind_chk
  CHECK (kind IN ('subcontract', 'technician', 'firm'));

ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_invoice_no_chk;
ALTER TABLE public.project_subcontracts ADD CONSTRAINT project_subcontracts_invoice_no_chk
  CHECK (invoice_no IS NULL OR char_length(invoice_no) <= 40);
