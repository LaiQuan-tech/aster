"use client";

import { useEffect, useMemo, useState } from "react";
import { Segmented } from "@/components/ess-ui";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import { RecordsView } from "./_views/RecordsView";
import { DayView } from "./_views/DayView";
import { WeekView } from "./_views/WeekView";
import { LateReportsView } from "./_views/LateReportsView";
import { EmployeeCombobox } from "@/components/EmployeeCombobox";

type Tab = "day" | "week" | "records" | "late";

const TABS: { value: Tab; label: string }[] = [
  { value: "day", label: "當日總覽" },
  { value: "week", label: "週表" },
  { value: "records", label: "打卡紀錄" },
  { value: "late", label: "遲到說明" },
];

/** 網址 ?view=（week／records／late；當日總覽＝預設、不寫）。舊網址 /admin/late-reports 轉到 ?view=late。 */
function parseTab(v: string | null): Tab {
  return v === "week" || v === "records" || v === "late" ? v : "day";
}

const inputCls = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

/**
 * 後台出勤 › 打卡紀錄（2026-10-27 業主：「這一頁我要一目瞭然，每位員工的上下班時間」）。
 * 四個檢視：當日總覽（預設）／週表／打卡紀錄（原本的流水帳，篩選與欄位不變）／遲到說明（2026-11-09 原
 * 「遲到說明」分頁 /admin/late-reports 搬來，自帶月份／決定狀態／員工篩選）。檢視記在網址 ?view=。
 * 單位、員工篩選前三個檢視共用（打卡紀錄分頁沿用它原本那一排篩選，綁同一份狀態）。
 */
export default function PunchRecordsPage() {
  const [tab, setTabState] = useState<Tab>("day");
  useEffect(() => {
    setTabState(parseTab(new URLSearchParams(window.location.search).get("view")));
  }, []);
  const setTab = (next: Tab) => {
    setTabState(next);
    const url = new URL(window.location.href);
    if (next === "day") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    window.history.replaceState(null, "", url);
  };
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [fDept, setFDept] = useState("");
  const [fEmp, setFEmp] = useState("");

  useEffect(() => {
    Promise.all([getEmployees(), getDepartments()])
      .then(([employeeRes, departmentRes]) => {
        setEmployees(employeeRes.employees);
        setDepartments(departmentRes.departments);
      })
      .catch(() => null);
  }, []);

  // 選了單位就只列該單位的員工；原本選的員工不在該單位 → 清掉。
  const empOptions = useMemo(
    () => employees.filter((e) => e.status === "active" && (!fDept || e.dept_id === fDept)),
    [employees, fDept],
  );
  useEffect(() => {
    if (fEmp && fDept && !empOptions.some((e) => e.id === fEmp)) setFEmp("");
  }, [empOptions, fDept, fEmp]);

  const filter = { deptId: fDept || undefined, employeeId: fEmp || undefined };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Segmented options={TABS} value={tab} onChange={setTab} aria-label="打卡紀錄檢視方式" />
        {(tab === "day" || tab === "week") && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <label className={labelCls}>單位</label>
              <select className={inputCls} value={fDept} onChange={(e) => setFDept(e.target.value)}>
                <option value="">全部</option>
                {departments.map((dept) => (
                  <option key={dept.id} value={dept.id}>{dept.name}</option>
                ))}
              </select>
            </div>
            <div className="w-44">
              <label className={labelCls}>員工</label>
              <EmployeeCombobox
                options={empOptions.map((e) => ({ id: e.id, label: e.emp_no ? `${e.emp_no} ${e.name}` : e.name, searchText: `${e.emp_no ?? ""} ${e.name}` }))}
                value={fEmp}
                onChange={setFEmp}
                emptyLabel="全部"
                ariaLabel="員工"
              />
            </div>
          </div>
        )}
      </div>

      {tab === "day" && <DayView filter={filter} />}
      {tab === "week" && <WeekView filter={filter} />}
      {tab === "late" && <LateReportsView />}
      {tab === "records" && (
        <RecordsView
          employees={employees}
          departments={departments}
          fDept={fDept}
          setFDept={setFDept}
          fEmp={fEmp}
          setFEmp={setFEmp}
        />
      )}
    </>
  );
}
