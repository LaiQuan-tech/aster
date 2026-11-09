-- ============================================================================
-- 清理-2026-11-09：兼職不排班被誤判遲到產生的遲到說明（late_reports）
-- ----------------------------------------------------------------------------
-- 背景：修正前，兼職（employees.employment_type = 'parttime'）當天沒有排班、也沒有個人預設班別時，
-- 系統套公司彈性上班 08:00–10:00 判遲到（例：14:37 上班 → 「遲到 217 分」），打卡時要求填遲到說明，
-- 寫進 late_reports。修正後這類兼職沒有應上班時間，不判遲到、不要求說明。
--
-- 修正部署後「自動」會好的部分（不用跑 SQL）：
--   • attendance_days.late_minutes / early_leave_minutes：下次結算（每晚 daily-settle 只結算前一天；
--     出勤月表「重新產生」或 POST /attendance/settle 重算該月）就會歸 0。今天以前已結算的日子要重算才會改。
--   • 月表的「遲到」異常、consecutive_late、late_reports_undecided：都看 attendance_days.late_minutes，
--     重算後消失；全勤判斷（lateAttendanceStatus）也看逐日遲到分鐘，重算後不受影響。
--   • 打卡總覽：班別欄改顯示「兼職（不排班）」、不顯示遲到徽章（即使舊結算列還沒重算也不顯示）。
--
-- 「不會」自動消失的部分（需要本檔清理）：
--   • late_reports 列本身：遲到說明清單（GET /late-reports）、老闆待辦「遲到說明待決定」
--     （boss-summary lateReportsPending）、月結檢查的 late_reports 提醒都直接數這張表。
--
-- 使用方式：**唯讀查詢先跑、人工核對**；清理段預設 ROLLBACK，確認後才把最後一行改成 COMMIT。
-- 本檔不會由程式自動執行；不要在未核對前對正式庫執行。
-- 判斷條件與程式一致（apps/api/src/services/employee-shifts.ts isUnscheduledPartTime）：
--   兼職 AND 當天沒有 schedules 列 AND 沒有個人預設班別（以「現在」的 default_shift_id 判斷；
--   若員工是事後才拿掉預設班別，請人工排除）。
-- 已關帳月份（payroll_periods 已關）或月表已核准的遲到說明，請先與 HR 確認再刪。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 唯讀：列出要清的遲到說明（含員工、日期、分鐘、老闆是否已決定、當天結算的遲到分鐘、月表狀態）
-- ---------------------------------------------------------------------------
SELECT lr.id                AS late_report_id,
       lr.tenant_id,
       e.emp_no,
       e.name,
       lr.work_date,
       lr.late_minutes      AS report_late_minutes,
       lr.attendance_decision,
       lr.created_at,
       ad.late_minutes      AS settled_late_minutes,
       sh.status            AS sheet_status
FROM public.late_reports lr
JOIN public.employees e
  ON e.id = lr.employee_id AND e.tenant_id = lr.tenant_id
LEFT JOIN public.attendance_days ad
  ON ad.tenant_id = lr.tenant_id AND ad.employee_id = lr.employee_id AND ad.work_date = lr.work_date
LEFT JOIN public.attendance_sheets sh
  ON sh.tenant_id = lr.tenant_id AND sh.employee_id = lr.employee_id
 AND sh.period = to_char(lr.work_date, 'YYYY-MM')
WHERE e.employment_type = 'parttime'
  AND e.default_shift_id IS NULL
  AND NOT EXISTS (
        SELECT 1 FROM public.schedules s
        WHERE s.tenant_id = lr.tenant_id AND s.employee_id = lr.employee_id AND s.work_date = lr.work_date
      )
ORDER BY lr.tenant_id, lr.work_date, e.emp_no;

-- ---------------------------------------------------------------------------
-- 2) 清理（預設 ROLLBACK）：刪除上面那批遲到說明
--    上線修正後再跑；跑完請對受影響月份重新產生出勤月表（或 POST /attendance/settle），
--    attendance_days.late_minutes 才會一起歸 0。
-- ---------------------------------------------------------------------------
BEGIN;

DELETE FROM public.late_reports lr
USING public.employees e
WHERE e.id = lr.employee_id
  AND e.tenant_id = lr.tenant_id
  AND e.employment_type = 'parttime'
  AND e.default_shift_id IS NULL
  AND NOT EXISTS (
        SELECT 1 FROM public.schedules s
        WHERE s.tenant_id = lr.tenant_id AND s.employee_id = lr.employee_id AND s.work_date = lr.work_date
      )
RETURNING lr.id, lr.tenant_id, lr.employee_id, lr.work_date, lr.late_minutes, lr.attendance_decision;

-- 核對 RETURNING 的筆數與 1) 一致後，把下一行改成 COMMIT;
ROLLBACK;
