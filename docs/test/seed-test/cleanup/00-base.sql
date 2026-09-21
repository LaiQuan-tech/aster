-- =====================================================================
-- docs/test/seed-test/cleanup/00-base.sql — 清掉 00-base 建的測試資料（片段）
--
-- ⚠️ 這不是完整可執行的 SQL：它是外層 DO block 的「片段」，外層必須先：
--   DECLARE
--     t        uuid   := '0507ad78-27f4-480e-b99f-a72db2aee50c';   -- 租戶 id
--     test_emp uuid[];                                              -- 三位測試員工 id
--   BEGIN
--     -- 0018_forbid_hard_delete：證據表只有 tenant.status IN ('test','demo') 才放行實體刪除，
--     -- 所以要先切 demo、清完再切回 active（切回的動作也由外層負責）。
--     UPDATE tenants SET status = 'demo' WHERE id = t;
--     SELECT array_agg(id) INTO test_emp FROM employees
--       WHERE tenant_id = t AND name LIKE '【測試】%';
--     …（其他模組的片段先跑：finance／attendance／payroll／people 掛在測試員工身上的
--        leave_requests／punch_records／schedules／payslips…都要先刪，本片段最後才刪 employees）…
--     …（本片段）…
--     UPDATE tenants SET status = 'active' WHERE id = t;
--   END
--
-- 表名／欄位名已對照 packages/db/src/schema/*.ts：
--   employee_educations／employee_certifications／employee_work_history／
--   employee_job_history／employee_profiles（employee_id）、departments（parent_id、
--   manager_emp_id、name）、employees（dept_id、user_id 無 FK 指向 auth.users）、
--   leave_types（code）、shifts（name）、tenant_calendar_days（label）、tenants（features jsonb）。
-- =====================================================================

-- 3. 個人資料五張子表（employee_id = ANY(test_emp)）
DELETE FROM employee_educations     WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM employee_certifications WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM employee_work_history   WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM employee_job_history    WHERE tenant_id = t AND employee_id = ANY(test_emp);
DELETE FROM employee_profiles       WHERE tenant_id = t AND employee_id = ANY(test_emp);

-- 2. 員工：先解除「測試員工A 是測試部主管」，再刪員工列
UPDATE departments SET manager_emp_id = NULL
  WHERE tenant_id = t AND manager_emp_id = ANY(test_emp);
DELETE FROM employees WHERE tenant_id = t AND id = ANY(test_emp);

-- 1. 部門：子部門（parent 不為 null）先刪，再刪測試部 root
DELETE FROM departments
  WHERE tenant_id = t AND name LIKE '【測試】%' AND parent_id IS NOT NULL;
DELETE FROM departments
  WHERE tenant_id = t AND name LIKE '【測試】%';

-- 4. 假別（code test_a／test_b／test_c；'\_' 逃脫底線萬用字元）
DELETE FROM leave_types WHERE tenant_id = t AND code LIKE 'test\_%';

-- 5. 班別
DELETE FROM shifts WHERE tenant_id = t AND name LIKE '【測試】%';

-- 6. 行事曆
DELETE FROM tenant_calendar_days WHERE tenant_id = t AND label LIKE '【測試】%';

-- 7. 內部連結：只濾掉 name 以【測試】開頭的，其餘原樣保留
UPDATE tenants
  SET features = jsonb_set(
    features,
    '{internalLinks}',
    COALESCE(
      (SELECT jsonb_agg(l)
         FROM jsonb_array_elements(features -> 'internalLinks') l
        WHERE NOT (l ->> 'name' LIKE '【測試】%')),
      '[]'::jsonb
    )
  )
  WHERE id = t AND features ? 'internalLinks';

-- 2'. auth 帳號：employees.user_id 對 auth.users 沒有 FK（schema/employees.ts 只是 uuid 欄位），
--     employees 列已刪，這裡直接清掉三個測試登入帳號。
DELETE FROM auth.users WHERE email LIKE '%@test.aster.local';
