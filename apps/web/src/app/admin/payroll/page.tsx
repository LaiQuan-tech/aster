"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, PageHeader, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { apiDownload } from "@/lib/api-client";
import {
  getEmployees,
  getEmployeeProfile,
  getSalaryStructure,
  putSalaryStructure,
  runPayroll,
  getPayslips,
  getPayslip,
  finalizePayslip,
  getNhiDependents,
  addNhiDependent,
  deleteNhiDependent,
  getTaxDependents,
  addTaxDependent,
  deleteTaxDependent,
  type Employee,
  type Payslip,
  type NhiDependent,
  type TaxDependent,
} from "@/lib/admin-api";

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

export default function PayrollAdminPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 員工薪資保險資料
  const [empId, setEmpId] = useState("");
  const [method, setMethod] = useState<"monthly" | "by_attendance_days">("monthly");
  const [baseSalary, setBaseSalary] = useState("");
  const [dailyWage, setDailyWage] = useState("");
  const [hourlyWage, setHourlyWage] = useState("");
  const [laborGrade, setLaborGrade] = useState("");
  const [healthGrade, setHealthGrade] = useState("");
  // 畫面用「%」(0–6)，API 用比例 (0–0.06)
  const [pensionPct, setPensionPct] = useState("");
  const [employeeKeyword, setEmployeeKeyword] = useState("");
  const [employeeIdentityById, setEmployeeIdentityById] = useState<Record<string, string>>({});
  const [salaryMsg, setSalaryMsg] = useState<string | null>(null);
  const [nhiDeps, setNhiDeps] = useState<NhiDependent[]>([]);
  const [taxDeps, setTaxDeps] = useState<TaxDependent[]>([]);
  const [nhiName, setNhiName] = useState("");
  const [nhiRelationship, setNhiRelationship] = useState("");
  const [nhiIdNumber, setNhiIdNumber] = useState("");
  const [nhiInsured, setNhiInsured] = useState(true);
  const [taxName, setTaxName] = useState("");
  const [taxRelationship, setTaxRelationship] = useState("");
  const [taxIdNumber, setTaxIdNumber] = useState("");
  const [taxBirthYear, setTaxBirthYear] = useState("");

  // 執行薪資作業 + 查詢/列印
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const [runPeriod, setRunPeriod] = useState(currentPeriod);
  const [runEmployeeId, setRunEmployeeId] = useState("");
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [listPeriod, setListPeriod] = useState(currentPeriod);
  const [payslips, setPayslips] = useState<Payslip[]>([]);

  const visibleEmployees = useMemo(() => {
    const term = employeeKeyword.trim().toLowerCase();
    if (!term) return employees;
    return employees.filter((employee) => {
      return [employee.name, employee.emp_no, employee.id, employeeIdentityById[employee.id]]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
  }, [employeeIdentityById, employeeKeyword, employees]);

  const payslipSummary = useMemo(() => {
    return payslips.reduce(
      (summary, payslip) => {
        summary.gross += Number(payslip.gross);
        summary.overtime += Number(payslip.overtime_pay);
        summary.night += Number(payslip.night_pay);
        summary.bonus += Number(payslip.attendance_bonus);
        summary.draft += payslip.status === "finalized" ? 0 : 1;
        return summary;
      },
      { gross: 0, overtime: 0, night: 0, bonus: 0, draft: 0 },
    );
  }, [payslips]);

  useEffect(() => {
    let active = true;
    getEmployees()
      .then(async (r) => {
        if (!active) return;
        setEmployees(r.employees);
        const identities = await Promise.all(
          r.employees.map(async (employee) => {
            try {
              const profile = await getEmployeeProfile(employee.id);
              const values = [
                profile.profile?.id_number,
                profile.profile?.id_number2,
                profile.profile?.id_number3,
              ].filter(Boolean);
              return [employee.id, values.join(" / ")] as const;
            } catch {
              return [employee.id, ""] as const;
            }
          }),
        );
        if (active) setEmployeeIdentityById(Object.fromEntries(identities));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "載入員工失敗"));
    return () => {
      active = false;
    };
  }, []);

  const loadEmployee = useCallback(async (id: string) => {
    setSalaryMsg(null);
    setNhiDeps([]);
    setTaxDeps([]);
    if (!id) return;
    // Structure may 404 for a new employee — treat as blank.
    try {
      const { salary } = await getSalaryStructure(id);
      setMethod(salary.method);
      setBaseSalary(salary.base_salary ?? "");
      setDailyWage(salary.daily_wage ?? "");
      setHourlyWage(salary.hourly_wage ?? "");
      setLaborGrade(salary.labor_insured_salary ?? "");
      setHealthGrade(salary.health_insured_salary ?? "");
      setPensionPct(
        salary.pension_voluntary_rate != null
          ? String(Math.round(Number(salary.pension_voluntary_rate) * 10000) / 100)
          : "",
      );
    } catch {
      setMethod("monthly");
      setBaseSalary("");
      setDailyWage("");
      setHourlyWage("");
      setLaborGrade("");
      setHealthGrade("");
      setPensionPct("");
    }
    try {
      const [nhi, tax] = await Promise.all([getNhiDependents(id), getTaxDependents(id)]);
      setNhiDeps(nhi["nhi-dependents"]);
      setTaxDeps(tax["income-tax-dependents"]);
    } catch {
      /* dependents lists are best-effort */
    }
  }, []);

  useEffect(() => {
    void loadEmployee(empId);
  }, [empId, loadEmployee]);

  async function onSaveSalary(e: FormEvent) {
    e.preventDefault();
    if (!empId) return;
    setSalaryMsg(null);
    try {
      await putSalaryStructure(empId, {
        method,
        baseSalary: baseSalary ? Number(baseSalary) : null,
        dailyWage: dailyWage ? Number(dailyWage) : null,
        hourlyWage: hourlyWage ? Number(hourlyWage) : 0,
        laborInsuredSalary: laborGrade ? Number(laborGrade) : null,
        healthInsuredSalary: healthGrade ? Number(healthGrade) : null,
        pensionVoluntaryRate: pensionPct ? Number(pensionPct) / 100 : null,
      });
      setSalaryMsg("已儲存");
    } catch (err) {
      setSalaryMsg(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  async function onAddNhi(e: FormEvent) {
    e.preventDefault();
    if (!empId) return;
    if (!nhiName.trim()) return;
    await addNhiDependent({
      employeeId: empId,
      name: nhiName.trim(),
      relationship: nhiRelationship.trim() || undefined,
      idNumber: nhiIdNumber.trim() || undefined,
      insured: nhiInsured,
    });
    setNhiName("");
    setNhiRelationship("");
    setNhiIdNumber("");
    setNhiInsured(true);
    await loadEmployee(empId);
  }

  async function onAddTax(e: FormEvent) {
    e.preventDefault();
    if (!empId) return;
    if (!taxName.trim()) return;
    await addTaxDependent({
      employeeId: empId,
      name: taxName.trim(),
      relationship: taxRelationship.trim() || undefined,
      idNumber: taxIdNumber.trim() || undefined,
      birthYear: taxBirthYear ? Number(taxBirthYear) : undefined,
    });
    setTaxName("");
    setTaxRelationship("");
    setTaxIdNumber("");
    setTaxBirthYear("");
    await loadEmployee(empId);
  }

  async function onRun(e: FormEvent) {
    e.preventDefault();
    setRunMsg(null);
    try {
      const result = await runPayroll(runPeriod, runEmployeeId || undefined);
      setRunMsg(`已執行 ${runPeriod} 薪資作業：產生 ${result.generated} 筆，略過已定案 ${result.skipped.length} 筆`);
      if (listPeriod === runPeriod) await loadPayslips();
    } catch (err) {
      setRunMsg(err instanceof Error ? err.message : "執行失敗");
    }
  }

  const loadPayslips = useCallback(async () => {
    try {
      const res = await getPayslips(listPeriod || undefined);
      setPayslips(res.payslips);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入薪資單失敗");
    }
  }, [listPeriod]);

  useEffect(() => {
    void loadPayslips();
  }, [loadPayslips]);

  const empName = (id: string) => {
    const employee = employees.find((item) => item.id === id);
    if (!employee) return id.slice(0, 8);
    return employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name;
  };
  const selectedIdentity = empId ? employeeIdentityById[empId] : "";
  const taxStatusLabel = (status: TaxDependent["support_status"]) => (status === "claimed" ? "扶養中" : status);

  async function finalizeAll() {
    const drafts = payslips.filter((payslip) => payslip.status !== "finalized");
    if (drafts.length === 0) return;
    for (const payslip of drafts) {
      await finalizePayslip(payslip.id);
    }
    await loadPayslips();
  }

  async function printPayslip(id: string) {
    try {
      const { payslip } = await getPayslip(id);
      const bd = JSON.stringify(payslip.breakdown ?? {}, null, 2);
      const w = window.open("", "_blank", "width=720,height=900");
      if (!w) return;
      w.document.write(`<!doctype html><html><head><title>薪資單 ${payslip.period}</title>
<style>body{font-family:ui-sans-serif,system-ui,'Noto Sans TC';padding:32px;color:#111}
h1{font-size:20px}table{border-collapse:collapse;width:100%;margin-top:16px}
td,th{border:1px solid #ddd;padding:8px;text-align:left;font-size:14px}
pre{background:#f7f7f7;padding:12px;font-size:12px;overflow:auto}</style></head><body>
<h1>薪資單 — ${empName(payslip.employee_id)}（${payslip.period}）</h1>
<table><tr><th>本薪</th><th>加班費</th><th>夜間加給</th><th>全勤獎金</th><th>應發合計</th></tr>
<tr><td>${payslip.base}</td><td>${payslip.overtime_pay}</td><td>${payslip.night_pay}</td><td>${payslip.attendance_bonus}</td><td><b>${payslip.gross}</b></td></tr></table>
<h2 style="font-size:15px;margin-top:20px">計算明細</h2><pre>${bd.replace(/</g, "&lt;")}</pre>
<script>window.print()</script></body></html>`);
      w.document.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "列印失敗");
    }
  }

  return (
    <>
      <PageHeader title="薪資作業" desc="員工薪資保險資料、執行薪資作業與薪資單查詢" />
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">員工薪資保險資料</h2>
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls}>工號 / 身分證 / 姓名搜尋</label>
            <input
              className={inputCls}
              value={employeeKeyword}
              onChange={(event) => setEmployeeKeyword(event.target.value)}
              placeholder="輸入工號、姓名、身分證或員工 ID"
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>員工</label>
            <select className={inputCls} value={empId} onChange={(event) => setEmpId(event.target.value)}>
              <option value="">請選擇</option>
              {visibleEmployees.map((employee) => (
                <option key={employee.id} value={employee.id}>{empName(employee.id)}</option>
              ))}
            </select>
            {selectedIdentity && (
              <p className="mt-1 text-xs text-gray-500">證件號碼：{selectedIdentity}</p>
            )}
          </div>
        </div>
        {empId && (
          <>
            <form onSubmit={onSaveSalary} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelCls}>計薪方式</label>
                  <select
                    className={inputCls}
                    value={method}
                    onChange={(e) => setMethod(e.target.value as "monthly" | "by_attendance_days")}
                  >
                    <option value="monthly">月薪</option>
                    <option value="by_attendance_days">按出勤天數</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>本薪（月）</label>
                  <input type="number" className={inputCls} value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>日薪</label>
                  <input type="number" className={inputCls} value={dailyWage} onChange={(event) => setDailyWage(event.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>時薪（加班費基準）</label>
                  <input type="number" className={inputCls} value={hourlyWage} onChange={(e) => setHourlyWage(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>勞保投保級距</label>
                  <input type="number" className={inputCls} value={laborGrade} onChange={(e) => setLaborGrade(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>健保投保級距</label>
                  <input type="number" className={inputCls} value={healthGrade} onChange={(e) => setHealthGrade(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>勞退自提率（%，0–6）</label>
                  <input type="number" min={0} max={6} step={0.5} className={inputCls} value={pensionPct} onChange={(e) => setPensionPct(e.target.value)} />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <PrimaryButton type="submit">儲存薪資資料</PrimaryButton>
                {salaryMsg && <span className="text-sm text-green-600">{salaryMsg}</span>}
              </div>
            </form>

            <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-medium text-gray-600">健保眷屬投保資料</h3>
                <form onSubmit={onAddNhi} className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input className={inputCls} value={nhiName} onChange={(event) => setNhiName(event.target.value)} placeholder="眷屬姓名" />
                  <input className={inputCls} value={nhiRelationship} onChange={(event) => setNhiRelationship(event.target.value)} placeholder="關係" />
                  <input className={inputCls} value={nhiIdNumber} onChange={(event) => setNhiIdNumber(event.target.value)} placeholder="身分證字號" />
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <input type="checkbox" checked={nhiInsured} onChange={(event) => setNhiInsured(event.target.checked)} />
                    投保中
                  </label>
                  <button type="submit" className="rounded-md border px-3 py-2 text-sm font-medium" style={{ color: "var(--brand)" }}>
                    新增健保眷屬
                  </button>
                </form>
                <ul className="divide-y divide-gray-100 text-sm">
                  {nhiDeps.map((d) => (
                    <li key={d.id} className="flex items-center justify-between py-1.5">
                      <span>
                        {d.name}
                        <span className="text-xs text-gray-500">
                          {" "}｜{d.relationship ?? "—"}｜{d.id_number ?? "無證號"}｜{d.insured ? "投保中" : "未投保"}
                        </span>
                      </span>
                      <button onClick={() => deleteNhiDependent(d.id).then(() => loadEmployee(empId))} className="text-red-600 hover:underline">刪除</button>
                    </li>
                  ))}
                  {nhiDeps.length === 0 && <li className="py-1.5 text-gray-400">無</li>}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium text-gray-600">所得稅扶養親屬資料</h3>
                <form onSubmit={onAddTax} className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input className={inputCls} value={taxName} onChange={(event) => setTaxName(event.target.value)} placeholder="親屬姓名" />
                  <input className={inputCls} value={taxRelationship} onChange={(event) => setTaxRelationship(event.target.value)} placeholder="關係" />
                  <input className={inputCls} value={taxIdNumber} onChange={(event) => setTaxIdNumber(event.target.value)} placeholder="身分證字號" />
                  <input className={inputCls} type="number" value={taxBirthYear} onChange={(event) => setTaxBirthYear(event.target.value)} placeholder="出生年" />
                  <button type="submit" className="rounded-md border px-3 py-2 text-sm font-medium" style={{ color: "var(--brand)" }}>
                    新增扶養親屬
                  </button>
                </form>
                <ul className="divide-y divide-gray-100 text-sm">
                  {taxDeps.map((d) => (
                    <li key={d.id} className="flex items-center justify-between py-1.5">
                      <span>
                        {d.name}
                        <span className="text-xs text-gray-500">
                          {" "}｜{d.relationship ?? "—"}｜{d.id_number ?? "無證號"}｜出生年 {d.birth_year ?? "—"}｜{taxStatusLabel(d.support_status)}
                        </span>
                      </span>
                      <button onClick={() => deleteTaxDependent(d.id).then(() => loadEmployee(empId))} className="text-red-600 hover:underline">停用扶養</button>
                    </li>
                  ))}
                  {taxDeps.length === 0 && <li className="py-1.5 text-gray-400">無</li>}
                </ul>
              </div>
            </div>
          </>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">執行薪資/獎金作業</h2>
        <form onSubmit={onRun} className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>薪資期間</label>
            <input type="month" className={inputCls} value={runPeriod} onChange={(e) => setRunPeriod(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>執行對象</label>
            <select className={inputCls} value={runEmployeeId} onChange={(event) => setRunEmployeeId(event.target.value)}>
              <option value="">全部員工</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>{empName(employee.id)}</option>
              ))}
            </select>
          </div>
          <PrimaryButton type="submit">執行</PrimaryButton>
          {runMsg && <span className="text-sm text-green-600">{runMsg}</span>}
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">查詢/列印（薪資單）</h2>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>期間</label>
            <input type="month" className={inputCls} value={listPeriod} onChange={(e) => setListPeriod(e.target.value)} />
          </div>
          <PrimaryButton type="button" onClick={() => void loadPayslips()}>查詢</PrimaryButton>
          <button
            type="button"
            onClick={() => apiDownload(`/reports/payroll?period=${listPeriod}&format=csv`, `薪資報表_${listPeriod}.csv`).catch((downloadError) => setError(downloadError.message))}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            匯出 CSV
          </button>
          <button
            type="button"
            onClick={() => void finalizeAll()}
            disabled={payslipSummary.draft === 0}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            全部定案
          </button>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">應發合計</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{payslipSummary.gross}</p>
          </div>
          <div className="rounded-xl bg-blue-50 p-4">
            <p className="text-xs text-blue-600">加班費</p>
            <p className="mt-1 text-xl font-semibold text-blue-700">{payslipSummary.overtime}</p>
          </div>
          <div className="rounded-xl bg-indigo-50 p-4">
            <p className="text-xs text-indigo-600">夜間加給</p>
            <p className="mt-1 text-xl font-semibold text-indigo-700">{payslipSummary.night}</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-4">
            <p className="text-xs text-amber-700">草稿筆數</p>
            <p className="mt-1 text-xl font-semibold text-amber-800">{payslipSummary.draft}</p>
          </div>
        </div>
        {payslips.length === 0 ? (
          <Empty>查無薪資單</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">員工</th>
                  <th className="py-2 pr-4">期間</th>
                  <th className="py-2 pr-4">本薪</th>
                  <th className="py-2 pr-4">加班費</th>
                  <th className="py-2 pr-4">夜間加給</th>
                  <th className="py-2 pr-4">全勤獎金</th>
                  <th className="py-2 pr-4">應發合計</th>
                  <th className="py-2 pr-4">狀態</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {payslips.map((p) => (
                  <tr key={p.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-800">{empName(p.employee_id)}</td>
                    <td className="py-2 pr-4">{p.period}</td>
                    <td className="py-2 pr-4">{p.base}</td>
                    <td className="py-2 pr-4">{p.overtime_pay}</td>
                    <td className="py-2 pr-4">{p.night_pay}</td>
                    <td className="py-2 pr-4">{p.attendance_bonus}</td>
                    <td className="py-2 pr-4 font-medium">{p.gross}</td>
                    <td className="py-2 pr-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${p.status === "finalized" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                        {p.status === "finalized" ? "已定案" : "草稿"}
                      </span>
                    </td>
                    <td className="py-2">
                      <button onClick={() => printPayslip(p.id)} className="mr-3 text-sm text-gray-600 hover:underline">
                        列印
                      </button>
                      {p.status !== "finalized" && (
                        <button
                          onClick={() => finalizePayslip(p.id).then(() => loadPayslips())}
                          className="text-sm font-medium"
                          style={{ color: "var(--brand)" }}
                        >
                          定案
                        </button>
                      )}
                    </td>
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
