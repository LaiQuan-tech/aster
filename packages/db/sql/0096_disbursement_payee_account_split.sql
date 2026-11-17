-- 2026-11-17 放款單收款帳號與戶名分欄儲存＋收緊 vendors／disbursements 對 anon／authenticated 的表權限
-- （本檔 ＝ migrations/0106；接 sql/0095）。
--
-- 1. disbursements.payee_bank_account_number／payee_account_holder：帳號（NFKC、去空白與連字號，只含數字）與戶名分開存，
--    不再靠解析「帳號 戶名」字串（驗收：「12345678 7-11」「1234＋5678 9012 王」這類無法從單一字串正確拆開）。
--    舊欄 payee_bank_account 照舊寫「帳號 戶名」快照，供匯出與既有讀取相容；讀取時分欄優先、分欄為空才解析舊快照。
--    不回填（套用時正式庫放款單 0 張）。
-- 2. 驗收 H3：vendors 與 disbursements 已開 RLS 且沒有任何 policy（anon／authenticated 讀寫列都被擋），
--    但表權限仍給 anon／authenticated INSERT／UPDATE／DELETE／TRUNCATE 等（TRUNCATE 不受 RLS 管）。
--    收回寫入類權限（API 一律以 service_role 存取）；SELECT 保留（RLS 無 policy＝讀不到任何列）。
-- 純 DDL、可重跑；不動任何資料列。

ALTER TABLE public.disbursements ADD COLUMN IF NOT EXISTS payee_bank_account_number text;
ALTER TABLE public.disbursements ADD COLUMN IF NOT EXISTS payee_account_holder text;
DO $$ BEGIN
  ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_payee_bank_account_number_chk
    CHECK (payee_bank_account_number IS NULL OR payee_bank_account_number ~ '^[0-9]{1,40}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_payee_account_holder_chk
    CHECK (payee_account_holder IS NULL OR (char_length(payee_account_holder) <= 120 AND payee_account_holder !~ '[[:cntrl:]]'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.vendors FROM anon, authenticated;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.disbursements FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
