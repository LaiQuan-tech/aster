-- 2026-10-27 放款單草稿編輯人：disbursements 加 edited_by_emp_ids uuid[]（NOT NULL DEFAULT '{}'）。
-- 起因（安全驗收 M2）：「自己的單不能簽」只認建單人＋送簽人——改過草稿（例如改收款帳號）的人不算申請人，
-- 送簽後仍能簽自己改過的單。API 在每次 PATCH 把操作者加進這個陣列，簽核／改派時一併視為「自己的單」。
-- 只增欄位、不動既有資料與 policy；寫入一律經 API（service role）。可重跑（IF NOT EXISTS）。
-- API 在欄位未套用前照舊運作（不記錄、不納入，退回只看建單人＋送簽人）。
ALTER TABLE public.disbursements
  ADD COLUMN IF NOT EXISTS edited_by_emp_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
