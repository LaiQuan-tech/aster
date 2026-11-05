"use client";

/**
 * 後台公務車 · 設定 `/admin/vehicles/settings`：
 *   - 費用類型 → 報銷類別（來源 GET /expense-categories，排除停用與「需綁出差單」的類別；API 也會擋 category_requires_trip）。
 *     類別的性質決定稅務：定額補貼（allowance）會算進薪資所得，油資／過路／停車建議用實報實銷。
 *   - 到期提醒提前天數、保養提前公里、額外提醒對象（員工多選）、單次預約上限時數、提前取車分鐘。
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Card, Field, InlineError, Input, Select, Skeleton, useToast } from "@/components/admin-ui";
import { getEmployees, getExpenseCategories, type Employee, type ExpenseCategory } from "@/lib/admin-api";
import { COST_TYPES, COST_TYPE_LABEL, vehicleErrorMessage } from "@/lib/vehicle-view";
import { getVehicleSettings, saveVehicleSettings, type CostType, type VehicleSettings } from "@/lib/vehicles-api";

const CATEGORY_KEY: Record<CostType, "fuelCategoryId" | "tollCategoryId" | "parkingCategoryId" | "otherCategoryId"> = {
  fuel: "fuelCategoryId",
  toll: "tollCategoryId",
  parking: "parkingCategoryId",
  other: "otherCategoryId",
};

export default function AdminVehicleSettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<VehicleSettings | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [nums, setNums] = useState({ reminderLeadDays: "", maintenanceLeadKm: "", maxBookingHours: "", checkoutEarlyMinutes: "", maxDaysAhead: "" });
  const [empQuery, setEmpQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([getVehicleSettings(), getExpenseCategories().catch(() => ({ categories: [] })), getEmployees().catch(() => ({ employees: [] }))])
      .then(([s, c, e]) => {
        if (!active) return;
        setSettings(s.settings);
        setNums({
          reminderLeadDays: String(s.settings.reminderLeadDays),
          maintenanceLeadKm: String(s.settings.maintenanceLeadKm),
          maxBookingHours: String(s.settings.maxBookingHours),
          checkoutEarlyMinutes: String(s.settings.checkoutEarlyMinutes),
          maxDaysAhead: String(s.settings.maxDaysAhead ?? 90),
        });
        setCategories(c.categories);
        setEmployees(e.employees.filter((x) => x.status !== "terminated" && !x.terminated_at));
      })
      .catch((err) => active && setError(vehicleErrorMessage(err, "載入失敗")));
    return () => {
      active = false;
    };
  }, []);

  const usable = useMemo(() => categories.filter((c) => c.active && !c.requires_trip_approval), [categories]);
  const empName = useMemo(() => new Map(employees.map((e) => [e.id, e.name] as const)), [employees]);
  const matches = useMemo(() => {
    const q = empQuery.trim();
    if (!q || !settings) return [];
    return employees.filter((e) => !settings.reminderEmpIds.includes(e.id) && (e.name.includes(q) || (e.emp_no ?? "").includes(q))).slice(0, 8);
  }, [empQuery, employees, settings]);

  if (!settings) return error ? <InlineError>{error}</InlineError> : <Skeleton lines={6} />;

  const allowanceWarn = COST_TYPES.some((t) => usable.find((c) => c.id === settings[CATEGORY_KEY[t]])?.nature === "allowance");

  async function save() {
    if (!settings) return;
    setError(null);
    const parsed: Record<string, number> = {};
    for (const [k, v] of Object.entries(nums)) {
      const n = Number(v);
      if (!v.trim() || !Number.isInteger(n) || n < 0) return setError("數字欄位請填非負整數");
      parsed[k] = n;
    }
    // API 範圍：提醒天數 1–180、保養提前 0–10000 km、預約上限 1–720 小時、提前取車 0–1440 分鐘。
    if (parsed.reminderLeadDays < 1 || parsed.reminderLeadDays > 180) return setError("到期提醒天數請填 1–180");
    if (parsed.maintenanceLeadKm > 10000) return setError("保養提前公里數最多 10000");
    if (parsed.maxBookingHours < 1 || parsed.maxBookingHours > 720) return setError("單次預約上限請填 1–720 小時");
    if (parsed.checkoutEarlyMinutes > 1440) return setError("提前取車最多 1440 分鐘");
    if (parsed.maxDaysAhead < 1 || parsed.maxDaysAhead > 365) return setError("可預約天數請填 1–365");
    setBusy(true);
    try {
      const res = await saveVehicleSettings({
        fuelCategoryId: settings.fuelCategoryId,
        tollCategoryId: settings.tollCategoryId,
        parkingCategoryId: settings.parkingCategoryId,
        otherCategoryId: settings.otherCategoryId,
        reminderEmpIds: settings.reminderEmpIds,
        reminderLeadDays: parsed.reminderLeadDays,
        maintenanceLeadKm: parsed.maintenanceLeadKm,
        maxBookingHours: parsed.maxBookingHours,
        checkoutEarlyMinutes: parsed.checkoutEarlyMinutes,
        maxDaysAhead: parsed.maxDaysAhead,
      });
      setSettings(res.settings);
      toast.show("設定已儲存", "success");
    } catch (err) {
      setError(vehicleErrorMessage(err, "儲存失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="費用轉報銷的類別">
        <p className="mb-3 text-sm text-gray-500">員工在用車紀錄按「轉報銷」時，每筆員工代墊的費用依類型建成這裡指定類別的報銷單。沒指定的類型無法轉報銷。</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {COST_TYPES.map((t) => (
            <Field key={t} label={COST_TYPE_LABEL[t]} htmlFor={`vs-${t}`}>
              <Select
                id={`vs-${t}`}
                value={settings[CATEGORY_KEY[t]] ?? ""}
                onChange={(e) => setSettings({ ...settings, [CATEGORY_KEY[t]]: e.target.value || null })}
              >
                <option value="">（未指定）</option>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.nature === "allowance" ? "（定額補貼）" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        {allowanceWarn && (
          <p className="mt-3 rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900">
            注意：選了「定額補貼」性質的類別，該費用會算進員工薪資所得。油資、過路費、停車費一般應選「實報實銷」類別。
          </p>
        )}
        <p className="mt-2 text-xs text-gray-400">需綁出差單的類別與停用的類別不會列出。</p>
      </Card>

      <Card title="提醒與預約規則">
        <div className="grid grid-cols-2 gap-3">
          <Field label="到期前幾天提醒" htmlFor="vs-lead" hint="保養日、保險、牌照稅">
            <Input id="vs-lead" inputMode="numeric" value={nums.reminderLeadDays} onChange={(e) => setNums({ ...nums, reminderLeadDays: e.target.value })} />
          </Field>
          <Field label="保養前幾公里提醒" htmlFor="vs-km">
            <Input id="vs-km" inputMode="numeric" value={nums.maintenanceLeadKm} onChange={(e) => setNums({ ...nums, maintenanceLeadKm: e.target.value })} />
          </Field>
          <Field label="單次預約上限（小時）" htmlFor="vs-max">
            <Input id="vs-max" inputMode="numeric" value={nums.maxBookingHours} onChange={(e) => setNums({ ...nums, maxBookingHours: e.target.value })} />
          </Field>
          <Field label="可提前取車（分鐘）" htmlFor="vs-early">
            <Input id="vs-early" inputMode="numeric" value={nums.checkoutEarlyMinutes} onChange={(e) => setNums({ ...nums, checkoutEarlyMinutes: e.target.value })} />
          </Field>
          <Field label="最多可預約幾天後（天）" htmlFor="vs-ahead" hint="1–365，預設 90">
            <Input id="vs-ahead" inputMode="numeric" value={nums.maxDaysAhead} onChange={(e) => setNums({ ...nums, maxDaysAhead: e.target.value })} />
          </Field>
        </div>
      </Card>

      <Card title="額外提醒對象">
        <p className="mb-2 text-sm text-gray-500">除了 HR，到期提醒與還車車況異常也會通知這些人（例如總務）。</p>
        <ul className="mb-3 flex flex-wrap gap-2">
          {settings.reminderEmpIds.length === 0 && <li className="text-sm text-gray-400">（沒有）</li>}
          {settings.reminderEmpIds.map((eid) => (
            <li key={eid} className="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-sm">
              {empName.get(eid) ?? "（已離職或不明）"}
              <button
                type="button"
                aria-label={`移除 ${empName.get(eid) ?? ""}`}
                className="ml-1 text-gray-500"
                onClick={() => setSettings({ ...settings, reminderEmpIds: settings.reminderEmpIds.filter((x) => x !== eid) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <Input placeholder="輸入姓名或工號搜尋" value={empQuery} onChange={(e) => setEmpQuery(e.target.value)} aria-label="搜尋員工" />
        {matches.length > 0 && (
          <ul className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200">
            {matches.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center px-3 text-left text-sm hover:bg-gray-50"
                  onClick={() => {
                    setSettings({ ...settings, reminderEmpIds: [...settings.reminderEmpIds, e.id] });
                    setEmpQuery("");
                  }}
                >
                  {e.emp_no ? `${e.emp_no} · ` : ""}
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {error && <InlineError>{error}</InlineError>}
      <Button onClick={() => void save()} loading={busy} className="w-full sm:w-auto">
        儲存設定
      </Button>
    </div>
  );
}
