"use client";

import { useMemo, useEffect, useState } from "react";
import { Card, PageHeader, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getBranding,
  getRuleConfig,
  getRuleConfigVersions,
  saveRuleConfig,
  saveTenantSettings,
  type RuleConfig,
  type RuleConfigResponse,
  type RuleConfigVersion,
  type OvertimeRule,
  type OvertimeTier,
  type OvertimeWhen,
  type OvertimeRoundingMode,
  type TenantFeatures,
} from "@/lib/admin-api";
import { ESS_TABS } from "@/components/EssHeader";
import {
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  INTERN_DEFAULT_ESS_TABS,
  type EmploymentType,
} from "@/lib/ess-tabs";

const CALENDARS = [
  { name: "台灣行事曆", owner: "全公司", years: ["2025 已發佈", "2026 已發佈", "2027 待新增"] },
  { name: "門市排班行事曆", owner: "門市", years: ["2025 已發佈", "2026 已發佈", "2027 待新增"] },
  { name: "總部行事曆", owner: "總部", years: ["2025 已發佈", "2026 已發佈", "2027 待新增"] },
];

type YearStatus = "draft" | "published" | "locked";

const YEAR_STATUS_META: Record<YearStatus, { label: string; cls: string }> = {
  draft: { label: "草稿", cls: "bg-amber-50 text-amber-700" },
  published: { label: "已發佈", cls: "bg-green-50 text-green-700" },
  locked: { label: "已鎖定", cls: "bg-slate-100 text-slate-700" },
};

const FIELD_OPTIONS = [
  { value: "basic", label: "基本資料" },
  { value: "contact", label: "通訊資料" },
  { value: "education", label: "學歷" },
  { value: "certification", label: "證照" },
  { value: "workHistory", label: "工作經歷" },
];

/* --------------------------------------------- 加班與計薪參數（亞斯特出勤表） --- */
/**
 * 這個區塊把 packages/rules/src/rules-schema.ts 的加班/計薪 knob 做成表單覆蓋
 * ruleConfig.config 的對應欄位，其餘欄位（attendance_bonus / night / insurance）
 * 原樣保留。所有數字欄位在表單內存字串，避免 controlled input 出現 NaN；儲存時
 * 才轉數字，轉不出來就退回目前值或欄位預設值。
 *
 * 三段倍率與固定假日 minChargeHours 的預設值取自
 * packages/rules/src/__tests__/golden.test.ts「規則五 亞斯特 115-06」：
 * 前 2h ×1.334、2–8h ×1.666667、8h 以上 ×2.666667；固定假日 ×1 做 1 給 8。
 */

interface TierFormRow {
  uptoHours: string;
  multiplier: string;
}

const ASTER_STATUTORY_TIERS: [TierFormRow, TierFormRow, TierFormRow] = [
  { uptoHours: "2", multiplier: "1.334" },
  { uptoHours: "8", multiplier: "1.666667" },
  { uptoHours: "", multiplier: "2.666667" },
];

interface OvertimeParamsForm {
  unitMinutes: string;
  mode: OvertimeRoundingMode;
  minimumMinutes: string;
  mealBreakEnabled: boolean;
  mealAfterMinutes: string;
  mealDeductMinutes: string;
  dailyCapMinutes: string;
  monthlyAlertHours: [string, string, string];
  hourlyWageDivisor: string;
  fixedHolidayMinChargeHours: string;
  weekdayTiers: [TierFormRow, TierFormRow, TierFormRow];
  restDayTiers: [TierFormRow, TierFormRow, TierFormRow];
  lateEarlyEnabled: boolean;
  requireApprovedSheet: boolean;
  requireAnomalyAck: boolean;
}

const DEFAULT_OT_FORM: OvertimeParamsForm = {
  unitMinutes: "30",
  mode: "floor",
  minimumMinutes: "30",
  mealBreakEnabled: true,
  mealAfterMinutes: "180",
  mealDeductMinutes: "30",
  dailyCapMinutes: "240",
  monthlyAlertHours: ["36", "40", "46"],
  hourlyWageDivisor: "240",
  fixedHolidayMinChargeHours: "8",
  weekdayTiers: ASTER_STATUTORY_TIERS,
  restDayTiers: ASTER_STATUTORY_TIERS,
  lateEarlyEnabled: false,
  requireApprovedSheet: false,
  requireAnomalyAck: true,
};

function tiersToForm(tiers: OvertimeTier[] | undefined): [TierFormRow, TierFormRow, TierFormRow] {
  if (!tiers || tiers.length === 0) return ASTER_STATUTORY_TIERS;
  const at = (i: number): TierFormRow => {
    const t = tiers[i];
    if (!t) return { uptoHours: "", multiplier: "" };
    return { uptoHours: t.uptoHours !== undefined ? String(t.uptoHours) : "", multiplier: String(t.multiplier) };
  };
  return [at(0), at(1), at(2)];
}

function alertHoursToForm(hours: number[] | undefined): [string, string, string] {
  const source = hours && hours.length > 0 ? hours : [36, 40, 46];
  const at = (i: number) => (source[i] !== undefined ? String(source[i]) : "");
  return [at(0), at(1), at(2)];
}

/** 由目前 config 推算表單初值；config 缺的欄位一律套引擎 resolve* 的同一組預設值。 */
function hydrateOvertimeForm(config: RuleConfig): OvertimeParamsForm {
  const ot = config.overtime;
  const weekday = ot.rules.find((r) => r.when === "weekday_ot");
  const rest = ot.rules.find((r) => r.when === "rest_day");
  const fixed = ot.rules.find((r) => r.when === "fixed_holiday");
  const mealBreak = ot.mealBreak;
  return {
    unitMinutes: String(ot.rounding?.unitMinutes ?? 30),
    mode: ot.rounding?.mode ?? "floor",
    minimumMinutes: String(ot.rounding?.minimumMinutes ?? 30),
    // schema 語意：省略 mealBreak = 用預設（視為啟用）；明確 null 才是關閉。
    mealBreakEnabled: mealBreak !== null,
    mealAfterMinutes: String(mealBreak?.afterMinutes ?? 180),
    mealDeductMinutes: String(mealBreak?.deductMinutes ?? 30),
    dailyCapMinutes: String(ot.dailyCapMinutes ?? 240),
    monthlyAlertHours: alertHoursToForm(ot.monthlyAlertHours),
    hourlyWageDivisor: String(config.payroll.hourlyWageDivisor ?? 240),
    fixedHolidayMinChargeHours: String(fixed?.minChargeHours ?? 8),
    weekdayTiers: tiersToForm(weekday?.tiers),
    restDayTiers: tiersToForm(rest?.tiers),
    lateEarlyEnabled: config.leave_deduction?.lateEarly?.enabled ?? false,
    requireApprovedSheet: config.payroll.requireApprovedSheet ?? false,
    requireAnomalyAck: config.payroll.requireAnomalyAck ?? true,
  };
}

function buildTieredRule(
  when: OvertimeWhen,
  tiers: [TierFormRow, TierFormRow, TierFormRow],
  existing: OvertimeRule | undefined,
): OvertimeRule {
  const t1 = { uptoHours: Number(tiers[0].uptoHours) || 2, multiplier: Number(tiers[0].multiplier) || 1 };
  const t2 = { uptoHours: Number(tiers[1].uptoHours) || 8, multiplier: Number(tiers[1].multiplier) || 1 };
  const t3 = { multiplier: Number(tiers[2].multiplier) || 1 };
  return {
    when,
    // 沒有 tiers 時的後備單一倍率；有 tiers 時引擎忽略，取第一段當代表值。
    multiplier: t1.multiplier,
    tiers: [t1, t2, t3],
    compTime: existing?.compTime,
  };
}

function buildFixedHolidayRule(existing: OvertimeRule | undefined, minChargeHoursInput: string): OvertimeRule {
  const parsed = Number(minChargeHoursInput);
  const minChargeHours =
    minChargeHoursInput.trim() !== "" && Number.isFinite(parsed) ? parsed : existing?.minChargeHours;
  return {
    when: "fixed_holiday",
    multiplier: existing?.multiplier ?? 1,
    compTime: existing?.compTime,
    tiers: existing?.tiers,
    minChargeHours,
  };
}

function TierEditor({
  title,
  hint,
  tiers,
  onChange,
}: {
  title: string;
  hint: string;
  tiers: [TierFormRow, TierFormRow, TierFormRow];
  onChange: (index: 0 | 1 | 2, field: "uptoHours" | "multiplier", value: string) => void;
}) {
  const rowLabels = ["第 1 段（≤2h）", "第 2 段（≤8h）", "第 3 段（其後）"];
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-gray-700">{title}</p>
      <div className="overflow-x-auto rounded-lg border border-gray-100">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500">
              <th className="py-1.5 pl-3">段別</th>
              <th className="py-1.5">上限（小時）</th>
              <th className="py-1.5 pr-3">倍率</th>
            </tr>
          </thead>
          <tbody>
            {([0, 1, 2] as const).map((i) => (
              <tr key={i} className="border-t border-gray-50">
                <td className="py-1.5 pl-3 text-xs text-gray-500">{rowLabels[i]}</td>
                <td className="py-1.5">
                  {i === 2 ? (
                    <span className="text-xs text-gray-400">無上限</span>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={tiers[i].uptoHours}
                      onChange={(e) => onChange(i, "uptoHours", e.target.value)}
                      className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm"
                    />
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={tiers[i].multiplier}
                    onChange={(e) => onChange(i, "multiplier", e.target.value)}
                    className="w-24 rounded-md border border-gray-300 px-2 py-1 text-sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-gray-400">{hint}</p>
    </div>
  );
}

/** essTabsCfg 的形狀：身分類別 → 目前勾選（可見）的 tab key 清單，順序不重要（存檔時會重排）。 */
type EssTabsConfig = Record<EmploymentType, string[]>;

/** 某身分類別完全沒有設定時的預設勾選狀態：intern 只給六個，其餘全勾。 */
function defaultEssTabsFor(type: EmploymentType): string[] {
  return type === "intern" ? [...INTERN_DEFAULT_ESS_TABS] : ESS_TABS.map((t) => t.key);
}

function defaultEssTabsConfig(): EssTabsConfig {
  const cfg = {} as EssTabsConfig;
  for (const type of EMPLOYMENT_TYPES) cfg[type] = defaultEssTabsFor(type);
  return cfg;
}

/** 由 tenants.features.essTabs 還原表單狀態；缺欄位或格式不對都退回預設值。 */
function hydrateEssTabsConfig(raw: unknown): EssTabsConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const cfg = {} as EssTabsConfig;
  for (const type of EMPLOYMENT_TYPES) {
    const list = source[type];
    cfg[type] =
      Array.isArray(list) && list.every((v) => typeof v === "string") ? (list as string[]) : defaultEssTabsFor(type);
  }
  return cfg;
}

/* --------------------------------------------- 規則版本生效日（C4） --- */
/**
 * 存規則時可選「這次改動何時生效」，對應 saveRuleConfig 的 opts.effectiveFrom：
 * "now" = 立即生效（今天）、"nextMonth"（不傳 opts）= 後端預設下個月1號、
 * "custom" = 指定日期，實際送出 'YYYY-MM-DD'。
 */
type EffectiveMode = "now" | "nextMonth" | "custom";

function toEffectiveOpts(mode: EffectiveMode, date: string): { effectiveFrom?: string } {
  if (mode === "now") return { effectiveFrom: "now" };
  if (mode === "custom") return date ? { effectiveFrom: date } : {};
  return {};
}

/**
 * 本地「今天」（YYYY-MM-DD，瀏覽器本地時區）。不用 toISOString().slice(0,10)：
 * UTC+8 時區下每天 00:00–08:00 會少算一天（同 apps/web/src/lib/projects-ext-api.ts
 * 的 localTodayKey 註解），這裡只是顯示文案用，不影響送給後端的 effectiveFrom 值。
 */
function localTodayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 存檔成功後的提示文案；effectiveFrom 來自 saveRuleConfig 的回傳值。 */
function describeSaveResult(version: number, effectiveFrom: string): string {
  return effectiveFrom <= localTodayKey()
    ? `已儲存第 ${version} 版，已立即生效`
    : `已儲存第 ${version} 版，將於 ${effectiveFrom} 生效`;
}

/** 版本歷史表格的建立時間欄位；沿用 attendance-sheets/[id] 頁面同款格式。 */
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EffectiveDateFields({
  mode,
  date,
  onModeChange,
  onDateChange,
  groupName,
}: {
  mode: EffectiveMode;
  date: string;
  onModeChange: (mode: EffectiveMode) => void;
  onDateChange: (date: string) => void;
  groupName: string;
}) {
  return (
    <div>
      <label className={labelCls}>生效時間</label>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input type="radio" name={groupName} checked={mode === "now"} onChange={() => onModeChange("now")} />
          立即生效
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="radio"
            name={groupName}
            checked={mode === "nextMonth"}
            onChange={() => onModeChange("nextMonth")}
          />
          下個月 1 日生效
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-700">
          <input type="radio" name={groupName} checked={mode === "custom"} onChange={() => onModeChange("custom")} />
          指定日期
        </label>
        {mode === "custom" && (
          <input
            type="date"
            min={localTodayKey()}
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        )}
      </div>
    </div>
  );
}

export default function ModuleSettingsPage() {
  const [ruleConfig, setRuleConfig] = useState<RuleConfigResponse | null>(null);
  const [otForm, setOtForm] = useState<OvertimeParamsForm>(DEFAULT_OT_FORM);
  const [features, setFeatures] = useState<TenantFeatures>({});
  const [essTabsCfg, setEssTabsCfg] = useState<EssTabsConfig>(() => defaultEssTabsConfig());
  const [myDataRequiresApproval, setMyDataRequiresApproval] = useState(true);
  const [editableFields, setEditableFields] = useState("basic,contact,education,certification,workHistory");
  const [attachmentLimitKb, setAttachmentLimitKb] = useState("300");
  const [activeYear, setActiveYear] = useState(String(new Date().getFullYear()));
  const [yearStatus, setYearStatus] = useState<YearStatus>("published");
  const [workCalendar, setWorkCalendar] = useState("台灣行事曆");
  const [attendanceCutoffDay, setAttendanceCutoffDay] = useState("25");
  const [allowEmployeeDispute, setAllowEmployeeDispute] = useState(true);
  const [enableAutoSettlement, setEnableAutoSettlement] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ruleVersions, setRuleVersions] = useState<RuleConfigVersion[] | null>(null);
  const [ruleVersionsError, setRuleVersionsError] = useState<string | null>(null);
  const [jsonEffectiveMode, setJsonEffectiveMode] = useState<EffectiveMode>("nextMonth");
  const [jsonEffectiveDate, setJsonEffectiveDate] = useState("");
  const [otEffectiveMode, setOtEffectiveMode] = useState<EffectiveMode>("nextMonth");
  const [otEffectiveDate, setOtEffectiveDate] = useState("");

  const parsedEditableFields = useMemo(
    () =>
      new Set(
        editableFields
          .split(",")
          .map((field) => field.trim())
          .filter(Boolean),
      ),
    [editableFields],
  );

  useEffect(() => {
    getRuleConfig()
      .then((res) => {
        setRuleConfig(res);
        setDraft(JSON.stringify(res.config, null, 2));
        setOtForm(hydrateOvertimeForm(res.config));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "載入模組設定失敗"));
    getBranding()
      .then((res) => {
        const nextFeatures = res.features ?? {};
        const formParameters = (nextFeatures.formParameters as {
          myDataRequiresApproval?: boolean;
          editableFields?: string[];
          attachmentLimitKb?: number;
        } | undefined) ?? {};
        const attendanceModule = (nextFeatures.attendanceModule as {
          activeYear?: string;
          yearStatus?: YearStatus;
          workCalendar?: string;
          attendanceCutoffDay?: number;
          allowEmployeeDispute?: boolean;
          enableAutoSettlement?: boolean;
        } | undefined) ?? {};
        setFeatures(nextFeatures);
        setEssTabsCfg(hydrateEssTabsConfig(nextFeatures.essTabs));
        setMyDataRequiresApproval(formParameters.myDataRequiresApproval ?? true);
        setEditableFields((formParameters.editableFields ?? ["basic", "contact", "education", "certification", "workHistory"]).join(","));
        setAttachmentLimitKb(String(formParameters.attachmentLimitKb ?? 300));
        setActiveYear(attendanceModule.activeYear ?? String(new Date().getFullYear()));
        setYearStatus(attendanceModule.yearStatus ?? "published");
        setWorkCalendar(attendanceModule.workCalendar ?? "台灣行事曆");
        setAttendanceCutoffDay(String(attendanceModule.attendanceCutoffDay ?? 25));
        setAllowEmployeeDispute(attendanceModule.allowEmployeeDispute ?? true);
        setEnableAutoSettlement(attendanceModule.enableAutoSettlement ?? false);
      })
      .catch(() => null);
  }, []);

  useEffect(() => {
    // 版本歷史非關鍵路徑：拿不到就顯示錯誤字樣，不擋頁面其餘內容。
    getRuleConfigVersions()
      .then((rows) => setRuleVersions(rows))
      .catch((err) => setRuleVersionsError(err instanceof Error ? err.message : "版本歷史載入失敗"));
  }, []);

  /**
   * 重新載入「現在實際生效」的規則狀態。存檔成功後改呼叫這個，不要用剛存的 config
   * 手動兜一個 RuleConfigResponse——這次存檔若選的是未來生效（下個月或指定日期），
   * 存檔當下真正生效的其實還是舊版本，直接把新版本標成「目前生效」會誤導畫面。
   */
  async function reloadRuleConfig() {
    const res = await getRuleConfig();
    setRuleConfig(res);
    setDraft(JSON.stringify(res.config, null, 2));
    setOtForm(hydrateOvertimeForm(res.config));
    return res;
  }

  async function onSave() {
    setError(null);
    setMessage(null);
    if (jsonEffectiveMode === "custom" && !jsonEffectiveDate) {
      setError("請選擇指定生效日期");
      return;
    }
    try {
      const parsed = JSON.parse(draft);
      const res = await saveRuleConfig(parsed, toEffectiveOpts(jsonEffectiveMode, jsonEffectiveDate));
      setMessage(describeSaveResult(res.version, res.effectiveFrom));
      await reloadRuleConfig().catch(() => {
        // 存檔已成功；重新整理「目前生效」狀態失敗不影響這次存檔結果。
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  function patchOt(partial: Partial<OvertimeParamsForm>) {
    setOtForm((prev) => ({ ...prev, ...partial }));
  }

  function setTierField(
    which: "weekdayTiers" | "restDayTiers",
    index: 0 | 1 | 2,
    field: "uptoHours" | "multiplier",
    value: string,
  ) {
    setOtForm((prev) => {
      const tiers: [TierFormRow, TierFormRow, TierFormRow] = [...prev[which]];
      tiers[index] = { ...tiers[index], [field]: value };
      return { ...prev, [which]: tiers };
    });
  }

  function setAlertHour(index: 0 | 1 | 2, value: string) {
    setOtForm((prev) => {
      const arr: [string, string, string] = [...prev.monthlyAlertHours];
      arr[index] = value;
      return { ...prev, monthlyAlertHours: arr };
    });
  }

  /**
   * 把表單覆蓋進目前 config 的 overtime / payroll / leave_deduction，其餘欄位
   * （attendance_bonus / night / insurance）原樣保留後整包 PUT——後端 parseRuleConfig
   * 驗證的是完整物件，沒有「只改一個欄位」的 PATCH 語意。
   */
  async function onSaveOvertimeParams() {
    if (!ruleConfig) return;
    setError(null);
    setMessage(null);
    if (otEffectiveMode === "custom" && !otEffectiveDate) {
      setError("請選擇指定生效日期");
      return;
    }
    try {
      const base = ruleConfig.config;
      const existingWeekday = base.overtime.rules.find((r) => r.when === "weekday_ot");
      const existingRest = base.overtime.rules.find((r) => r.when === "rest_day");
      const existingFixed = base.overtime.rules.find((r) => r.when === "fixed_holiday");

      const weekdayRule = buildTieredRule("weekday_ot", otForm.weekdayTiers, existingWeekday);
      const restRule = buildTieredRule("rest_day", otForm.restDayTiers, existingRest);
      const fixedRule = buildFixedHolidayRule(existingFixed, otForm.fixedHolidayMinChargeHours);

      const merged: RuleConfig = {
        ...base,
        overtime: {
          rules: [weekdayRule, restRule, fixedRule],
          rounding: {
            unitMinutes: Number(otForm.unitMinutes) || 30,
            mode: otForm.mode,
            minimumMinutes: Number(otForm.minimumMinutes) || 0,
          },
          mealBreak: otForm.mealBreakEnabled
            ? {
                afterMinutes: Number(otForm.mealAfterMinutes) || 0,
                deductMinutes: Number(otForm.mealDeductMinutes) || 0,
              }
            : null,
          dailyCapMinutes: otForm.dailyCapMinutes.trim() === "" ? undefined : Number(otForm.dailyCapMinutes) || undefined,
          monthlyAlertHours: otForm.monthlyAlertHours
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v) && v > 0),
        },
        payroll: {
          ...base.payroll,
          hourlyWageDivisor:
            otForm.hourlyWageDivisor.trim() === "" ? undefined : Number(otForm.hourlyWageDivisor) || undefined,
          requireApprovedSheet: otForm.requireApprovedSheet,
          requireAnomalyAck: otForm.requireAnomalyAck,
        },
        leave_deduction: {
          ...base.leave_deduction,
          lateEarly: { enabled: otForm.lateEarlyEnabled },
        },
      };

      const res = await saveRuleConfig(merged, toEffectiveOpts(otEffectiveMode, otEffectiveDate));
      setMessage(describeSaveResult(res.version, res.effectiveFrom));
      await reloadRuleConfig().catch(() => {
        // 存檔已成功；重新整理「目前生效」狀態失敗不影響這次存檔結果。
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存加班與計薪參數失敗");
    }
  }

  async function onSaveFormParameters() {
    setError(null);
    setMessage(null);
    try {
      const nextFeatures = {
        ...features,
        formParameters: {
          myDataRequiresApproval,
          editableFields: editableFields
            .split(",")
            .map((field) => field.trim())
            .filter(Boolean),
          attachmentLimitKb: Number(attachmentLimitKb) || 300,
        },
      };
      const saved = await saveTenantSettings({ features: nextFeatures });
      setFeatures(saved.features ?? nextFeatures);
      setMessage("表單參數已儲存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存表單參數失敗");
    }
  }

  async function onSaveAttendanceModule() {
    setError(null);
    setMessage(null);
    try {
      const nextFeatures = {
        ...features,
        attendanceModule: {
          activeYear,
          yearStatus,
          workCalendar,
          attendanceCutoffDay: Number(attendanceCutoffDay) || 25,
          allowEmployeeDispute,
          enableAutoSettlement,
        },
      };
      const saved = await saveTenantSettings({ features: nextFeatures });
      setFeatures(saved.features ?? nextFeatures);
      setMessage("差勤模組設定已儲存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存差勤模組設定失敗");
    }
  }

  /** 切換某身分類別對某個 tab 的勾選；存回去時永遠照 ESS_TABS 原本順序排列。 */
  function toggleEssTab(type: EmploymentType, tab: string) {
    setEssTabsCfg((prev) => {
      const current = new Set(prev[type]);
      if (current.has(tab)) current.delete(tab);
      else current.add(tab);
      const next = ESS_TABS.map((t) => t.key).filter((key) => current.has(key));
      return { ...prev, [type]: next };
    });
  }

  /** A3：員工端功能開放——四類身分各自可見的 ESS 分頁，存到 tenants.features.essTabs。 */
  async function onSaveEssTabs() {
    setError(null);
    setMessage(null);
    try {
      const nextFeatures: TenantFeatures = { ...features, essTabs: essTabsCfg };
      const saved = await saveTenantSettings({ features: nextFeatures });
      setFeatures(saved.features ?? nextFeatures);
      setMessage("員工端功能開放設定已儲存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存員工端功能開放設定失敗");
    }
  }

  function toggleEditableField(field: string) {
    const next = new Set(parsedEditableFields);
    if (next.has(field)) next.delete(field);
    else next.add(field);
    setEditableFields(Array.from(next).join(","));
  }

  return (
    <>
      <PageHeader title="模組設定" desc="對齊 Apollo：行事曆、差勤薪資規則與功能參數" />

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">行事曆管理</h2>
            <p className="mt-1 text-sm text-gray-500">維護年度行事曆、適用單位與年度狀態。</p>
          </div>
          <button
            type="button"
            onClick={() => setMessage("新增行事曆目前以設定入口呈現；正式新增需接後端行事曆 API。")}
            className="rounded-md border px-3 py-1.5 text-sm text-gray-600"
          >
            新增行事曆
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs text-gray-500">
                <th className="py-2 pr-4">行事曆名稱</th>
                <th className="py-2 pr-4">適用單位</th>
                <th className="py-2 pr-4">2025</th>
                <th className="py-2 pr-4">2026</th>
                <th className="py-2 pr-4">2027</th>
                <th className="py-2">設定</th>
              </tr>
            </thead>
            <tbody>
              {CALENDARS.map((calendar) => (
                <tr key={calendar.name} className="border-b border-gray-50">
                  <td className="py-2 pr-4 font-medium text-gray-800">{calendar.name}</td>
                  <td className="py-2 pr-4 text-gray-600">{calendar.owner}</td>
                  {calendar.years.map((year, index) => (
                    <td key={year} className="py-2 pr-4">
                      <span className={`rounded-full px-2 py-1 text-xs ${index === 2 ? "bg-amber-50 text-amber-700" : "bg-green-50 text-green-700"}`}>
                        {year}
                      </span>
                    </td>
                  ))}
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setWorkCalendar(calendar.name);
                        setMessage(`已選擇 ${calendar.name} 作為目前差勤行事曆`);
                      }}
                      className="text-sm text-gray-600 hover:underline"
                    >
                      套用
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-gray-400">
          逐日的例假日／國定假日覆寫請至「人事差勤 · 差勤管理 → 行事曆 / 假日表」維護。
        </p>
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">年度狀態與差勤參數</h2>
            <p className="mt-1 text-sm text-gray-500">對齊 Apollo 的年度狀態、行事曆、截止日與員工異議設定。</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${YEAR_STATUS_META[yearStatus].cls}`}>
            {activeYear} {YEAR_STATUS_META[yearStatus].label}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className={labelCls}>年度</label>
            <input className={inputCls} value={activeYear} onChange={(event) => setActiveYear(event.target.value)} placeholder="2026" />
          </div>
          <div>
            <label className={labelCls}>年度狀態</label>
            <select className={inputCls} value={yearStatus} onChange={(event) => setYearStatus(event.target.value as YearStatus)}>
              <option value="draft">草稿</option>
              <option value="published">已發佈</option>
              <option value="locked">已鎖定</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>預設行事曆</label>
            <select className={inputCls} value={workCalendar} onChange={(event) => setWorkCalendar(event.target.value)}>
              {CALENDARS.map((calendar) => (
                <option key={calendar.name} value={calendar.name}>{calendar.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>差勤截止日</label>
            <input type="number" min={1} max={31} className={inputCls} value={attendanceCutoffDay} onChange={(event) => setAttendanceCutoffDay(event.target.value)} />
          </div>
          <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
            <input type="checkbox" checked={allowEmployeeDispute} onChange={(event) => setAllowEmployeeDispute(event.target.checked)} />
            允許員工班表/出勤異議
          </label>
          <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
            <input type="checkbox" checked={enableAutoSettlement} onChange={(event) => setEnableAutoSettlement(event.target.checked)} />
            啟用自動結算提醒
          </label>
        </div>
        <div className="mt-4">
          <PrimaryButton onClick={onSaveAttendanceModule}>儲存差勤模組設定</PrimaryButton>
        </div>
      </Card>

      <Card>
        <div className="mb-4">
          <h2 className="text-base font-semibold text-gray-900">加班與計薪參數</h2>
          <p className="mt-1 text-sm text-gray-500">
            對應客戶「出勤統計表」Excel 的加班取整、用餐扣除、分段倍率與計薪規則（來源：亞斯特 115-06 出勤表案例）。
          </p>
        </div>

        {ruleConfig ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls}>取整單位（分）</label>
                <input
                  type="number"
                  min={1}
                  className={inputCls}
                  value={otForm.unitMinutes}
                  onChange={(e) => patchOt({ unitMinutes: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-400">Excel：30 分為單位無條件捨去</p>
              </div>
              <div>
                <label className={labelCls}>取整模式</label>
                <select
                  className={inputCls}
                  value={otForm.mode}
                  onChange={(e) => patchOt({ mode: e.target.value as OvertimeRoundingMode })}
                >
                  <option value="floor">無條件捨去 floor</option>
                  <option value="nearest">四捨五入 nearest</option>
                  <option value="ceil">無條件進位 ceil</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>最低計入（分）</label>
                <input
                  type="number"
                  min={0}
                  className={inputCls}
                  value={otForm.minimumMinutes}
                  onChange={(e) => patchOt({ minimumMinutes: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-400">Excel：未滿 30 分不計加班</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={otForm.mealBreakEnabled}
                  onChange={(e) => patchOt({ mealBreakEnabled: e.target.checked })}
                />
                啟用晚餐扣除
              </label>
              <div>
                <label className={labelCls}>延長工時超過幾分鐘扣（門檻分）</label>
                <input
                  type="number"
                  min={0}
                  disabled={!otForm.mealBreakEnabled}
                  className={`${inputCls} disabled:bg-gray-50 disabled:text-gray-400`}
                  value={otForm.mealAfterMinutes}
                  onChange={(e) => patchOt({ mealAfterMinutes: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>扣除分鐘</label>
                <input
                  type="number"
                  min={0}
                  disabled={!otForm.mealBreakEnabled}
                  className={`${inputCls} disabled:bg-gray-50 disabled:text-gray-400`}
                  value={otForm.mealDeductMinutes}
                  onChange={(e) => patchOt({ mealDeductMinutes: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-400">Excel：延長工時超過 3 小時（180 分）扣 30 分晚餐</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>單日加班上限（分）</label>
                <input
                  type="number"
                  min={0}
                  className={inputCls}
                  value={otForm.dailyCapMinutes}
                  onChange={(e) => patchOt({ dailyCapMinutes: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-400">
                  Excel：單日加班上限 240 分（4 小時）；引擎只回傳不裁切，供結算頁判異常
                </p>
              </div>
              <div>
                <label className={labelCls}>月加班警示門檻（小時，由小到大）</label>
                <div className="flex gap-2">
                  {([0, 1, 2] as const).map((i) => (
                    <input
                      key={i}
                      type="number"
                      min={0}
                      className={inputCls}
                      value={otForm.monthlyAlertHours[i]}
                      onChange={(e) => setAlertHour(i, e.target.value)}
                    />
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-400">預設 36 / 40 / 46 小時，供結算頁分級提醒</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <TierEditor
                title="加班分段倍率 · 平日延長工時（weekday_ot）"
                hint="Excel：前 2 小時 ×1.334、2–8 小時 ×1.666667、8 小時以上 ×2.666667"
                tiers={otForm.weekdayTiers}
                onChange={(i, f, v) => setTierField("weekdayTiers", i, f, v)}
              />
              <TierEditor
                title="加班分段倍率 · 例假日出勤（rest_day）"
                hint="Excel：與平日延長工時共用同一組分段倍率"
                tiers={otForm.restDayTiers}
                onChange={(i, f, v) => setTierField("restDayTiers", i, f, v)}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls}>國定假日做 1 給 8（小時）</label>
                <input
                  type="number"
                  min={0}
                  className={inputCls}
                  value={otForm.fixedHolidayMinChargeHours}
                  onChange={(e) => patchOt({ fixedHolidayMinChargeHours: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-400">Excel：固定假日出勤 ×1，當日不足 8 小時仍以 8 小時計</p>
              </div>
              <div>
                <label className={labelCls}>時薪除數</label>
                <input
                  type="number"
                  min={1}
                  className={inputCls}
                  value={otForm.hourlyWageDivisor}
                  onChange={(e) => patchOt({ hourlyWageDivisor: e.target.value })}
                />
                <p className="mt-1 text-xs text-gray-400">Excel：時薪 = 本薪 ÷ 240</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={otForm.lateEarlyEnabled}
                  onChange={(e) => patchOt({ lateEarlyEnabled: e.target.checked })}
                />
                遲到早退扣款
              </label>
              <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={otForm.requireApprovedSheet}
                  onChange={(e) => patchOt({ requireApprovedSheet: e.target.checked })}
                />
                結算薪資前須出勤表已核准
              </label>
              <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={otForm.requireAnomalyAck}
                  onChange={(e) => patchOt({ requireAnomalyAck: e.target.checked })}
                />
                結算薪資前須異常已確認
              </label>
            </div>

            <EffectiveDateFields
              mode={otEffectiveMode}
              date={otEffectiveDate}
              onModeChange={setOtEffectiveMode}
              onDateChange={setOtEffectiveDate}
              groupName="ot-effective-mode"
            />

            <div>
              <PrimaryButton onClick={onSaveOvertimeParams}>儲存加班與計薪參數</PrimaryButton>
            </div>
          </div>
        ) : (
          <Empty>載入中…</Empty>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">差勤 / 薪資規則（原始 JSON）</h2>
            <p className="mt-1 text-sm text-gray-500">
              完整規則 DSL，供進階調整；上方「加班與計薪參數」儲存後會同步更新這裡的內容。
            </p>
          </div>
          {ruleConfig && (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
              版本 {ruleConfig.version}
            </span>
          )}
        </div>
        {ruleConfig ? (
          <>
            <p className="mb-2 text-xs text-gray-500">
              目前版本：{ruleConfig.version} {ruleConfig.isDefault ? "（預設值）" : ""}
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-96 w-full rounded-md border border-gray-300 p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
            />
            <div className="mt-4">
              <EffectiveDateFields
                mode={jsonEffectiveMode}
                date={jsonEffectiveDate}
                onModeChange={setJsonEffectiveMode}
                onDateChange={setJsonEffectiveDate}
                groupName="json-effective-mode"
              />
            </div>
            <div className="mt-4">
              <PrimaryButton onClick={onSave}>儲存規則</PrimaryButton>
            </div>
          </>
        ) : (
          <Empty>載入中…</Empty>
        )}
        {message && <p className="mt-3 text-sm text-green-600">{message}</p>}
        {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
      </Card>

      <Card>
        <div className="mb-4">
          <h2 className="text-base font-semibold text-gray-900">規則版本歷史</h2>
          <p className="mt-1 text-sm text-gray-500">
            每次儲存規則都會建立一個新版本；「目前生效」比對的是上方目前載入的版本號，與後端依生效日選版的結果一致。
          </p>
        </div>
        {ruleVersions ? (
          ruleVersions.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="py-2 pr-4">版本</th>
                    <th className="py-2 pr-4">生效日</th>
                    <th className="py-2 pr-4">建立時間</th>
                    <th className="py-2">目前生效</th>
                  </tr>
                </thead>
                <tbody>
                  {ruleVersions.map((v) => (
                    <tr key={v.version} className="border-b border-gray-50">
                      <td className="py-2 pr-4 font-medium text-gray-800">v{v.version}</td>
                      <td className="py-2 pr-4 text-gray-600">{v.effectiveFrom}</td>
                      <td className="py-2 pr-4 text-gray-600">{fmtDateTime(v.createdAt)}</td>
                      <td className="py-2">
                        {ruleConfig?.version === v.version ? (
                          <span className="rounded-full bg-green-50 px-2 py-1 text-xs text-green-700">目前生效</span>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>尚無版本紀錄</Empty>
          )
        ) : ruleVersionsError ? (
          <ErrorText>{ruleVersionsError}</ErrorText>
        ) : (
          <Empty>載入中…</Empty>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-semibold text-gray-900">表單參數設定</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={myDataRequiresApproval}
              onChange={(event) => setMyDataRequiresApproval(event.target.checked)}
            />
            My Data 修改需送審
          </label>
          <div className="sm:col-span-2">
            <label className={labelCls}>可編輯資料區塊</label>
            <div className="flex flex-wrap gap-2">
              {FIELD_OPTIONS.map((field) => (
                <button
                  key={field.value}
                  type="button"
                  onClick={() => toggleEditableField(field.value)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                    parsedEditableFields.has(field.value)
                      ? "text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                  style={parsedEditableFields.has(field.value) ? { backgroundColor: "var(--brand)" } : undefined}
                >
                  {field.label}
                </button>
              ))}
            </div>
            <input
              className={`${inputCls} mt-2`}
              value={editableFields}
              onChange={(event) => setEditableFields(event.target.value)}
              placeholder="basic,contact,education"
            />
          </div>
          <div>
            <label className={labelCls}>附件上限 KB</label>
            <input
              type="number"
              className={inputCls}
              value={attachmentLimitKb}
              onChange={(event) => setAttachmentLimitKb(event.target.value)}
            />
          </div>
        </div>
        <div className="mt-4">
          <PrimaryButton onClick={onSaveFormParameters}>儲存表單參數</PrimaryButton>
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-base font-semibold text-gray-900">員工端功能開放</h2>
        <p className="mb-4 text-sm text-gray-500">
          依身分類別限縮 ESS 可見／可進入的分頁；未勾＝該類別看不到，直接打網址也會被擋。實習生預設只開放六個（打卡首頁／班表／打卡紀錄／申請／通知／我的資料）。
        </p>
        <div className="space-y-5">
          {EMPLOYMENT_TYPES.map((type) => (
            <div key={type}>
              <p className="mb-2 text-sm font-medium text-gray-700">{EMPLOYMENT_TYPE_LABELS[type]}</p>
              <div className="flex flex-wrap gap-2">
                {ESS_TABS.map((t) => {
                  const checked = essTabsCfg[type]?.includes(t.key) ?? false;
                  return (
                    <label
                      key={t.key}
                      className="flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-sm text-gray-700"
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleEssTab(type, t.key)} />
                      {t.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <PrimaryButton onClick={onSaveEssTabs}>儲存員工端功能開放設定</PrimaryButton>
        </div>
      </Card>
    </>
  );
}
