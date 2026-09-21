-- =====================================================================
-- docs/test/seed-test/cleanup/30-payroll.sql — 清掉 30-payroll 建的測試資料（片段）
--
-- ⚠️ 這不是完整可執行的 SQL：它是外層 DO block 的「片段」（外層形狀見 00-base.sql
-- 檔頭），假設外層已宣告 t uuid（租戶）與 test_emp uuid[]（三位測試員工 id），且
-- tenants.status 已切成 'demo'（sql/0018 forbid_hard_delete 只對 test/demo 租戶放行；
-- 本片段碰到的 payslips／expense_claims／expense_claim_attachments／expense_settlements
-- 全掛 no_hard_delete trigger，沒切 demo 會整段 rollback）。
--
-- 執行順序：本片段要在 20-attendance.sql **之前**跑（expense_claims.advance_id →
-- advances、trip_request_id → leave_requests 都是 FK；B 那張綁出差單的報銷單同時綁了
-- 出差預支，advances／leave_requests 先刪會被 FK 擋），也要在 00-base.sql 之前跑
-- （employees 列還在才能用 employee_id 對）。
--
-- 刪除順序（子表先、父表後，理由＝FK）：
--   1. expense_claim_attachments  claim_id → expense_claims（FK）；Storage 檔另外刪（見下）
--   2. expense_claims             settlement_id → expense_settlements、category_id →
--                                 expense_categories、advance_id → advances、
--                                 trip_request_id → leave_requests（皆 FK）
--   3. expense_settlements        只刪 period='2026-08' **且**該期已沒有非測試員工的單
--                                 （條件式 DELETE：月結批次是整期一張，若真實員工的單也在
--                                 這批裡就不能刪，刪了他們的 settlement_id 會懸空）
--   4. expense_categories         code LIKE 'test\_%'；加 NOT EXISTS 保護：若業主用真實員工
--                                 填了測試類別的單（不在 test_emp 內），保留類別不刪
--   5. payslips                   employee_id = ANY(test_emp)（含 A 已 finalized 那張；
--                                 finalized 只是狀態，沒有另外的刪除防線）
--   6. salary_adjustments／salary_structures／nhi_dependents／income_tax_dependents
--                                 employee_id = ANY(test_emp)，互不相依
--   7. non_employee_income        沒有 employee_id，用 payee_name LIKE '【測試】%'
--
-- Storage：expense_claim_attachments 的檔案在 bucket `expense-receipts`，路徑欄位
-- storage_path（形狀 <tenant_id>/<claim_id>/<uuid>.png；本模組只傳 1 張 1×1 PNG，
-- 掛在 B 2026-08-10 那張 1,200 的單）。SQL 刪不到 Storage 物件，跑本片段前先用
-- service role 列出並刪除：
--   SELECT a.storage_path FROM expense_claim_attachments a
--     JOIN expense_claims c ON c.id = a.claim_id
--    WHERE a.tenant_id = '<t>' AND c.employee_id = ANY('<test_emp>');
--   → supabase.storage.from('expense-receipts').remove([...paths])
--
-- 連帶效果提醒：POST /payslips/:id/finalize 把 A 2026-08 的出勤月表轉成 locked——
-- attendance_sheets 由 20-attendance.sql 刪，locked 沒有額外的刪除防線，不用先解鎖。
--
-- 不刪：audit_logs（稽核，無 FK，sql/0037 另有 orphan purge）、advances（出勤模組建的，
-- 由 20-attendance.sql 刪）、expense_settings（本模組沒碰）、rule_configs（本模組只讀）。
--
-- 表名／欄位名已對照 packages/db/src/schema/*.ts：expense_claim_attachments（claim_id、
-- storage_path）、expense_claims（employee_id、category_id、settlement_id、advance_id、
-- trip_request_id、period）、expense_settlements（period、status）、expense_categories
-- （code）、payslips（employee_id、period、status）、salary_adjustments（employee_id）、
-- salary_structures（employee_id）、nhi_dependents（employee_id）、income_tax_dependents
-- （employee_id）、non_employee_income（payee_name）。
-- =====================================================================

-- 1. 憑證附件列（Storage 檔案見檔頭，另外刪）
DELETE FROM expense_claim_attachments
  WHERE tenant_id = t
    AND claim_id IN (SELECT id FROM expense_claims WHERE tenant_id = t AND employee_id = ANY(test_emp));

-- 2. 報銷單（含 settled／cancelled／rejected；綁出差單／預支的那張也在這裡一起刪）
DELETE FROM expense_claims
  WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 3. 月結批次：只刪 2026-08，且該期已沒有非測試員工的單才刪（條件式）
DELETE FROM expense_settlements s
  WHERE s.tenant_id = t
    AND s.period = '2026-08'
    AND NOT EXISTS (
      SELECT 1 FROM expense_claims c
       WHERE c.tenant_id = t
         AND c.period = '2026-08'
         AND NOT (c.employee_id = ANY(test_emp))
    );

-- 4. 費用類別（code test_a／test_b／test_c；'\_' 逃脫底線萬用字元）；仍被別人的單引用就保留
DELETE FROM expense_categories cat
  WHERE cat.tenant_id = t
    AND cat.code LIKE 'test\_%'
    AND NOT EXISTS (SELECT 1 FROM expense_claims c WHERE c.category_id = cat.id);

-- 5. 薪資單（2026-08 三張：A finalized、B／C draft）
DELETE FROM payslips
  WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 6. 調薪／薪資結構／健保眷屬／扶養親屬
DELETE FROM salary_adjustments    WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM salary_structures     WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM nhi_dependents        WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM income_tax_dependents WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 7. 非員工所得（沒有 employee_id，用受款人名稱前綴）
DELETE FROM non_employee_income
  WHERE tenant_id = t AND payee_name LIKE '【測試】%';
