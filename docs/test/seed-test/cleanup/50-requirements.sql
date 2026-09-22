-- =====================================================================
-- docs/test/seed-test/cleanup/50-requirements.sql — 2026-09-23 需求補齊新增表的測試資料（片段）
--
-- ⚠️ 片段：外層 DO block 已宣告 t uuid（租戶）、test_emp uuid[]（名字以【測試】開頭的員工，
-- 含 9/22 驗收用的【測試】測試HR／【測試】測試會計），且 tenants.status 已切 demo。
-- 必須排在 10-finance.sql 之前（disbursement_approval_steps → disbursements FK）與
-- 00-base.sql 之前（其餘表 → employees FK）。
-- Storage：birthday_gifts.photo_path 在 bucket `birthday-photos`（storage.mjs 會先刪）。
-- =====================================================================
DELETE FROM overtime_settlements WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM festival_bonuses WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM birthday_gifts WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM duty_rosters WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM employee_profile_change_requests WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM disbursement_approval_steps
  WHERE tenant_id = t
    AND disbursement_id IN (SELECT id FROM disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%');
