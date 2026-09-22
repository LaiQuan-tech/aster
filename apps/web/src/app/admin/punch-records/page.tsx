"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { BatchImportButton } from "@/components/BatchImport";
import { fmtHm, localDateKey } from "@/lib/ess-format";
import {
  getPunchRecordsAdmin,
  createManualPunch,
  getEmployees,
  getDepartments,
  type PunchRecord,
  type Employee,
  type Department,
} from "@/lib/admin-api";

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

const SOURCE_LABEL: Record<string, string> = {
  gps: "定位打卡",
  web: "網頁打卡",
  line: "LINE 打卡",
  manual: "補登",
};

const TYPE_LABEL: Record<PunchRecord["type"], string> = {
  in: "上班",
  out: "下班",
  break_in: "休息開始",
  break_out: "休息結束",
  outing_in: "外出開始",
  outing_out: "外出結束",
};

const TYPE_GROUPS: { label: string; value: "" | PunchRecord["type"] }[] = [
  { label: "全部", value: "" },
  { label: "上班", value: "in" },
  { label: "下班", value: "out" },
  { label: "休息開始", value: "break_in" },
  { label: "休息結束", value: "break_out" },
  { label: "外出開始", value: "outing_in" },
  { label: "外出結束", value: "outing_out" },
];

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export default function PunchRecordsPage() {
  const [records, setRecords] = useState<PunchRecord[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 打卡紀錄維護 filters: 資料類型/日期/單位/工號姓名/地點/打卡方式.
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [fEmp, setFEmp] = useState("");
  const [fDept, setFDept] = useState("");
  const [fType, setFType] = useState<"" | PunchRecord["type"]>("");
  const [fSource, setFSource] = useState<"" | "gps" | "web" | "line" | "manual">("");
  const [locationOnly, setLocationOnly] = useState(false);
  const [fFrom, setFFrom] = useState(weekAgo);
  const [fTo, setFTo] = useState(today);

  // 補登 form
  const [mEmp, setMEmp] = useState("");
  const [mAt, setMAt] = useState("");
  const [mType, setMType] = useState<PunchRecord["type"]>("in");
  const [mMsg, setMMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getPunchRecordsAdmin({
        employeeId: fEmp || undefined,
        deptId: fDept || undefined,
        type: fType || undefined,
        source: fSource || undefined,
        from: fFrom || undefined,
        to: fTo || undefined,
      });
      setRecords(locationOnly ? res.records.filter((record) => record.lat != null && record.lng != null) : res.records);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [fDept, fEmp, fFrom, fSource, fTo, fType, locationOnly]);

  useEffect(() => {
    Promise.all([getEmployees(), getDepartments()])
      .then(([employeeRes, departmentRes]) => {
        setEmployees(employeeRes.employees);
        setDepartments(departmentRes.departments);
      })
      .catch(() => null);
    void load();
  }, [load]);

  const deptName = (employeeId: string) => {
    const employee = employees.find((item) => item.id === employeeId);
    return departments.find((dept) => dept.id === employee?.dept_id)?.name ?? "—";
  };
  const empLabel = (id: string) => {
    const employee = employees.find((item) => item.id === id);
    if (!employee) return id.slice(0, 8);
    return employee.emp_no ? `${employee.emp_no} / ${employee.name}` : employee.name;
  };
  const locationText = (record: PunchRecord) =>
    record.lat != null && record.lng != null
      ? `${record.lat.toFixed(5)}, ${record.lng.toFixed(5)}`
      : "—";

  const sourceSummary = useMemo(() => {
    const totals = new Map<string, number>();
    for (const record of records) totals.set(record.source ?? "unknown", (totals.get(record.source ?? "unknown") ?? 0) + 1);
    return totals;
  }, [records]);

  const typeSummary = useMemo(() => {
    const totals = new Map<PunchRecord["type"], number>();
    for (const record of records) totals.set(record.type, (totals.get(record.type) ?? 0) + 1);
    return totals;
  }, [records]);

  async function onManual(e: FormEvent) {
    e.preventDefault();
    setMMsg(null);
    if (!mEmp || !mAt) {
      setMMsg("請選擇員工與時間");
      return;
    }
    try {
      await createManualPunch({ employeeId: mEmp, punchAt: new Date(mAt).toISOString(), type: mType });
      setMMsg("補登完成");
      setMAt("");
      await load();
    } catch (err) {
      setMMsg(err instanceof Error ? err.message : "補登失敗");
    }
  }

  function exportCsv() {
    const header = ["department", "employee", "date", "time", "type", "source", "lat", "lng", "deviceId"];
    const rows = records.map((record) => [
      deptName(record.employee_id),
      empLabel(record.employee_id),
      localDateKey(record.punch_at) || record.punch_at.slice(0, 10),
      fmtHm(record.punch_at),
      TYPE_LABEL[record.type],
      SOURCE_LABEL[record.source ?? ""] ?? record.source ?? "",
      record.lat,
      record.lng,
      record.device_id,
    ]);
    const content = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `punch-records-${fFrom || "all"}-${fTo || "all"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">打卡補登</h2>
            <p className="mt-1 text-sm text-gray-500">支援忘打卡補登與休息/外出紀錄補登。</p>
          </div>
          <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
            source = manual
          </span>
        </div>
        <form onSubmit={onManual} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label className={labelCls}>員工</label>
              <select className={inputCls} value={mEmp} onChange={(e) => setMEmp(e.target.value)}>
                <option value="">請選擇</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>時間</label>
              <input type="datetime-local" className={inputCls} value={mAt} onChange={(e) => setMAt(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>類型</label>
              <select className={inputCls} value={mType} onChange={(e) => setMType(e.target.value as PunchRecord["type"])}>
                <option value="in">上班</option>
                <option value="out">下班</option>
                <option value="break_in">休息開始</option>
                <option value="break_out">休息結束</option>
                <option value="outing_in">外出開始</option>
                <option value="outing_out">外出結束</option>
              </select>
            </div>
            <div className="flex items-end">
              <PrimaryButton type="submit">補登</PrimaryButton>
            </div>
          </div>
          {mMsg && <p className="text-sm text-green-600">{mMsg}</p>}
        </form>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">打卡紀錄</h2>
            <p className="mt-1 text-sm text-gray-500">資料類型、日期、單位、工號姓名、地點與打卡方式皆可查詢。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* 批次補登改成「下載 Excel 範本 → 填完上傳」的面板，不再在頁面放大貼文字框。 */}
            <BatchImportButton kind="punches" label="批次補登" onDone={load} />
            <button
              type="button"
              onClick={exportCsv}
              disabled={records.length === 0}
              className="rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
            >
              匯出 CSV
            </button>
            <div className="text-sm text-gray-500">共 {records.length} 筆</div>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-xs text-gray-500">上班/下班</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">
              {(typeSummary.get("in") ?? 0) + (typeSummary.get("out") ?? 0)}
            </p>
          </div>
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-xs text-gray-500">休息/外出</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">
              {(typeSummary.get("break_in") ?? 0) +
                (typeSummary.get("break_out") ?? 0) +
                (typeSummary.get("outing_in") ?? 0) +
                (typeSummary.get("outing_out") ?? 0)}
            </p>
          </div>
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-xs text-gray-500">補登</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">{sourceSummary.get("manual") ?? 0}</p>
          </div>
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-xs text-gray-500">有定位</p>
            <p className="mt-1 text-lg font-semibold text-gray-900">
              {records.filter((record) => record.lat != null && record.lng != null).length}
            </p>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {TYPE_GROUPS.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => setFType(item.value)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                fType === item.value ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
              style={fType === item.value ? { backgroundColor: "var(--brand)" } : undefined}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-6">
          <div>
            <label className={labelCls}>單位</label>
            <select className={inputCls} value={fDept} onChange={(e) => setFDept(e.target.value)}>
              <option value="">全部</option>
              {departments.map((dept) => (
                <option key={dept.id} value={dept.id}>{dept.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>員工</label>
            <select className={inputCls} value={fEmp} onChange={(e) => setFEmp(e.target.value)}>
              <option value="">全部</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>查詢日期（起）</label>
            <input type="date" className={inputCls} value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>查詢日期（迄）</label>
            <input type="date" className={inputCls} value={fTo} onChange={(e) => setFTo(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>打卡方式</label>
            <select className={inputCls} value={fSource} onChange={(e) => setFSource(e.target.value as "" | "gps" | "web" | "line" | "manual")}>
              <option value="">全部</option>
              <option value="gps">定位打卡</option>
              <option value="web">網頁打卡</option>
              <option value="line">LINE 打卡</option>
              <option value="manual">補登</option>
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-600">
              <input type="checkbox" checked={locationOnly} onChange={(e) => setLocationOnly(e.target.checked)} />
              有地點
            </label>
          </div>
          <div className="flex items-end">
            <PrimaryButton type="button" onClick={() => void load()}>搜尋</PrimaryButton>
          </div>
        </div>
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : records.length === 0 ? (
          <Empty>查無資料</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">單位</th>
                  <th className="py-2 pr-4">工號/姓名</th>
                  <th className="py-2 pr-4">日期</th>
                  <th className="py-2 pr-4">時間</th>
                  <th className="py-2 pr-4">資料類型</th>
                  <th className="py-2 pr-4">地點</th>
                  <th className="py-2 pr-4">打卡方式</th>
                  <th className="py-2">裝置</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4">{deptName(r.employee_id)}</td>
                    <td className="py-2 pr-4 font-medium text-gray-800">{empLabel(r.employee_id)}</td>
                    <td className="py-2 pr-4">{localDateKey(r.punch_at) || r.punch_at.slice(0, 10)}</td>
                    <td className="py-2 pr-4">{fmtHm(r.punch_at)}</td>
                    <td className="py-2 pr-4">{TYPE_LABEL[r.type]}</td>
                    <td className="py-2 pr-4">{locationText(r)}</td>
                    <td className="py-2 pr-4">{SOURCE_LABEL[r.source ?? ""] ?? r.source ?? "—"}</td>
                    <td className="py-2">{r.device_id ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
