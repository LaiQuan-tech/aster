"use client";

/**
 * 員工內頁「薪資」分頁（2026-11-09 月結發薪合併）：原 /admin/payroll「員工薪資保險資料」卡整張搬過來——
 * 計薪方式、本薪／日薪／時薪、勞健保投保級距、勞退自提率與月提繳工資、固定津貼、健保眷屬、所得稅扶養親屬。
 * 只給 HR／平台管理員（員工內頁的 canManage）；API 端守門不變。
 */
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { BottomSheet, Button, Card, ErrorText, PrimaryButton } from "@/components/admin-ui";
import {
  getSalaryStructure,
  putSalaryStructure,
  getNhiDependents,
  addNhiDependent,
  deleteNhiDependent,
  getTaxDependents,
  addTaxDependent,
  deleteTaxDependent,
  type NhiDependent,
  type TaxDependent,
} from "@/lib/admin-api";
import { buildNhiDependentBody, buildTaxDependentBody, dependentErrorMessage } from "@/lib/payroll-dependents";
import { pensionWageHintText, pensionWageInputCheck, type FixedAllowanceSummary } from "@/lib/fixed-allowances-api";
import { FixedAllowancesCard } from "../../payroll/_components/FixedAllowancesCard";
import { salaryFormChanges, todayDateKey, type SalaryFormValues } from "@/lib/salary-history";
import { SalaryHistorySection } from "./SalaryHistorySection";

const inputCls =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

export function EmployeePayrollPanel({ employeeId }: { employeeId: string }) {
  const empId = employeeId;

  // 員工薪資保險資料
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
  // 2026-11-08 勞退月提繳工資（空白＝依分級表自動算）／適用勞退新制。loaded* 是讀進來的值：沒改就不送，
  // migration 0086 還沒套用的環境存薪資資料才不會被 409 擋下。
  const [pensionWage, setPensionWage] = useState("");
  const [pensionNewSystem, setPensionNewSystem] = useState(true);
  const [loadedPension, setLoadedPension] = useState<{ wage: string; newSystem: boolean }>({ wage: "", newSystem: true });
  const [allowanceSummary, setAllowanceSummary] = useState<FixedAllowanceSummary | null>(null);
  const [allowanceReloadKey, setAllowanceReloadKey] = useState(0);
  const [salaryMsg, setSalaryMsg] = useState<string | null>(null);
  // 2026-11-10 調薪／投保調整歷程：讀進來的本薪與投保三項（存檔前比對，有變就先問生效日與原因）。
  const [loadedValues, setLoadedValues] = useState<SalaryFormValues>({ baseSalary: "", laborGrade: "", healthGrade: "", pensionWage: "" });
  const [changePrompt, setChangePrompt] = useState<{ base: boolean; insured: boolean } | null>(null);
  const [changeDate, setChangeDate] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
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
  // 「＋ 新增」子表單預設收起（比照員工詳細資料的學歷／證照）。收合只是 hidden、不卸載，
  // 填到一半的欄位會保留；送出成功後照舊清空欄位但維持展開，方便連續新增。
  const [showNhiForm, setShowNhiForm] = useState(false);
  const [showTaxForm, setShowTaxForm] = useState(false);
  // 兩個子表單各自的送出狀態與錯誤：錯誤顯示在各自面板裡（姓名空白的提示也走這裡）。改任何欄位、重新送出、
  // 換員工時清掉；送出中停用按鈕防連點。失敗時欄位原樣保留，方便修正後重送。
  const [nhiSubmitting, setNhiSubmitting] = useState(false);
  const [nhiError, setNhiError] = useState<string | null>(null);
  const [taxSubmitting, setTaxSubmitting] = useState(false);
  const [taxError, setTaxError] = useState<string | null>(null);
  const nhiPanelId = useId();
  const taxPanelId = useId();

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
      const wage = salary.pension_wage != null && Number(salary.pension_wage) > 0 ? String(Number(salary.pension_wage)) : "";
      const newSystem = salary.pension_new_system !== false;
      setPensionWage(wage);
      setPensionNewSystem(newSystem);
      setLoadedPension({ wage, newSystem });
      setLoadedValues({
        baseSalary: salary.base_salary ?? "",
        laborGrade: salary.labor_insured_salary ?? "",
        healthGrade: salary.health_insured_salary ?? "",
        pensionWage: wage,
      });
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
      setPensionWage("");
      setPensionNewSystem(true);
      setLoadedPension({ wage: "", newSystem: true });
      setLoadedValues({ baseSalary: "", laborGrade: "", healthGrade: "", pensionWage: "" });
    }
    try {
      const [nhi, tax] = await Promise.all([getNhiDependents(id), getTaxDependents(id)]);
      setNhiDeps(nhi["nhi-dependents"]);
      setTaxDeps(tax["income-tax-dependents"]);
    } catch {
      /* dependents lists are best-effort */
    }
  }, []);

  async function onSaveSalary(e: FormEvent) {
    e.preventDefault();
    if (!empId || saving) return;
    setSalaryMsg(null);
    setInsuredHint(null);
    const wageCheck = pensionWageInputCheck(pensionWage, allowanceSummary?.pension?.levels);
    if (wageCheck.error) {
      setSalaryMsg(wageCheck.error);
      return;
    }
    // 本薪或投保三項有變 → 先問生效日（預設今天）與原因，確認後才存（存檔時 API 寫一筆調薪／投保調整紀錄）。
    const changes = salaryFormChanges(loadedValues, { baseSalary, laborGrade, healthGrade, pensionWage: pensionWage.trim() });
    if (changes.base || changes.insured) {
      setChangeDate(todayDateKey());
      setChangeReason("");
      setChangeNote("");
      setChangeError(null);
      setChangePrompt(changes);
      return;
    }
    await saveSalary();
  }

  async function onConfirmChange() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(changeDate)) {
      setChangeError("請填生效日");
      return;
    }
    const ok = await saveSalary({ effectiveDate: changeDate, reason: changeReason.trim() || null, note: changeNote.trim() || null });
    if (ok) setChangePrompt(null);
  }

  async function saveSalary(change?: { effectiveDate: string; reason: string | null; note: string | null }): Promise<boolean> {
    if (!empId) return false;
    setSaving(true);
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
        ...(pensionWage.trim() !== loadedPension.wage ? { pensionWage: pensionWage.trim() ? Math.round(Number(pensionWage)) : null } : {}),
        ...(pensionNewSystem !== loadedPension.newSystem ? { pensionNewSystem } : {}),
        ...(change ? { change } : {}),
      });
      setLoadedPension({ wage: pensionWage.trim(), newSystem: pensionNewSystem });
      setAllowanceReloadKey((n) => n + 1);
      setHistoryReloadKey((n) => n + 1);
      const warn = res.history?.warnings?.length ? `（${res.history.warnings.join(" ")}）` : "";
      setSalaryMsg(`已儲存${warn}`);
      const s = res.insuredSuggested;
      const savedLabor = !laborGrade && s?.labor != null ? String(s.labor) : laborGrade;
      const savedHealth = !healthGrade && s?.health != null ? String(s.health) : healthGrade;
      setLoadedValues({ baseSalary, laborGrade: savedLabor, healthGrade: savedHealth, pensionWage: pensionWage.trim() });
      if (s) {
        if (!laborGrade && s.labor !== null) setLaborGrade(String(s.labor));
        if (!healthGrade && s.health !== null) setHealthGrade(String(s.health));
        setInsuredHint(
          `已依投保級距表（${s.effectiveFrom} 生效）自動選級距：投保基數 ${s.base.toLocaleString("zh-TW")}` +
            `　勞保 ${s.labor === null ? "—" : s.labor.toLocaleString("zh-TW")}` +
            `　健保 ${s.health === null ? "—" : s.health.toLocaleString("zh-TW")}。要改就直接覆寫欄位再存一次。`,
        );
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "儲存失敗";
      setSalaryMsg(msg);
      if (change) setChangeError(msg);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function onAddNhi(e: FormEvent) {
    e.preventDefault();
    if (!empId || nhiSubmitting) return;
    const built = buildNhiDependentBody(empId, {
      name: nhiName,
      relationship: nhiRelationship,
      idNumber: nhiIdNumber,
      insured: nhiInsured,
    });
    if (!built.ok) {
      setNhiError(built.error);
      return;
    }
    setNhiError(null);
    setNhiSubmitting(true);
    try {
      await addNhiDependent(built.body);
    } catch (err) {
      // 面板若在送出途中被收起，錯誤掛在 hidden 的面板裡就看不到，所以失敗時順手展開。
      setNhiError(dependentErrorMessage(err, "新增健保眷屬"));
      setShowNhiForm(true);
      setNhiSubmitting(false);
      return;
    }
    setNhiName("");
    setNhiRelationship("");
    setNhiIdNumber("");
    setNhiInsured(true);
    await loadEmployee(empId);
    setNhiSubmitting(false);
  }

  async function onAddTax(e: FormEvent) {
    e.preventDefault();
    if (!empId || taxSubmitting) return;
    const built = buildTaxDependentBody(empId, {
      name: taxName,
      relationship: taxRelationship,
      idNumber: taxIdNumber,
      birthYear: taxBirthYear,
    });
    if (!built.ok) {
      setTaxError(built.error);
      return;
    }
    setTaxError(null);
    setTaxSubmitting(true);
    try {
      await addTaxDependent(built.body);
    } catch (err) {
      setTaxError(dependentErrorMessage(err, "新增扶養親屬"));
      setShowTaxForm(true);
      setTaxSubmitting(false);
      return;
    }
    setTaxName("");
    setTaxRelationship("");
    setTaxIdNumber("");
    setTaxBirthYear("");
    await loadEmployee(empId);
    setTaxSubmitting(false);
  }

  useEffect(() => {
    // 換員工時清掉上一位的新增錯誤。
    setNhiError(null);
    setTaxError(null);
    void loadEmployee(empId);
  }, [empId, loadEmployee]);

  const taxStatusLabel = (status: TaxDependent["support_status"]) => (status === "claimed" ? "扶養中" : status);

  return (
    <Card>
      <h2 className="mb-4 text-sm font-medium text-gray-500">員工薪資保險資料</h2>
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
            <div>
              <label className={labelCls}>勞退月提繳工資（留空＝依分級表自動算）</label>
              <input
                type="number"
                min={1}
                max={150000}
                step={1}
                className={inputCls}
                value={pensionWage}
                disabled={!pensionNewSystem}
                placeholder={allowanceSummary?.pension?.autoWage != null ? `自動：${allowanceSummary.pension.autoWage}` : ""}
                onChange={(e) => setPensionWage(e.target.value)}
                data-testid="pension-wage"
              />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-gray-600">
              <input type="checkbox" checked={pensionNewSystem} onChange={(e) => setPensionNewSystem(e.target.checked)} data-testid="pension-new-system" />
              適用勞退新制（取消＝雇主提撥與自提都為 0）
            </label>
          </div>
          {(() => {
            const hint = pensionWageHintText(
              allowanceSummary?.pension ? { ...allowanceSummary.pension, newSystem: pensionNewSystem } : null,
              pensionWage,
            );
            return hint ? <p className="text-xs text-gray-500">{hint} 雇主提撥與勞工自提都以此為基數。</p> : null;
          })()}
          {(() => {
            const w = pensionWageInputCheck(pensionWage, allowanceSummary?.pension?.levels);
            const text = w.error ?? w.warning;
            return text ? (
              <p className={`rounded-md px-3 py-2 text-xs ${w.error ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-800"}`} data-testid="pension-wage-level-hint">
                {text}
              </p>
            ) : null;
          })()}
          {allowanceSummary?.pension?.nationalityHint && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="pension-nationality-hint">
              {allowanceSummary.pension.nationalityHint}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton type="submit" disabled={saving}>{saving ? "儲存中…" : "儲存薪資資料"}</PrimaryButton>
            {salaryMsg && <span className="text-sm text-green-600">{salaryMsg}</span>}
          </div>
          {insuredHint && (
            <p className="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-800">{insuredHint}</p>
          )}
        </form>

        <BottomSheet
          open={changePrompt !== null}
          onClose={() => (saving ? undefined : setChangePrompt(null))}
          title={changePrompt?.base && changePrompt?.insured ? "本薪與投保薪資有變動" : changePrompt?.base ? "本薪有變動" : "投保薪資有變動"}
        >
          <div className="space-y-3" data-testid="salary-change-dialog">
            <p className="text-sm text-gray-600">
              存檔後會寫一筆{changePrompt?.base ? "「調薪紀錄」" : ""}
              {changePrompt?.base && changePrompt?.insured ? "與" : ""}
              {changePrompt?.insured ? "「勞健保調整紀錄」" : ""}
              ，請填生效日。只是紀錄，不影響薪資計算。
            </p>
            <div>
              <label className={labelCls}>生效日</label>
              <input type="date" className={inputCls} value={changeDate} onChange={(e) => { setChangeDate(e.target.value); setChangeError(null); }} data-testid="salary-change-date" />
            </div>
            {changePrompt?.base && (
              <div>
                <label className={labelCls}>調薪原因（選填）</label>
                <input className={inputCls} maxLength={500} value={changeReason} onChange={(e) => setChangeReason(e.target.value)} placeholder="例：年度調薪、職務調整" />
              </div>
            )}
            {changePrompt?.insured && (
              <div>
                <label className={labelCls}>投保調整原因／備註（選填）</label>
                <input className={inputCls} maxLength={500} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="例：投保薪資調整" />
              </div>
            )}
            {changeError && <ErrorText>{changeError}</ErrorText>}
            <div className="grid grid-cols-2 gap-3 pt-2">
              <Button variant="secondary" type="button" onClick={() => setChangePrompt(null)} disabled={saving}>
                取消
              </Button>
              <Button type="button" onClick={() => void onConfirmChange()} loading={saving}>
                儲存
              </Button>
            </div>
          </div>
        </BottomSheet>

        {/* 2026-11-08 員工固定津貼：每月執行薪資時自動帶入；合計提示用上方表單目前的本薪與勞保級距。 */}
        <FixedAllowancesCard
          employeeId={empId}
          baseSalary={baseSalary}
          laborGrade={laborGrade}
          onSummary={setAllowanceSummary}
          reloadKey={allowanceReloadKey}
        />

        {/* 2026-11-10 調薪歷程＋勞健保調整歷程 */}
        <SalaryHistorySection employeeId={empId} reloadKey={historyReloadKey} />

        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <h3 className="text-sm font-medium text-gray-600">健保眷屬投保資料</h3>
              <Button variant="secondary" size="sm"
                type="button"
                onClick={() => setShowNhiForm((open) => !open)}
                aria-expanded={showNhiForm}
                aria-controls={nhiPanelId}>
                {showNhiForm ? "收合" : "＋ 新增健保眷屬"}
              </Button>
            </div>
            {/* hidden 掛在不帶 display 類別的外層 div（form 本身是 grid，直接掛會被蓋掉）。 */}
            <div id={nhiPanelId} hidden={!showNhiForm}>
              {/* form 的 onChange 會收到底下所有欄位冒泡上來的變更：改任何一欄就清掉錯誤。 */}
              <form
                onSubmit={onAddNhi}
                onChange={() => setNhiError(null)}
                className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2"
              >
                <input className={inputCls} value={nhiName} onChange={(event) => setNhiName(event.target.value)} placeholder="眷屬姓名" />
                <input className={inputCls} value={nhiRelationship} onChange={(event) => setNhiRelationship(event.target.value)} placeholder="關係" />
                <input className={inputCls} value={nhiIdNumber} onChange={(event) => setNhiIdNumber(event.target.value)} placeholder="身分證字號" />
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input type="checkbox" checked={nhiInsured} onChange={(event) => setNhiInsured(event.target.checked)} />
                  投保中
                </label>
                <button
                  type="submit"
                  disabled={nhiSubmitting}
                  className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
                  style={{ color: "var(--brand)" }}
                >
                  {nhiSubmitting ? "新增中…" : "新增健保眷屬"}
                </button>
                {nhiError && <ErrorText className="sm:col-span-2">{nhiError}</ErrorText>}
              </form>
            </div>
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
            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <h3 className="text-sm font-medium text-gray-600">所得稅扶養親屬資料</h3>
              <Button variant="secondary" size="sm"
                type="button"
                onClick={() => setShowTaxForm((open) => !open)}
                aria-expanded={showTaxForm}
                aria-controls={taxPanelId}>
                {showTaxForm ? "收合" : "＋ 新增扶養親屬"}
              </Button>
            </div>
            <div id={taxPanelId} hidden={!showTaxForm}>
              <form
                onSubmit={onAddTax}
                onChange={() => setTaxError(null)}
                className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-2"
              >
                <input className={inputCls} value={taxName} onChange={(event) => setTaxName(event.target.value)} placeholder="親屬姓名" />
                <input className={inputCls} value={taxRelationship} onChange={(event) => setTaxRelationship(event.target.value)} placeholder="關係" />
                <input className={inputCls} value={taxIdNumber} onChange={(event) => setTaxIdNumber(event.target.value)} placeholder="身分證字號" />
                <input className={inputCls} type="number" value={taxBirthYear} onChange={(event) => setTaxBirthYear(event.target.value)} placeholder="出生年" />
                <button
                  type="submit"
                  disabled={taxSubmitting}
                  className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
                  style={{ color: "var(--brand)" }}
                >
                  {taxSubmitting ? "新增中…" : "新增扶養親屬"}
                </button>
                {taxError && <ErrorText className="sm:col-span-2">{taxError}</ErrorText>}
              </form>
            </div>
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
    </Card>
  );
}
