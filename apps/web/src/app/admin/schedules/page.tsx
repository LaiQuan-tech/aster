"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getDepartments,
  getEmployees,
  getShifts,
  getSchedules,
  assignSchedule,
  assignSchedulesBatch,
  importSchedules,
  reviewSchedule,
  type Department,
  type Employee,
  type Shift,
  type Schedule,
} from "@/lib/admin-api";

const STATUS_LABEL: Record<string, string> = {
  scheduled: "待確認",
  confirmed: "已確認",
  disputed: "有爭議",
  day_off: "休假",
};

const STATUS_OPTIONS = [
  { value: "scheduled", label: "待確認" },
  { value: "confirmed", label: "已確認" },
  { value: "day_off", label: "休假" },
  { value: "disputed", label: "有爭議" },
];

const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  regular: "正職",
  parttime: "兼職",
  contract: "約聘",
  dispatched: "派遣",
  intern: "實習",
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRange(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const days: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

export default function SchedulesPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [employeeId, setEmployeeId] = useState("");
  const [workDate, setWorkDate] = useState(todayIso());
  const [shiftId, setShiftId] = useState("");
  const [singleStatus, setSingleStatus] = useState("scheduled");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const [batchEmp, setBatchEmp] = useState("");
  const [batchFrom, setBatchFrom] = useState(todayIso());
  const [batchTo, setBatchTo] = useState(plusDaysIso(6));
  const [batchShift, setBatchShift] = useState("");
  const [batchStatus, setBatchStatus] = useState("scheduled");

  const [csv, setCsv] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(plusDaysIso(14));
  const [filterEmp, setFilterEmp] = useState("");
  const [filterDept, setFilterDept] = useState("");
  const [filterEmploymentType, setFilterEmploymentType] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const employeeById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);

  const empName = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, e.emp_no ? `${e.emp_no} / ${e.name}` : e.name);
    return m;
  }, [employees]);

  const deptName = useMemo(() => {
    const m = new Map<string, string>();
    for (const department of departments) m.set(department.id, department.name);
    return m;
  }, [departments]);

  const employmentTypes = useMemo(() => {
    return Array.from(new Set(employees.map((employee) => employee.employment_type).filter(Boolean) as string[])).sort();
  }, [employees]);

  const shiftName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shifts) m.set(s.id, s.name);
    return m;
  }, [shifts]);

  const visibleSchedules = useMemo(
    () =>
      schedules.filter((schedule) => {
        const employee = employeeById.get(schedule.employee_id);
        if (filterStatus && schedule.status !== filterStatus) return false;
        if (filterDept && employee?.dept_id !== filterDept) return false;
        if (filterEmploymentType && employee?.employment_type !== filterEmploymentType) return false;
        return true;
      }),
    [employeeById, filterDept, filterEmploymentType, filterStatus, schedules],
  );

  const summary = useMemo(() => {
    const totals = new Map<string, number>();
    for (const schedule of schedules) totals.set(schedule.status, (totals.get(schedule.status) ?? 0) + 1);
    return totals;
  }, [schedules]);

  const runQuery = useCallback(async () => {
    try {
      const res = await getSchedules({
        from,
        to,
        employeeId: filterEmp || undefined,
      });
      setSchedules(res.schedules);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "查詢失敗");
    }
  }, [from, to, filterEmp]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [empRes, shiftRes, deptRes] = await Promise.all([getEmployees(), getShifts(), getDepartments()]);
        if (!active) return;
        setEmployees(empRes.employees);
        setShifts(shiftRes.shifts);
        setDepartments(deptRes.departments);
        const firstEmployee = empRes.employees[0]?.id ?? "";
        setEmployeeId(firstEmployee);
        setBatchEmp(firstEmployee);
        await runQuery();
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "載入失敗");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // runQuery intentionally omitted: initial bootstrap only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onAssign(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setOkMsg(null);
    if (!employeeId || !workDate) {
      setFormError("請選擇員工與日期");
      return;
    }
    setSubmitting(true);
    try {
      await assignSchedule({
        employeeId,
        workDate,
        shiftId: shiftId || undefined,
        status: singleStatus,
      });
      setOkMsg("已指派單日班表");
      await runQuery();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "指派失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function onBatchAssign(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setOkMsg(null);
    const days = dateRange(batchFrom, batchTo);
    if (!batchEmp || days.length === 0) {
      setFormError("請選擇員工與有效日期區間");
      return;
    }
    setSubmitting(true);
    try {
      const res = await assignSchedulesBatch(
        days.map((day) => ({
          employeeId: batchEmp,
          workDate: day,
          shiftId: batchShift || undefined,
          status: batchStatus,
        })),
      );
      setOkMsg(`已批次產生 ${res.count} 筆班表`);
      await runQuery();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "批次指派失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function onImport(e: FormEvent) {
    e.preventDefault();
    setImportResult(null);
    if (!csv.trim()) {
      setImportResult("請貼上 CSV 內容");
      return;
    }
    setImporting(true);
    try {
      const res = await importSchedules(csv);
      const errors = res.errors.length ? `，${res.errors.length} 筆需修正` : "";
      setImportResult(`已匯入 ${res.count} 筆${errors}`);
      await runQuery();
    } catch (err) {
      setImportResult(err instanceof Error ? err.message : "匯入失敗");
    } finally {
      setImporting(false);
    }
  }

  async function onReview(id: string, decision: "acknowledge" | "dispute") {
    setReviewingId(id);
    setError(null);
    try {
      await reviewSchedule(id, decision);
      await runQuery();
    } catch (err) {
      setError(err instanceof Error ? err.message : "審核失敗");
    } finally {
      setReviewingId(null);
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <h2 className="mb-4 text-base font-semibold text-gray-900">單日指派</h2>
          <form onSubmit={onAssign} className="space-y-4">
            <div>
              <label className={labelCls}>員工</label>
              <select className={inputCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.emp_no ? `${emp.emp_no} / ${emp.name}` : emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>日期</label>
                <input type="date" className={inputCls} value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>狀態</label>
                <select className={inputCls} value={singleStatus} onChange={(e) => setSingleStatus(e.target.value)}>
                  {STATUS_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>班別</label>
              <select className={inputCls} value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
                <option value="">（休假／不指定）</option>
                {shifts.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <PrimaryButton type="submit" disabled={submitting || employees.length === 0}>
              {submitting ? "處理中…" : "指派"}
            </PrimaryButton>
          </form>
        </Card>

        <Card>
          <h2 className="mb-4 text-base font-semibold text-gray-900">區間批次排班</h2>
          <form onSubmit={onBatchAssign} className="space-y-4">
            <div>
              <label className={labelCls}>員工</label>
              <select className={inputCls} value={batchEmp} onChange={(e) => setBatchEmp(e.target.value)}>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.emp_no ? `${emp.emp_no} / ${emp.name}` : emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>起日</label>
                <input type="date" className={inputCls} value={batchFrom} onChange={(e) => setBatchFrom(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>迄日</label>
                <input type="date" className={inputCls} value={batchTo} onChange={(e) => setBatchTo(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>班別</label>
                <select className={inputCls} value={batchShift} onChange={(e) => setBatchShift(e.target.value)}>
                  <option value="">（休假／不指定）</option>
                  {shifts.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>狀態</label>
                <select className={inputCls} value={batchStatus} onChange={(e) => setBatchStatus(e.target.value)}>
                  {STATUS_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <PrimaryButton type="submit" disabled={submitting || employees.length === 0}>
              {submitting ? "處理中…" : "批次建立"}
            </PrimaryButton>
          </form>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold text-gray-900">CSV 匯入班表</h2>
          <p className="mb-3 text-sm text-gray-500">欄位：employeeId,workDate,shiftId,status；shiftId 可留空。</p>
          <form onSubmit={onImport} className="space-y-3">
            <textarea
              className={`${inputCls} min-h-32 font-mono`}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={"employeeId,workDate,shiftId,status\n員工UUID,2026-07-06,班別UUID,scheduled"}
            />
            <PrimaryButton type="submit" disabled={importing}>{importing ? "匯入中…" : "匯入"}</PrimaryButton>
          </form>
          {importResult && <p className="mt-3 text-sm text-gray-600">{importResult}</p>}
        </Card>
      </div>

      {(formError || okMsg) && (
        <div className="rounded-xl border border-gray-100 bg-white px-4 py-3 shadow-sm">
          {formError && <ErrorText>{formError}</ErrorText>}
          {okMsg && <p className="text-sm text-green-600">{okMsg}</p>}
        </div>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">班表清單與審核</h2>
            <p className="mt-1 text-sm text-gray-500">可依日期、單位、工時制、員工與狀態查詢，並由 HR 代為確認或標記爭議。</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {STATUS_OPTIONS.map((item) => (
              <span key={item.value} className="rounded-full bg-gray-100 px-3 py-1 text-gray-600">
                {item.label} {summary.get(item.value) ?? 0}
              </span>
            ))}
          </div>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-7">
          <div>
            <label className={labelCls}>起</label>
            <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>訖</label>
            <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>單位</label>
            <select className={inputCls} value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
              <option value="">全部</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>{department.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>工時制 / 身分類別</label>
            <select className={inputCls} value={filterEmploymentType} onChange={(e) => setFilterEmploymentType(e.target.value)}>
              <option value="">全部</option>
              {employmentTypes.map((type) => (
                <option key={type} value={type}>{EMPLOYMENT_TYPE_LABEL[type] ?? type}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>員工</label>
            <select className={inputCls} value={filterEmp} onChange={(e) => setFilterEmp(e.target.value)}>
              <option value="">全部</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.emp_no ? `${emp.emp_no} / ${emp.name}` : emp.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>狀態</label>
            <select className={inputCls} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">全部</option>
              {STATUS_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <PrimaryButton onClick={() => void runQuery()}>查詢</PrimaryButton>
          </div>
        </div>

        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : visibleSchedules.length === 0 ? (
          <Empty>此區間尚無排班</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">日期</th>
                  <th className="py-2 pr-4">單位</th>
                  <th className="py-2 pr-4">工時制</th>
                  <th className="py-2 pr-4">工號/姓名</th>
                  <th className="py-2 pr-4">班別</th>
                  <th className="py-2 pr-4">狀態</th>
                  <th className="py-2">審核動作</th>
                </tr>
              </thead>
              <tbody>
                {visibleSchedules.map((s) => {
                  const employee = employeeById.get(s.employee_id);
                  return (
                    <tr key={s.id} className="border-b border-gray-50">
                      <td className="py-2 pr-4 tabular-nums text-gray-500">{s.work_date}</td>
                      <td className="py-2 pr-4 text-gray-600">
                        {employee?.dept_id ? (deptName.get(employee.dept_id) ?? "未命名單位") : "—"}
                      </td>
                      <td className="py-2 pr-4 text-gray-600">
                        {employee?.employment_type ? (EMPLOYMENT_TYPE_LABEL[employee.employment_type] ?? employee.employment_type) : "—"}
                      </td>
                      <td className="py-2 pr-4 font-medium text-gray-800">{empName.get(s.employee_id) ?? s.employee_id}</td>
                      <td className="py-2 pr-4 text-gray-600">{s.shift_id ? (shiftName.get(s.shift_id) ?? "班別") : "休假／未指定"}</td>
                      <td className="py-2 pr-4">
                        <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">
                          {STATUS_LABEL[s.status] ?? s.status}
                        </span>
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void onReview(s.id, "acknowledge")}
                            disabled={reviewingId === s.id}
                            className="rounded-md border border-green-200 px-3 py-1 text-xs font-medium text-green-700 disabled:opacity-50"
                          >
                            確認
                          </button>
                          <button
                            type="button"
                            onClick={() => void onReview(s.id, "dispute")}
                            disabled={reviewingId === s.id}
                            className="rounded-md border border-amber-200 px-3 py-1 text-xs font-medium text-amber-700 disabled:opacity-50"
                          >
                            標記爭議
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
