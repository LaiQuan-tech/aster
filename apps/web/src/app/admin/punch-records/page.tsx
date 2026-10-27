"use client";

import { useEffect, useMemo, useState } from "react";
import { Segmented } from "@/components/ess-ui";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import { RecordsView } from "./_views/RecordsView";
import { DayView } from "./_views/DayView";
import { WeekView } from "./_views/WeekView";

type Tab = "day" | "week" | "records";

const TABS: { value: Tab; label: string }[] = [
  { value: "day", label: "當日總覽" },
  { value: "week", label: "週表" },
  { value: "records", label: "打卡紀錄" },
];

const inputCls = "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

/**
 * 後台出勤 › 打卡紀錄（2026-10-27 業主：「這一頁我要一目瞭然，每位員工的上下班時間」）。
 * 三個分頁：當日總覽（預設）／週表／打卡紀錄（原本的流水帳，篩選與欄位不變）。
 * 單位、員工篩選三個分頁共用（打卡紀錄分頁沿用它原本那一排篩選，綁同一份狀態）。
 */
export default function PunchRecordsPage() {
  const [tab, setTab] = useState<Tab>("day");
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
        {tab !== "records" && (
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
              <select className={inputCls} value={fEmp} onChange={(e) => setFEmp(e.target.value)}>
                <option value="">全部</option>
                {empOptions.map((e) => (
                  <option key={e.id} value={e.id}>{e.emp_no ? `${e.emp_no} ${e.name}` : e.name}</option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {tab === "day" && <DayView filter={filter} />}
      {tab === "week" && <WeekView filter={filter} />}
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
