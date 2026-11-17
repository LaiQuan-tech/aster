-- 2026-11-17 放款簽核關卡記錄「核准當下是否為老闆／platform_admin」（本檔 ＝ sql/0104；接 0113 ＝ sql/0103）。
--
-- 業主決定：「其他」收款（手動帳戶）的放款單必須由老闆或平台管理員核准才能付款。付款前改看核准當下寫入的
-- approved_as_boss 標記，而不是付款時的現在身分（之後被降權／升權都不影響當時的判斷）；舊紀錄（NULL）由 API fallback 現行判斷。
-- 純 DDL、可重跑；不動任何資料列。
ALTER TABLE public.disbursement_approval_steps ADD COLUMN IF NOT EXISTS approved_as_boss boolean;
