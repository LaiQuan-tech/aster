"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, ErrorText, labelCls } from "@/components/admin-ui";
import { EmployeeCombobox } from "@/components/EmployeeCombobox";
import { getEmployees, type Employee } from "@/lib/admin-api";
import { apiErrorMessage } from "@/lib/api-client";
import { employeeOptionsOf } from "@/lib/employee-combobox";
import { EmployeeStatementsPanel } from "../employees/_components/EmployeeStatementsPanel";

/**
 * 後台「出勤統計表」（2026-11-09 業主）：HR 選員工＋月份，畫面照客戶 Excel「出勤統計表」（出勤｜請假單｜支出表），
 * 資料與打卡、補登、請假、加班紀錄聯動——未核准月份開畫面即重算（API 節流）、已核准／鎖定顯示凍結版本。
 * 下載 Excel＝同一份資料（GET /employees/:id/attendance-statement.xlsx，三個工作表）。
 * 權限：HR／平台管理員／會計（會計的金額在 API 端遮成「—」）。
 */
export default function AttendanceStatementsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEmployees()
      .then((res) => {
        if (cancelled) return;
        const list = [...res.employees].sort((a, b) => {
          const sa = a.status === "active" ? 0 : 1;
          const sb = b.status === "active" ? 0 : 1;
          return sa - sb || String(a.emp_no ?? "").localeCompare(String(b.emp_no ?? "")) || a.name.localeCompare(b.name);
        });
        setEmployees(list);
      })
      .catch((err) => !cancelled && setError(apiErrorMessage(err, "讀取員工失敗")));
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(
    () =>
      employeeOptionsOf(employees).map((o, i) =>
        employees[i]?.status === "active" ? o : { ...o, group: "已離職", note: "已離職" },
      ),
    [employees],
  );

  return (
    <div className="space-y-4">
      <Card className="print:hidden">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_1fr] sm:items-end">
          <div>
            <label className={labelCls} htmlFor="statement-employee">
              員工
            </label>
            <EmployeeCombobox
              id="statement-employee"
              options={options}
              value={employeeId}
              onChange={setEmployeeId}
              clearable={false}
              placeholder="輸入工號、姓名搜尋"
            />
          </div>
          <p className="text-xs text-gray-500">
            選員工後顯示該月出勤統計表（月份在表格右上角切換）。未核准的月份會依最新打卡、補登、請假與加班紀錄重算；
            已核准的月份顯示核准當時的凍結版本。
          </p>
        </div>
        {error && <ErrorText>{error}</ErrorText>}
      </Card>
      {employeeId ? (
        <EmployeeStatementsPanel key={employeeId} employeeId={employeeId} kind="attendance" live />
      ) : (
        <Card className="print:hidden">
          <p className="py-8 text-center text-sm text-gray-500">請先選擇員工</p>
        </Card>
      )}
    </div>
  );
}
