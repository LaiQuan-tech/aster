-- =====================================================================
-- docs/test/seed-test/cleanup/20-attendance.sql — 清掉 20-attendance 建的測試資料（片段）
--
-- ⚠️ 這不是完整可執行的 SQL：它是外層 DO block 的「片段」（外層形狀見 00-base.sql
-- 檔頭），假設外層已宣告 t uuid（租戶）與 test_emp uuid[]（三位測試員工 id），且
-- tenants.status 已切成 'demo'（sql/0018 forbid_hard_delete 只對 test/demo 租戶放行；
-- 本片段碰到的 leave_requests／request_attachments／approval_steps／punch_records／
-- attendance_days／advances／attendance_sheets／attendance_sheet_days／
-- attendance_sheet_snapshots 全掛 no_hard_delete trigger，沒切 demo 會整段 rollback）。
-- 本片段要在 00-base.sql 之前跑（employees 列還在才能用 employee_id 對）。
--
-- 刪除順序（子表先、父表後，理由＝FK）：
--   1. notifications           employee_id → employees（FK）；簽核與月表通知都掛在測試員工
--                              （A 是簽核者）身上，不先刪，00-base 刪 employees 會被 FK 擋。
--                              另外真實 HR 收到的「測試月表待核准」通知也一併清（payload 對 id）。
--   2. advances                request_id → leave_requests（FK）。⚠️ 若 finance 模組的
--                              expense_claims 綁了這三筆預支（advance_id）或測試出差單
--                              （trip_request_id），要先跑 finance 的片段。
--   3. comp_time_ledger        source_request_id → leave_requests（FK；C 的加班單核准自動記的那筆）
--   4. request_attachments     request_id → leave_requests（FK）
--   5. approval_steps          request_id → leave_requests（FK）
--   6. leave_requests          （punch_records.request_id 只是 uuid 欄位、無 FK，順序無關）
--   7. leave_balances
--   8. attendance_sheet_snapshots  sheet_id → attendance_sheets（FK）
--   9. attendance_sheet_days   sheet_id → attendance_sheets（FK，onDelete restrict）
--  10. attendance_sheets
--  11. attendance_days、punch_records、schedules（互不相依）
--
-- Storage：request_attachments 的檔案在 bucket `request-attachments`，路徑欄位
-- storage_path（形狀 <tenant_id>/<request_id>/<uuid>.png；本模組只傳 1 張 1×1 PNG）。
-- SQL 刪不到 Storage 物件，跑本片段前先用 service role 列出並刪除：
--   SELECT storage_path FROM request_attachments ra
--     JOIN leave_requests lr ON lr.id = ra.request_id
--    WHERE ra.tenant_id = '<t>' AND lr.employee_id = ANY('<test_emp>');
--   → supabase.storage.from('request-attachments').remove([...paths])
--
-- 不刪：audit_logs（稽核，無 FK，sql/0037 另有 orphan purge）、period_closes（本模組沒
-- 跑 close-period）、tenant_calendar_days（本模組只讀）。
--
-- 表名／欄位名已對照 packages/db/src/schema/*.ts：notifications（employee_id、payload）、
-- advances（request_id、employee_id）、comp_time_ledger（source_request_id、employee_id）、
-- request_attachments（request_id、storage_path）、approval_steps（request_id）、
-- leave_requests（employee_id）、leave_balances（employee_id）、attendance_sheet_snapshots
-- （sheet_id、employee_id）、attendance_sheet_days（sheet_id，無 employee_id）、
-- attendance_sheets（employee_id）、attendance_days／punch_records／schedules（employee_id）。
-- =====================================================================

-- 1. 通知：測試員工收到的（簽核者 A、申請人 B／C）＋ 真實 HR 收到的、payload 指向測試資料的
DELETE FROM notifications
  WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM notifications
  WHERE tenant_id = t
    AND (
      -- 用 text 比對，避免 payload 裡不是 uuid 的值讓 ::uuid 轉型炸掉
      payload ->> 'employeeId' = ANY(test_emp::text[])
      OR payload ->> 'requestId' IN (
        SELECT id::text FROM leave_requests WHERE tenant_id = t AND employee_id = ANY(test_emp)
      )
      OR payload ->> 'sheetId' IN (
        SELECT id::text FROM attendance_sheets WHERE tenant_id = t AND employee_id = ANY(test_emp)
      )
    );

-- 2. 預支（kind trip／petty_cash；request_id → leave_requests）
DELETE FROM advances
  WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 3. 補休（含加班單核准自動記的 source_request_id 那筆）
DELETE FROM comp_time_ledger
  WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 4. 附件列（Storage 檔案見檔頭，另外刪）
DELETE FROM request_attachments
  WHERE tenant_id = t
    AND request_id IN (SELECT id FROM leave_requests WHERE tenant_id = t AND employee_id = ANY(test_emp));

-- 5. 簽核關卡
DELETE FROM approval_steps
  WHERE tenant_id = t
    AND request_id IN (SELECT id FROM leave_requests WHERE tenant_id = t AND employee_id = ANY(test_emp));

-- 6. 申請單（leave／ot／fix_punch／business_trip／petty_cash，含 cancelled／rejected）
DELETE FROM leave_requests
  WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 7. 假別餘額（含核准假單自動長出的 used 列，例如 C 的 test_b）
DELETE FROM leave_balances
  WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 8. 月表快照（approve 時凍結的；tenant_id 無 FK，仍以 t 過濾）
DELETE FROM attendance_sheet_snapshots
  WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 9. 月表逐日（sheet_id restrict → 一定要在月表之前）
DELETE FROM attendance_sheet_days
  WHERE tenant_id = t
    AND sheet_id IN (SELECT id FROM attendance_sheets WHERE tenant_id = t AND employee_id = ANY(test_emp));

-- 10. 月表（2026-08 approved ×3、2026-09 draft／submitted／manager_reviewed）
DELETE FROM attendance_sheets
  WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 11. 結算結果、打卡、排班
DELETE FROM attendance_days
  WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM punch_records
  WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM schedules
  WHERE tenant_id = t AND employee_id = ANY(test_emp);
