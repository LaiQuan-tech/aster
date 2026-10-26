-- 2026-10-27 客供商名冊欄位對齊 Excel（「客供商基本資料」）：業主要求後台名冊的欄位與 Excel 一致，
-- 10/12 匯入時系統沒有的欄位擠在備註，這裡補上對應欄位（資料搬遷另由 docs/test/roster-excel-fields-migrate.ts 產生，不在本檔）。
--   vendors（Excel「供應商資料」「技師資料」「送審相關單位」三個工作表，欄位相同）：
--     roster_kind   text NOT NULL DEFAULT 'supplier'  名冊類別＝工作表：'supplier' 供應商 | 'engineer' 技師 | 'review_unit' 送審相關單位
--     seq           integer  序
--     sub_category  text     細目（category 改放 Excel「類別」）
--     code          text     編號
--     fax           text     FAX
--     payment_terms text     付款方式（自由文字，例：現金、月結）
--   clients（Excel「客戶資料」）：
--     seq     integer  序
--     region  text     區域
--     code    text     編號
--   backfill：只在「本次才新增 roster_kind」時跑一次——10/12 匯入把工作表寫在 category 前綴
--     （「技師／…」「送審單位／…」），據此標 engineer／review_unit，其餘維持預設 supplier。
--   Excel 的帳號、密碼、登入網址類內容不建欄位（憑證不進名冊）。
-- 寫入一律經 API（service role）；不新增直接寫入 policy，讀取 policy 不動；audit trigger 整列 to_jsonb，新欄位自動入稽核。
-- 前提：已套到 0075（sql/0065）。可重跑（IF NOT EXISTS／DROP … IF EXISTS）。
-- 欄位沒套時 API 降級：GET 不回新欄位（roster_kind 一律當 supplier）、寫入帶新欄位非空值回 409 migration_required。

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'roster_kind'
  ) THEN
    ALTER TABLE public.vendors ADD COLUMN roster_kind text NOT NULL DEFAULT 'supplier';
    UPDATE public.vendors SET roster_kind = 'engineer' WHERE category LIKE '技師／%';
    UPDATE public.vendors SET roster_kind = 'review_unit' WHERE category LIKE '送審單位／%';
  END IF;
END $mig$;

ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS seq integer;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS sub_category text;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS fax text;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS payment_terms text;

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS seq integer;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS code text;

ALTER TABLE public.vendors DROP CONSTRAINT IF EXISTS vendors_roster_kind_chk;
ALTER TABLE public.vendors ADD CONSTRAINT vendors_roster_kind_chk
  CHECK (roster_kind IN ('supplier', 'engineer', 'review_unit'));

COMMENT ON COLUMN public.vendors.roster_kind IS '名冊類別（Excel 工作表）：supplier 供應商資料 | engineer 技師資料 | review_unit 送審相關單位（2026-10-27）';
COMMENT ON COLUMN public.vendors.seq IS 'Excel「序」（2026-10-27）';
COMMENT ON COLUMN public.vendors.sub_category IS 'Excel「細目」；category＝Excel「類別」（2026-10-27）';
COMMENT ON COLUMN public.vendors.code IS 'Excel「編號」（2026-10-27）';
COMMENT ON COLUMN public.vendors.fax IS 'Excel「FAX」（2026-10-27）';
COMMENT ON COLUMN public.vendors.payment_terms IS 'Excel「付款方式」，自由文字（2026-10-27）';
COMMENT ON COLUMN public.clients.seq IS 'Excel「序」（2026-10-27）';
COMMENT ON COLUMN public.clients.region IS 'Excel「區域」（2026-10-27）';
COMMENT ON COLUMN public.clients.code IS 'Excel「編號」（2026-10-27）';
