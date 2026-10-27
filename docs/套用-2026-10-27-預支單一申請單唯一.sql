-- =====================================================================
-- 2026-10-27 預支單一申請單唯一（migration 0079 ＝ sql/0069）
--
-- 內容：advances(request_id) 加唯一索引 advances_request_id_uq（WHERE request_id IS NOT NULL）。
-- 目的：零用金／出差單同時被兩人最終核准時，DB 層保證一張單最多一筆預支（API 撞 23505 視為已開過）。
--
-- 前提：已套到 0078（sql/0068）。整份可重跑（冪等），包在 BEGIN／COMMIT 交易裡（一錯全回滾）。
-- ⚠️ 先跑一次 docs/驗證-2026-10-27-預支單一申請單唯一.sql 第 1 段：若已有同一 request_id 多筆預支，
--    本檔會 RAISE EXCEPTION 中止、不建索引——那些重複列要先人工確認（哪筆已撥款／核銷）再處理，不要直接刪。
-- 順序：先部署 API 或先套本檔皆可。API 在索引未套用時照舊運作（先查再插；簽核端的 pending 條件已擋並發）。
-- 套用後跑 docs/驗證-2026-10-27-預支單一申請單唯一.sql。
-- =====================================================================

BEGIN;

-- 鎖住 advances 的寫入，避免「檢查完沒重複 → 建索引前又插進一筆重複」的空窗（讀取不受影響）。
LOCK TABLE public.advances IN SHARE MODE;

DO $$
DECLARE
  dup_groups int;
BEGIN
  SELECT count(*) INTO dup_groups
  FROM (
    SELECT request_id FROM public.advances
    WHERE request_id IS NOT NULL
    GROUP BY request_id
    HAVING count(*) > 1
  ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION 'advances 有 % 組 request_id 重複，未建唯一索引。請先跑驗證檔第 1 段列出明細、人工處理後再套。', dup_groups;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS advances_request_id_uq ON public.advances (request_id)
  WHERE request_id IS NOT NULL;

COMMIT;

-- ── 還原 ────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.advances_request_id_uq;
