-- =====================================================================
-- docs/test/seed-test/cleanup/10-finance.sql — 清掉 10-finance 建的測試資料（片段）
--
-- ⚠️ 這不是完整可執行的 SQL：它是外層 DO block 的「片段」（外層形狀見
-- cleanup/00-base.sql 檔頭），假設外層已宣告：
--   t        uuid   := 租戶 id
--   test_emp uuid[] := 三位測試員工 id（employees.name LIKE '【測試】%'）
-- 且 tenants.status 已切成 'demo'（sql/0018 forbid_hard_delete／0034
-- forbid_paid_bonus_mutation 都以 is_disposable_tenant(tenant_id) 放行）。
-- 本片段要在 00-base 片段「之前」跑（它會刪 employees，而 bonus_run_items、
-- project_share_adjustments、notifications 都指向測試員工）。
--
-- ── 刪除順序的理由（FK 與 trigger）─────────────────────────────────
--   1. bonus_run_items → bonus_runs：items FK run_id／project_id／employee_id。
--      paid 批次（【測試】獎金批次B）有 forbid_paid_bonus_mutation，demo 狀態放行。
--   2. project_share_adjustments、project_members：FK project_id／employee_id，
--      只有 audit_all（沒有硬刪保護）。
--   3. notifications：FK employee_id → employees（NOT NULL）。放款付清會通知專案
--      lead（測試員工A，type='disbursement'）；每日示警通知會發給 lead 與全部
--      hr_admin（type='project_alert'，含真實 HR 帳號），只刪 payload.projectId
--      指向【測試】專案的那些，別的通知一律不碰。
--   4. disbursements 先 UPDATE 回 'draft'：disbursement_allocations 掛的是
--      no_hard_delete_unless_draft（sql/0030），它看的是「所屬放款單的 status」
--      不看租戶狀態，paid／void 的單下面的分攤列刪不掉。
--   5. disbursement_attachments → disbursement_allocations → project_subcontract_payments
--      → disbursements → project_subcontracts：allocations FK subcontract_payment_id、
--      payments FK disbursement_id、subcontracts 被 payments／allocations 引用。
--      payments／subcontracts／disbursements 都有 no_hard_delete（demo 放行）。
--   6. project_billings（no_hard_delete，demo 放行）。
--   7. project_documents 要在 contracts 之前：documents.contract_id FK contracts
--      （seed 沒掛合約掃描檔，但順序照 FK 排才不會踩雷）。
--   8. contracts（no_hard_delete，demo 放行；FK project_id／client_id）。
--   9. projects：子案（parent_project_id 非空的【測試】專案A-變更）先刪，再刪主案。
--  10. clients → vendors → companies：被 projects／contracts／subcontracts／
--      disbursements／payments 引用，所以放最後；companies 只刪【測試】且
--      NOT is_default（預設主體「亞斯特…」永遠不碰）。vendors 有 no_hard_delete（demo 放行）。
--
-- ── Storage 檔要另外刪（DB 列刪了檔案不會跟著消失）─────────────────
--   • disbursement_attachments：bucket `disbursement-vouchers`，欄位 storage_path
--     （格式 <tenant_id>/<disbursement_id>/<uuid>.png）→ 【測試】憑證.png 1 個
--   • project_documents：bucket `project-documents`，欄位 storage_path
--     （格式 <tenant_id>/<project_id>/<uuid>.png）→ 【測試】文件A/B/C.png 3 個
--   • vendors.card_storage_path（bucket `vendor-cards`）：seed 沒上傳名片，為 NULL，不用處理。
--   先跑下面兩段 SELECT 把路徑抄下來，DB 刪完再用 Storage API 移除：
--     SELECT storage_path FROM disbursement_attachments a JOIN disbursements d ON d.id = a.disbursement_id
--       WHERE d.tenant_id = t AND d.purpose LIKE '【測試】%';
--     SELECT storage_path FROM project_documents WHERE tenant_id = t AND file_name LIKE '【測試】%';
--
-- ── 不刪的東西 ─────────────────────────────────────────────────────
--   audit_logs（append-only，sql/0019 audit_logs_append_only）：所有 INSERT／UPDATE／
--   DELETE 的稽核列都留著，這是設計如此。
--
-- 表名／欄位名已對照 packages/db/src/schema/*.ts：bonus_runs(label)、
-- bonus_run_items(run_id)、project_share_adjustments(project_id)、project_members(project_id)、
-- notifications(employee_id, type, payload jsonb)、disbursements(purpose, status)、
-- disbursement_attachments(disbursement_id, storage_path)、disbursement_allocations(disbursement_id)、
-- project_subcontract_payments(subcontract_id, disbursement_id)、project_subcontracts(project_id, vendor_id)、
-- project_billings(project_id)、project_documents(project_id, contract_id, storage_path)、
-- contracts(project_id, client_id)、projects(name, parent_project_id, client_id)、
-- clients(name)、vendors(name)、companies(name, is_default)。
-- =====================================================================

-- 1. 獎金批次（含 paid 的【測試】獎金批次B；demo 狀態下 forbid_paid_bonus_mutation 放行）
DELETE FROM bonus_run_items
  WHERE tenant_id = t
    AND run_id IN (SELECT id FROM bonus_runs WHERE tenant_id = t AND label LIKE '【測試】%');
DELETE FROM bonus_runs WHERE tenant_id = t AND label LIKE '【測試】%';

-- 2. 分潤異動史與成員（以【測試】專案為範圍）
DELETE FROM project_share_adjustments
  WHERE tenant_id = t
    AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%');
DELETE FROM project_members
  WHERE tenant_id = t
    AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%');

-- 3. 通知：放款付清通知（給測試員工）＋ 指向【測試】專案的示警通知（給 lead 與 HR）
DELETE FROM notifications
  WHERE tenant_id = t AND type = 'disbursement' AND employee_id = ANY(test_emp);
DELETE FROM notifications
  WHERE tenant_id = t AND type = 'project_alert'
    AND (payload ->> 'projectId') IN (
      SELECT id::text FROM projects WHERE tenant_id = t AND name LIKE '【測試】%'
    );

-- 4. 放款單先退回 draft（disbursement_allocations 的 no_hard_delete_unless_draft 不看租戶狀態）
UPDATE disbursements SET status = 'draft'
  WHERE tenant_id = t AND purpose LIKE '【測試】%';

-- 5. 放款附件 → 分攤 → 副委託期款 → 放款單 → 副委託
DELETE FROM disbursement_attachments
  WHERE tenant_id = t
    AND disbursement_id IN (SELECT id FROM disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%');
DELETE FROM disbursement_allocations
  WHERE tenant_id = t
    AND disbursement_id IN (SELECT id FROM disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%');
DELETE FROM project_subcontract_payments
  WHERE tenant_id = t
    AND subcontract_id IN (
      SELECT s.id FROM project_subcontracts s
        JOIN projects p ON p.id = s.project_id
       WHERE s.tenant_id = t AND p.name LIKE '【測試】%'
    );
DELETE FROM disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%';
DELETE FROM project_subcontracts
  WHERE tenant_id = t
    AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%');

-- 6. 期款
DELETE FROM project_billings
  WHERE tenant_id = t
    AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%');

-- 7. 專案文件（在 contracts 之前：contract_id FK；Storage 檔見檔頭）
DELETE FROM project_documents
  WHERE tenant_id = t
    AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%');

-- 8. 合約
DELETE FROM contracts
  WHERE tenant_id = t
    AND project_id IN (SELECT id FROM projects WHERE tenant_id = t AND name LIKE '【測試】%');

-- 9. 專案：子案先（【測試】專案A-變更 掛在 專案A 底下），再刪主案
DELETE FROM projects
  WHERE tenant_id = t AND name LIKE '【測試】%' AND parent_project_id IS NOT NULL;
DELETE FROM projects
  WHERE tenant_id = t AND name LIKE '【測試】%';

-- 10. 名冊：客戶 → 廠商 → 公司主體（預設主體永遠不碰）
DELETE FROM clients   WHERE tenant_id = t AND name LIKE '【測試】%';
DELETE FROM vendors   WHERE tenant_id = t AND name LIKE '【測試】%';
DELETE FROM companies WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT is_default;
