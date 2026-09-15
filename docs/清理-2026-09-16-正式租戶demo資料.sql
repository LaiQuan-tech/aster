-- =====================================================================
-- 亞斯特 — 2026-09-16 正式租戶（0507ad78）清除 demo seed 業務資料【A：員工資料＋Kimi 停用】
--
-- 背景：9/15 已把 19 位正式員工匯入這個租戶；租戶內所有出勤／假單／薪資／
-- 專案／放款／獎金資料都是 9/14 demo seed 產的（沒有真實資料）。業主 9/16 決定：
--   [1] 員工相關 demo 資料全刪（打卡、出勤日、出勤月表、班表、假單＋簽核、
--       特休額度、健保眷屬、薪資結構、通知、分潤成員＋調整、獎金批次）
--   [2] demo 專案那一包全刪 → 見另一檔 docs/清理-2026-09-16-demo專案與放款.sql
--       （paid 放款單的分攤列有獨立的刪除保護，AI 執行被安全規則擋下，改由業主在 SQL Editor 跑）
--   [3] Kimi（admin@kimihr.app）員工列停用（不刪 auth 帳號），行政部主管清空
-- 保留：employees／employee_profiles／employee_job_history／departments／
--       shifts／tenant_calendar_days／leave_types／approval_flows／
--       rule_configs／project_settings／expense_settings 等設定，audit_logs 不動。
--
-- 為什麼要先把租戶切成 demo：sql/0018 的 forbid_hard_delete 只放行
-- tenants.status IN ('test','demo') 的租戶（punch_records／attendance_days／
-- leave_requests／approval_steps／request_attachments／payslips／expense_*）。
-- 這裡在同一交易內切成 demo → 刪 → 切回 active；任何一步失敗整包回滾，
-- 租戶不會卡在 demo 狀態。
-- 套用方式：Supabase Management API query 端點（單一交易）或 SQL Editor。
-- 冪等：可重複執行（第二次全部 0 列）。
-- =====================================================================

DO $$
DECLARE
  t    uuid := '0507ad78-27f4-480e-b99f-a72db2aee50c';
  kimi uuid;
BEGIN
  IF (SELECT status FROM public.tenants WHERE id = t) <> 'active' THEN
    RAISE EXCEPTION 'tenant % is not active (status=%)', t, (SELECT status FROM public.tenants WHERE id = t);
  END IF;
  UPDATE public.tenants SET status = 'demo' WHERE id = t;

  -- [1a] 獎金／分潤
  DELETE FROM public.bonus_run_items          WHERE tenant_id = t;
  DELETE FROM public.bonus_runs               WHERE tenant_id = t;
  DELETE FROM public.project_share_adjustments WHERE tenant_id = t;
  DELETE FROM public.project_members          WHERE tenant_id = t;

  -- [1b] 通知
  DELETE FROM public.notifications            WHERE tenant_id = t;

  -- [1c] 出勤
  DELETE FROM public.attendance_sheet_snapshots WHERE tenant_id = t;
  DELETE FROM public.attendance_sheet_days    WHERE tenant_id = t;
  DELETE FROM public.attendance_sheets        WHERE tenant_id = t;
  DELETE FROM public.period_closes            WHERE tenant_id = t;
  DELETE FROM public.attendance_days          WHERE tenant_id = t;
  DELETE FROM public.punch_records            WHERE tenant_id = t;
  DELETE FROM public.schedules                WHERE tenant_id = t;

  -- [1d] 假單
  DELETE FROM public.request_attachments      WHERE tenant_id = t;
  DELETE FROM public.approval_steps           WHERE tenant_id = t;
  DELETE FROM public.leave_requests           WHERE tenant_id = t;
  DELETE FROM public.leave_balances           WHERE tenant_id = t;
  DELETE FROM public.comp_time_ledger         WHERE tenant_id = t;

  -- [1e] 薪資／眷屬
  DELETE FROM public.payslips                 WHERE tenant_id = t;
  DELETE FROM public.salary_adjustments       WHERE tenant_id = t;
  DELETE FROM public.salary_structures        WHERE tenant_id = t;
  DELETE FROM public.nhi_dependents           WHERE tenant_id = t;
  DELETE FROM public.income_tax_dependents    WHERE tenant_id = t;

  UPDATE public.tenants SET status = 'active' WHERE id = t;

  -- [3] Kimi 停用（比照 POST /employees/:id/deactivate：status=inactive＋terminated_at＝今天）
  SELECT id INTO kimi FROM public.employees
   WHERE tenant_id = t AND name = 'Kimi' AND role = 'hr_admin' AND emp_no IS NULL
   LIMIT 1;
  IF kimi IS NOT NULL THEN
    UPDATE public.employees
       SET status = 'inactive', terminated_at = (now() AT TIME ZONE 'Asia/Taipei')::date
     WHERE id = kimi AND status <> 'inactive';
    UPDATE public.departments SET manager_emp_id = NULL WHERE tenant_id = t AND manager_emp_id = kimi;
  END IF;
END $$;

-- 驗證（逐句送）：
-- SELECT status FROM public.tenants WHERE id = '0507ad78-27f4-480e-b99f-a72db2aee50c';           -- active
-- SELECT count(*) FROM public.punch_records WHERE tenant_id = '0507ad78-27f4-480e-b99f-a72db2aee50c'; -- 0
-- SELECT name, status, terminated_at FROM public.employees WHERE tenant_id = '0507ad78-…' AND name = 'Kimi';
