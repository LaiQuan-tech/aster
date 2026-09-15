-- =====================================================================
-- 亞斯特 — 2026-09-16 正式租戶（0507ad78）清除 demo seed 業務資料【B：demo 專案與放款】
--
-- 業主 9/16 決定「全部刪光」：專案 8（AT-115-001～007、007-1）、合約 8、期款 18、
-- 副委託 3＋付款 4、放款 D-115-001～003（含分攤 3、憑證 1）、客戶 7、廠商 2、公司主體 3
-- （後來要求保留／重建「亞斯特設計顧問有限公司」→ 該列原樣保留，只刪龍權、紅爐）。
-- sql/0030 的 no_hard_delete_unless_draft 只允許刪「草稿」放款單的分攤列，demo 放款單有兩張是
-- paid → 要先在同一交易內把它們退回 draft 才刪得掉。已於 2026-09-16 經 Management API 套用完成。
-- 同一交易：先把租戶切成 demo（sql/0018 forbid_hard_delete 只放行 test/demo）→ 刪 → 切回 active。
-- Storage 裡的憑證檔（disbursement-vouchers，1 個 png）已於 9/16 用 service role 刪掉，這裡不用管。
-- 冪等：可重複執行。
-- =====================================================================

DO $$
DECLARE
  t uuid := '0507ad78-27f4-480e-b99f-a72db2aee50c';
BEGIN
  IF (SELECT status FROM public.tenants WHERE id = t) <> 'active' THEN
    RAISE EXCEPTION 'tenant % is not active', t;
  END IF;
  UPDATE public.tenants SET status = 'demo' WHERE id = t;

  -- 獎金／分潤（若 A 檔已跑過，這裡是 0 列）
  DELETE FROM public.bonus_run_items           WHERE tenant_id = t;
  DELETE FROM public.bonus_runs                WHERE tenant_id = t;
  DELETE FROM public.project_share_adjustments WHERE tenant_id = t;
  DELETE FROM public.project_members           WHERE tenant_id = t;

  -- 放款：paid／void 先退回 draft，分攤列才過得了 no_hard_delete_unless_draft。
  -- FK 是環狀的：allocations.subcontract_payment_id → 副委託付款列、副委託付款列.disbursement_id → 放款單，
  -- 所以順序固定為 分攤列 → 副委託付款列 → 放款單。
  UPDATE public.disbursements SET status = 'draft' WHERE tenant_id = t AND status <> 'draft';
  DELETE FROM public.disbursement_attachments  WHERE tenant_id = t;
  DELETE FROM public.disbursement_allocations  WHERE tenant_id = t;
  DELETE FROM public.project_subcontract_payments WHERE tenant_id = t;
  DELETE FROM public.disbursements             WHERE tenant_id = t;

  -- 專案（子案先刪）
  DELETE FROM public.project_subcontracts      WHERE tenant_id = t;
  DELETE FROM public.project_billings          WHERE tenant_id = t;
  DELETE FROM public.contracts                 WHERE tenant_id = t;
  DELETE FROM public.project_documents         WHERE tenant_id = t;
  DELETE FROM public.projects                  WHERE tenant_id = t AND parent_project_id IS NOT NULL;
  DELETE FROM public.projects                  WHERE tenant_id = t;
  DELETE FROM public.company_pages             WHERE tenant_id = t;
  DELETE FROM public.clients                   WHERE tenant_id = t;
  DELETE FROM public.vendors                   WHERE tenant_id = t;
  -- 公司主體：業主 9/16 要求保留／重建「亞斯特設計顧問有限公司」，該列有真實統編且是預設主體，
  -- 直接留著（同 id、同統編），只刪另外兩個 demo 主體（龍權、紅爐）
  DELETE FROM public.companies                 WHERE tenant_id = t
     AND NOT (name = '亞斯特設計顧問有限公司' AND is_default);

  UPDATE public.tenants SET status = 'active' WHERE id = t;
END $$;

-- 驗證（逐句）：
-- SELECT status FROM public.tenants WHERE id = '0507ad78-27f4-480e-b99f-a72db2aee50c';        -- active
-- SELECT count(*) FROM public.projects      WHERE tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'; -- 0
-- SELECT count(*) FROM public.disbursements WHERE tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'; -- 0
