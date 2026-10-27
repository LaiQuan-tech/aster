-- =====================================================================
-- 2026-10-27 放款單草稿編輯人（migration 0080 ＝ sql/0070）
--
-- 內容：disbursements 加 edited_by_emp_ids uuid[] NOT NULL DEFAULT '{}'。
-- 目的（安全驗收 M2）：改過放款單草稿的人與建單人、送簽人一樣算「自己的單」——不能簽、不能改派這張單的任何一關。
--
-- 前提：已套到 0079（sql/0069）。整份可重跑（冪等），包在 BEGIN／COMMIT 交易裡（一錯全回滾）。
-- 只增欄位，既有列補成空陣列（之前的編輯紀錄不回補；之前的 PATCH 稽核在 audit_log，可人工對照）。
-- 順序：先部署 API 或先套本檔皆可。API 在欄位未套用前照舊運作（不記錄、不納入）。
-- 套用後跑 docs/驗證-2026-10-27-放款單草稿編輯人.sql。
-- =====================================================================

BEGIN;

ALTER TABLE public.disbursements
  ADD COLUMN IF NOT EXISTS edited_by_emp_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

COMMIT;

-- ── 還原 ────────────────────────────────────────────────────────────
-- ALTER TABLE public.disbursements DROP COLUMN IF EXISTS edited_by_emp_ids;
