-- =====================================================================
-- 0022  contracts 納入禁刪與稽核（模組四第 3 條）
--
-- `contracts` 是經手金額的表，而且是**稅務憑證的索引**：
-- 已貼花的合約被實體刪除，等於把「這筆稅貼過了」的證據一起刪掉，
-- 而印花稅的核課期間最長 7 年（稅捐稽徵法 §21），追徵時拿不出東西。
--
-- 比照 sql/0018 / sql/0019 的既有做法：
--   • no_hard_delete —— 實體刪除一律擋下（test/demo 租戶除外），API 只做軟刪除
--   • audit_all      —— INSERT/UPDATE/DELETE 全量留痕
--
-- project_settings 的印花稅參數同樣要留痕（費率改了會改變試算結果），
-- 但它已在本批 [5] 段掛上 audit_all，這裡不重複。
--
-- 套用方式：Supabase SQL Editor。
-- 冪等：DROP IF EXISTS + CREATE，可重複執行。
-- 前提：sql/0018 的 forbid_hard_delete() 與 sql/0019 的 audit_row() 已存在。
-- =====================================================================

DROP TRIGGER IF EXISTS no_hard_delete ON public.contracts;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.contracts;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── 合法值防呆 ──────────────────────────────────────────────────────
-- doc_type 與 our_role 一起決定課不課印花稅，打錯就是漏稅或溢繳。
ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_doc_type_chk;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_doc_type_chk
  CHECK (doc_type IN ('contract', 'quotation', 'change_order'));

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_our_role_chk;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_our_role_chk
  CHECK (our_role IN ('contractor', 'client'));

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_stamp_flag_chk;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_stamp_flag_chk
  CHECK (stamp_duty_required IN ('auto', 'yes', 'no'));

-- ── 還原 ────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.contracts;
-- DROP TRIGGER IF EXISTS audit_all      ON public.contracts;
-- ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_doc_type_chk;
-- ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_our_role_chk;
-- ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_stamp_flag_chk;
