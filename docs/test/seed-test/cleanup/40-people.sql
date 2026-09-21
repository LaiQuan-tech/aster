-- =====================================================================
-- docs/test/seed-test/cleanup/40-people.sql — 清掉 40-people 建的測試資料（片段）
--
-- ⚠️ 這不是完整可執行的 SQL：它是外層 DO block 的「片段」（外層形狀見 cleanup/00-base.sql
-- 檔頭：先宣告 t uuid（租戶）與 test_emp uuid[]，UPDATE tenants SET status='demo' 放行
-- 0018 的 forbid_hard_delete，清完再切回 active）。
--
-- ★ 執行順序：本片段必須排在 00-base.sql 的「DELETE FROM employees」之前（或合併在同一個
--   DO block、放在它前面）。理由：
--   (1) onboardings.employee_id、kpi_reviews.employee_id／reviewer_emp_id、
--       employee_mailboxes.employee_id、announcement_acknowledgements.employee_id、
--       notifications.employee_id 都有 FK 指向 employees，員工列先刪會撞 FK。
--   (2) 報到完成（POST /onboardings/:id/complete）會多建一位「無登入帳號」的員工列
--       【測試】報到者C（user_id IS NULL、emp_no NULL）；外層 test_emp 若是用
--       `name LIKE '【測試】%'` 撈的就已包含他，但本片段不依賴這點：每個 employee_id
--       條件都同時寫 `= ANY(test_emp)` 與「name LIKE '【測試】%' 的子查詢」，最後自己把
--       報到者的員工列刪掉（只刪 user_id IS NULL 的，絕不碰有帳號的真實員工）。
--
-- 刪除順序（子表 → 父表；表名／欄位名已對照 packages/db/src/schema/*.ts）：
--   招募：offers、interviews（candidate_id）→ candidates（name 前綴／requisition_id）
--         → job_requisitions（title 前綴）
--   考核：kpi_reviews（employee_id／reviewer_emp_id／template_id）→ kpi_templates（name 前綴）
--   信箱：employee_mailboxes（employee_id）
--   公告：announcement_acknowledgements（version_id／employee_id；含報到者C 在「真實」需簽收
--         規章上被自動建的 accept_on_hire 待簽列）→ announcement_signature_sheets（version_id）
--         → announcement_versions（announcement_id）→ announcements（title 前綴）。
--         announcements 有 no_hard_delete trigger（sql/0018），外層已切 demo 才放行；
--         announcement_versions／acknowledgements／signature_sheets 只有 audit_all（sql/0019），
--         刪除會照常寫進 audit_logs，不擋。
--   公司資訊頁：company_pages（title 前綴；slug 只有 benefits／safety，刪掉後前台回預設空頁）
--   知識庫：knowledge_chunks（document_id，schema 已 onDelete cascade，仍明寫一次）
--         → knowledge_documents（title 前綴）
--   通知：notifications（employee_id 或 title／body 含【測試】）
--   報到：onboardings（name 前綴）→ 報到完成產生的 employees 列（name LIKE '【測試】報到者%'
--         AND user_id IS NULL）
--   稽核：audit_logs 不刪（append-only，sql/0019；demo 租戶雖放行，但保留「測試資料被建立／
--         刪除」的軌跡本來就是稽核的目的）。要清的話：
--         DELETE FROM audit_logs WHERE tenant_id = t AND (new_row->>'name' LIKE '【測試】%' OR new_row->>'title' LIKE '【測試】%' OR old_row->>'name' LIKE '【測試】%' OR old_row->>'title' LIKE '【測試】%');
--
-- Storage（本片段不處理，DB 列刪完後另外用 Storage API／Dashboard 刪）：
--   • 備份快照：bucket `tenant-snapshots`，path `<tenant_id>/<period>/{<table>.json.gz…, manifest.json,
--     manifest.prev.json}`；本模組跑了 2026-06／2026-07／2026-08 三期（清單端點 GET /backups；
--     沒有 DB 列，只有 Storage 物件）。備份是整租戶全表快照，含真實資料——留著也無害，要刪就刪
--     這三個 period 資料夾（不要動 2026-09 那份正式月度快照）。
--   • 公告簽名單掃描檔：bucket `announcement-sheets`，path 在 announcement_signature_sheets.storage_path
--     （seed 沒上傳掃描檔，預期 0 筆；下面仍先 SELECT 出來提醒）。
--   • 知識庫檔案：bucket `knowledge-files`，path 在 knowledge_documents.storage_path（seed 只建
--     kind='text'，storage_path 皆 NULL，預期 0 筆）。
-- =====================================================================

-- ── 招募 ─────────────────────────────────────────────────────────────
DELETE FROM offers
  WHERE tenant_id = t
    AND candidate_id IN (
      SELECT c.id FROM candidates c
        LEFT JOIN job_requisitions j ON j.id = c.requisition_id
       WHERE c.tenant_id = t AND (c.name LIKE '【測試】%' OR j.title LIKE '【測試】%'));
DELETE FROM interviews
  WHERE tenant_id = t
    AND candidate_id IN (
      SELECT c.id FROM candidates c
        LEFT JOIN job_requisitions j ON j.id = c.requisition_id
       WHERE c.tenant_id = t AND (c.name LIKE '【測試】%' OR j.title LIKE '【測試】%'));
DELETE FROM candidates
  WHERE tenant_id = t
    AND (name LIKE '【測試】%'
         OR requisition_id IN (SELECT id FROM job_requisitions WHERE tenant_id = t AND title LIKE '【測試】%'));
DELETE FROM job_requisitions WHERE tenant_id = t AND title LIKE '【測試】%';

-- ── 考核 ─────────────────────────────────────────────────────────────
DELETE FROM kpi_reviews
  WHERE tenant_id = t
    AND (employee_id = ANY(test_emp)
         OR reviewer_emp_id = ANY(test_emp)
         OR employee_id IN (SELECT id FROM employees WHERE tenant_id = t AND name LIKE '【測試】%')
         OR template_id IN (SELECT id FROM kpi_templates WHERE tenant_id = t AND name LIKE '【測試】%'));
DELETE FROM kpi_templates WHERE tenant_id = t AND name LIKE '【測試】%';

-- ── 專屬 Email 台帳 ───────────────────────────────────────────────────
DELETE FROM employee_mailboxes
  WHERE tenant_id = t
    AND (employee_id = ANY(test_emp)
         OR employee_id IN (SELECT id FROM employees WHERE tenant_id = t AND name LIKE '【測試】%')
         OR address LIKE '%@%.test.aster.local');

-- ── 公告（簽收 → 掃描檔 → 版本 → 公告）────────────────────────────────
DELETE FROM announcement_acknowledgements
  WHERE tenant_id = t
    AND (employee_id = ANY(test_emp)
         OR employee_id IN (SELECT id FROM employees WHERE tenant_id = t AND name LIKE '【測試】%')
         OR version_id IN (
           SELECT v.id FROM announcement_versions v
             JOIN announcements a ON a.id = v.announcement_id
            WHERE v.tenant_id = t AND a.title LIKE '【測試】%'));
-- 掃描檔：先列出 storage_path 供 Storage 端刪除（seed 預期 0 筆）
-- SELECT storage_path FROM announcement_signature_sheets WHERE tenant_id = t AND version_id IN (
--   SELECT v.id FROM announcement_versions v JOIN announcements a ON a.id = v.announcement_id
--    WHERE v.tenant_id = t AND a.title LIKE '【測試】%');
DELETE FROM announcement_signature_sheets
  WHERE tenant_id = t
    AND version_id IN (
      SELECT v.id FROM announcement_versions v
        JOIN announcements a ON a.id = v.announcement_id
       WHERE v.tenant_id = t AND a.title LIKE '【測試】%');
-- current_version_id 沒有 FK（與 versions 環狀參照），不必先清空
DELETE FROM announcement_versions
  WHERE tenant_id = t
    AND announcement_id IN (SELECT id FROM announcements WHERE tenant_id = t AND title LIKE '【測試】%');
DELETE FROM announcements WHERE tenant_id = t AND title LIKE '【測試】%';   -- 含已軟刪（deleted_at 不論）

-- ── 公司資訊頁 ───────────────────────────────────────────────────────
DELETE FROM company_pages WHERE tenant_id = t AND title LIKE '【測試】%';

-- ── 知識庫（chunks 已 cascade，明寫一次讓順序一目瞭然）────────────────
DELETE FROM knowledge_chunks
  WHERE tenant_id = t
    AND document_id IN (SELECT id FROM knowledge_documents WHERE tenant_id = t AND title LIKE '【測試】%');
DELETE FROM knowledge_documents WHERE tenant_id = t AND title LIKE '【測試】%';

-- ── 通知（由操作自動產生，未手灌）─────────────────────────────────────
DELETE FROM notifications
  WHERE tenant_id = t
    AND (employee_id = ANY(test_emp)
         OR employee_id IN (SELECT id FROM employees WHERE tenant_id = t AND name LIKE '【測試】%')
         OR title LIKE '%【測試】%'
         OR body  LIKE '%【測試】%');

-- ── 報到 → 報到完成產生的員工列（無登入帳號）──────────────────────────
DELETE FROM onboardings WHERE tenant_id = t AND name LIKE '【測試】%';
-- 只刪 user_id IS NULL 的報到者列；三位有帳號的測試員工由 00-base.sql 刪
DELETE FROM employees
  WHERE tenant_id = t AND name LIKE '【測試】報到者%' AND user_id IS NULL;
