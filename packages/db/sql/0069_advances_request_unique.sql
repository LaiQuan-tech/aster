-- 2026-10-27 預支單一申請單唯一：advances(request_id) 加唯一索引 advances_request_id_uq。
-- 起因（驗收）：零用金／出差單最後一關若兩人幾乎同時核准，ledger.openAdvance「先查再插」擋不住，
-- 可能開出兩筆預支（同一張單兩倍的錢）。簽核端已加「仍為 pending」條件（只會有一人成功），
-- 本索引是 DB 層的最後一道：第二筆 insert 撞 23505，API 視為已開過（冪等），不 500。
-- request_id 是 NOT NULL，故不需 partial（WHERE request_id IS NOT NULL 等價，保留以防日後放寬）。
-- 已有重複資料時建索引會失敗——正式庫請走 docs/套用-2026-10-27-預支單一申請單唯一.sql（先檢查、有重複就中止）。
-- 不動 policy；寫入一律經 API（service role）。可重跑（IF NOT EXISTS）。API 在索引未套用前照舊運作。
CREATE UNIQUE INDEX IF NOT EXISTS advances_request_id_uq ON public.advances (request_id)
  WHERE request_id IS NOT NULL;
