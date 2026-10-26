-- 2026-10-26 打卡冪等：員工端 POST /punch 帶 clientRequestId（每次打卡一個，逾時重送沿用同一個）。
--   punch_records.client_request_id  該次打卡的請求 id；同員工已有同一個 id → API 回原本那筆（200），不新增。
--   唯一索引（tenant_id, employee_id, client_request_id，只含非 NULL）：兩個請求同時到時擋下第二筆。
-- 寫入一律經 API（service role）；讀取 policy 不動；audit trigger 整列 to_jsonb，新欄位自動入稽核。
-- 前提：已套到 0072（sql/0062）；若 0073（sql/0063，獎金執行簽核）已存在，請先套 0073 再套本檔。可重跑（IF NOT EXISTS）。
-- 欄位沒套時 API 降級為不去重、照常寫入，所以先套 SQL 或先部署程式都可以。
ALTER TABLE public.punch_records ADD COLUMN IF NOT EXISTS client_request_id text;
COMMENT ON COLUMN public.punch_records.client_request_id IS '員工端打卡的請求 id（逾時重送沿用同一個；同員工同 id 只會有一筆）；NULL＝舊資料／HR 補登（2026-10-26）';
CREATE UNIQUE INDEX IF NOT EXISTS punch_records_client_request_uq
  ON public.punch_records (tenant_id, employee_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
