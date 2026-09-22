-- =====================================================================
-- 亞斯特 — 清除 2026-09-22 建立的後台【測試】資料（由 docs/test/seed-test/cleanup/build.mjs 產生）
--
-- 用途：業主驗完後台功能後，一次刪光 docs/test/seed-test/*.mjs 灌進正式租戶的測試資料：
--   三位【測試】測試員工 A/B/C（含登入帳號）＋【測試】報到者C、測試部與子組、假別／班別／行事曆／
--   內部連結、專案／合約／期款／副委託／放款／獎金批次／客戶／廠商／公司主體、排班／打卡／出勤日／
--   月表／假單／簽核／餘額／預支／補休、薪資結構／薪資單／調薪／眷屬／非員工所得／費用類別／報銷／月結、
--   報到／招募／考核／專屬信箱／公告／公司資訊頁／知識庫，以及掛在測試員工或提到【測試】的通知。
-- 不動：真實員工與他們的任何資料、audit_logs（稽核保留）、Storage 備份快照（tenant-snapshots）。
-- 前置：先跑 `node docs/test/seed-test/cleanup/storage.mjs` 刪 Storage 檔（它要先從 DB 讀路徑）。
-- 執行：Supabase Management API query 端點或 SQL Editor（單一交易，任何一句失敗整包回滾）。
-- 冪等：可重複執行（第二次全部 0 列）。
-- =====================================================================

DO $$
DECLARE
  t        uuid := '0507ad78-27f4-480e-b99f-a72db2aee50c';
  test_emp uuid[];
BEGIN
  IF (SELECT status FROM public.tenants WHERE id = t) <> 'active' THEN
    RAISE EXCEPTION 'tenant % is not active (status=%)', t, (SELECT status FROM public.tenants WHERE id = t);
  END IF;
  -- 測試員工＝名字以【測試】開頭（三位有帳號的 A/B/C ＋ 報到完成產生的無帳號報到者C）
  SELECT COALESCE(array_agg(id), '{}') INTO test_emp
    FROM public.employees WHERE tenant_id = t AND name LIKE '【測試】%';
  RAISE NOTICE 'test employees: %', COALESCE(array_length(test_emp, 1), 0);

  -- sql/0018 forbid_hard_delete／0034 forbid_paid_bonus_mutation／0019 audit append-only
  -- 只對 status IN ('test','demo') 的租戶放行實體刪除：同一交易內切 demo → 刪 → 切回 active。
  UPDATE public.tenants SET status = 'demo' WHERE id = t;

  -- ───────────────────────── 50-requirements.sql ─────────────────────────
  DELETE FROM overtime_settlements WHERE tenant_id = t AND employee_id = ANY(test_emp);
  DELETE FROM festival_bonuses WHERE tenant_id = t AND employee_id = ANY(test_emp);
  DELETE FROM birthday_gifts WHERE tenant_id = t AND employee_id = ANY(test_emp);
  DELETE FROM duty_rosters WHERE tenant_id = t AND employee_id = ANY(test_emp);
  DELETE FROM employee_profile_change_requests WHERE tenant_id = t AND employee_id = ANY(test_emp);
  DELETE FROM disbursement_approval_steps
    WHERE tenant_id = t
      AND disbursement_id IN (SELECT id FROM disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%');

  -- ───────────────────────── 30-payroll.sql ─────────────────────────
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

  -- ───────────────────────── 20-attendance.sql ─────────────────────────
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

  -- ───────────────────────── 10-finance.sql ─────────────────────────
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

  -- ───────────────────────── 40-people.sql ─────────────────────────
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

  -- ───────────────────────── 00-base.sql ─────────────────────────
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

  UPDATE public.tenants SET status = 'active' WHERE id = t;
END $$;
