"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import {
  getEmployees,
  getEmployeeProfile,
  getSalaryStructure,
  putSalaryStructure,
  runPayroll,
  getNhiDependents,
  addNhiDependent,
  deleteNhiDependent,
  getTaxDependents,
  addTaxDependent,
  deleteTaxDependent,
  type Employee,
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
  const [method, setMethod] = useState<"monthly" | "by_attendance_days" | "hourly">("monthly");
  const [baseSalary, setBaseSalary] = useState("");
  const [dailyWage, setDailyWage] = useState("");
  const [hourlyWage, setHourlyWage] = useState("");
  // 工讀生時薪制(C5)的約定每週工時／工天數；純參考用途，不影響薪資試算。
  const [agreedHoursPerWeek, setAgreedHoursPerWeek] = useState("");
  const [agreedDaysPerWeek, setAgreedDaysPerWeek] = useState("");
  const [laborGrade, setLaborGrade] = useState("");
  const [healthGrade, setHealthGrade] = useState("");
  // 畫面用「%」(0–6)，API 用比例 (0–0.06)
  const [pensionPct, setPensionPct] = useState("");
  const [employeeKeyword, setEmployeeKeyword] = useState("");
  const [employeeIdentityById, setEmployeeIdentityById] = useState<Record<string, string>>({});
  const [salaryMsg, setSalaryMsg] = useState<string | null>(null);
  // M12：API 依投保級距表自動選出來的級距（留空投保薪資時才會回）。
  const [insuredHint, setInsuredHint] = useState<string | null>(null);
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

  // 執行薪資作業（查詢／列印／定案在薪資明細表 /admin/payslips）
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const [runPeriod, setRunPeriod] = useState(currentPeriod);
  const [runEmployeeId, setRunEmployeeId] = useState("");
  const [runMsg, setRunMsg] = useState<string | null>(null);

  const visibleEmployees = useMemo(() => {
    const term = employeeKeyword.trim().toLowerCase();
    if (!term) return employees;
    return employees.filter((employee) => {
      return [employee.name, employee.emp_no, employee.id, employeeIdentityById[employee.id]]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
  }, [employeeIdentityById, employeeKeyword, employees]);

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
    setInsuredHint(null);
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
      setAgreedHoursPerWeek(salary.agreed_hours_per_week ?? "");
      setAgreedDaysPerWeek(salary.agreed_days_per_week ?? "");
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
      setAgreedHoursPerWeek("");
      setAgreedDaysPerWeek("");
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
    setInsuredHint(null);
    try {
      // M12：投保級距留空＝不帶欄位，API 會依「投保級距表」以投保基數自動選一級
      //（月薪制基數＝本薪；時薪制＝時薪 × 每週約定時數 × 52 ÷ 12），並把選到的值回來。
      // 填了就完全照填的存，手動覆寫永遠優先。
      const res = await putSalaryStructure(empId, {
        method,
        baseSalary: baseSalary ? Number(baseSalary) : null,
        dailyWage: dailyWage ? Number(dailyWage) : null,
        hourlyWage: hourlyWage ? Number(hourlyWage) : 0,
        agreedHoursPerWeek: agreedHoursPerWeek ? Number(agreedHoursPerWeek) : null,
        agreedDaysPerWeek: agreedDaysPerWeek ? Number(agreedDaysPerWeek) : null,
        ...(laborGrade ? { laborInsuredSalary: Number(laborGrade) } : {}),
        ...(healthGrade ? { healthInsuredSalary: Number(healthGrade) } : {}),
        pensionVoluntaryRate: pensionPct ? Number(pensionPct) / 100 : null,
      });
      setSalaryMsg("已儲存");
      const s = res.insuredSuggested;
      if (s) {
        if (!laborGrade && s.labor !== null) setLaborGrade(String(s.labor));
        if (!healthGrade && s.health !== null) setHealthGrade(String(s.health));
        setInsuredHint(
          `已依投保級距表（${s.effectiveFrom} 生效）自動選級距：投保基數 ${s.base.toLocaleString("zh-TW")}` +
            `　勞保 ${s.labor === null ? "—" : s.labor.toLocaleString("zh-TW")}` +
            `　健保 ${s.health === null ? "—" : s.health.toLocaleString("zh-TW")}。要改就直接覆寫欄位再存一次。`,
        );
      }
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
    } catch (err) {
      setRunMsg(err instanceof Error ? err.message : "執行失敗");
    }
  }

  const empName = (id: string) => {
    const employee = employees.find((item) => item.id === id);
    if (!employee) return id.slice(0, 8);
    return employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name;
  };
  const selectedIdentity = empId ? employeeIdentityById[empId] : "";
  const taxStatusLabel = (status: TaxDependent["support_status"]) => (status === "claimed" ? "扶養中" : status);

  return (
    <>
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
                    onChange={(e) => setMethod(e.target.value as "monthly" | "by_attendance_days" | "hourly")}
                  >
                    <option value="monthly">月薪</option>
                    <option value="by_attendance_days">按出勤天數</option>
                    <option value="hourly">時薪制</option>
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
                  <label className={labelCls}>{method === "hourly" ? "時薪（本俸＋加班費基準）" : "時薪（加班費基準）"}</label>
                  <input type="number" className={inputCls} value={hourlyWage} onChange={(e) => setHourlyWage(e.target.value)} />
                </div>
                {method === "hourly" && (
                  <>
                    <div>
                      <label className={labelCls}>約定每週工時（小時）</label>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        className={inputCls}
                        value={agreedHoursPerWeek}
                        onChange={(e) => setAgreedHoursPerWeek(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>約定每週工天數</label>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        className={inputCls}
                        value={agreedDaysPerWeek}
                        onChange={(e) => setAgreedDaysPerWeek(e.target.value)}
                      />
                    </div>
                  </>
                )}
                <div>
                  <label className={labelCls}>勞保投保級距（留空＝依級距表自動選）</label>
                  <input type="number" className={inputCls} value={laborGrade} onChange={(e) => setLaborGrade(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>健保投保級距（留空＝依級距表自動選）</label>
                  <input type="number" className={inputCls} value={healthGrade} onChange={(e) => setHealthGrade(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>勞退自提率（%，0–6）</label>
                  <input type="number" min={0} max={6} step={0.5} className={inputCls} value={pensionPct} onChange={(e) => setPensionPct(e.target.value)} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <PrimaryButton type="submit">儲存薪資資料</PrimaryButton>
                {salaryMsg && <span className="text-sm text-green-600">{salaryMsg}</span>}
              </div>
              {insuredHint && (
                <p className="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-800">{insuredHint}</p>
              )}
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
        <p className="text-sm text-gray-600">
          薪資單的查詢、逐項明細、列印、匯出工資清冊與定案，都在
          <Link href="/admin/payslips" className="ml-1 font-medium hover:underline" style={{ color: "var(--brand)" }}>
            薪資明細表
          </Link>
          。
        </p>
      </Card>
    </>
  );
}
