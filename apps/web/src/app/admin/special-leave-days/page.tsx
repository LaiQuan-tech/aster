"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BottomSheet,
  Button,
  Card,
  ConfirmDialog,
  Empty,
  ErrorText,
  Field,
  Input,
  Pill,
  Segmented,
  Textarea,
  useToast,
} from "@/components/admin-ui";
import { getDepartments, getEmployees, type Department, type Employee } from "@/lib/admin-api";
import { apiErrorMessage, type ApiError } from "@/lib/api-client";
import { employeeStatusNote, pickableEmployees } from "@/lib/employee-status";
import {
  SPECIAL_NAME_PRESETS,
  SPECIAL_SCOPE_LABEL,
  createSpecialLeaveDay,
  deleteSpecialLeaveDay,
  listSpecialLeaveDays,
  rangeText,
  recalcSummary,
  scopeText,
  updateSpecialLeaveDay,
  type SpecialLeaveDay,
  type SpecialScope,
} from "@/lib/special-leave-days-api";

/**
 * 特殊假別（2026-11-17）——「打卡紀錄維護」最右邊分頁。颱風假、停班、防疫…等特定日期，設成有薪或無薪。
 *
 * 適用員工在該日（他的工作日）：不算曠職、不算遲到早退、不發缺卡提醒；有薪＝視同出勤不扣薪；
 * 無薪＝依時薪扣當日沒做到的約定工時（同事假），兩者都不影響全勤。當天有到班＝照一般工作日算工時，
 * 月表標「颱風假出勤」，加給由 HR 以薪資加減項處理。存檔後自動重算未結算月份的草稿月表。
 */

const PERIOD_CLOSED_HINT = "這段日期所在月份已結算，不能新增或修改（不追溯）";

interface FormState {
  id: string | null;
  startDate: string;
  endDate: string;
  namePreset: string;
  customName: string;
  paid: boolean;
  scope: SpecialScope;
  departmentIds: string[];
  employeeIds: string[];
  note: string;
}

const CUSTOM = "__custom";

function emptyForm(): FormState {
  return {
    id: null,
    startDate: "",
    endDate: "",
    namePreset: SPECIAL_NAME_PRESETS[0],
    customName: "",
    paid: false,
    scope: "all",
    departmentIds: [],
    employeeIds: [],
    note: "",
  };
}

function formOf(day: SpecialLeaveDay): FormState {
  const preset = (SPECIAL_NAME_PRESETS as readonly string[]).includes(day.name) ? day.name : CUSTOM;
  return {
    id: day.id,
    startDate: day.startDate,
    endDate: day.endDate,
    namePreset: preset,
    customName: preset === CUSTOM ? day.name : "",
    paid: day.paid,
    scope: day.scope,
    departmentIds: day.departmentIds,
    employeeIds: day.employeeIds,
    note: day.note ?? "",
  };
}

function errorText(err: unknown): string {
  const code = (err as ApiError)?.code;
  if (code === "period_closed") return PERIOD_CLOSED_HINT;
  if (code === "range_too_long") return "區間最長 31 天";
  if (code === "invalid_range") return "結束日不能早於開始日";
  if (code === "departments_required") return "請至少選一個部門";
  if (code === "employees_required") return "請至少選一位員工";
  if (code === "special_leave_days_not_migrated") return "資料表尚未建立，請聯絡系統管理員";
  if (code === "recalc_in_progress") return "特殊假日重算進行中，請稍後再試";
  return apiErrorMessage(err, "儲存失敗");
}

export default function SpecialLeaveDaysPage() {
  const toast = useToast();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [days, setDays] = useState<SpecialLeaveDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<SpecialLeaveDay | null>(null);
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listSpecialLeaveDays(year);
      setDays(res.days);
    } catch (err) {
      setDays((prev) => prev ?? []);
      setError(errorText(err));
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    getEmployees()
      .then((r) => setEmployees(r.employees))
      .catch(() => null);
    getDepartments()
      .then((r) => setDepartments(r.departments))
      .catch(() => null);
  }, []);

  // 選人只列在職者（lib/employee-status.ts）；編輯時已選中的離職者保留並標「已離職」。
  const formEmployeeIds = form?.employeeIds;
  const pickable = useMemo(() => pickableEmployees(employees, formEmployeeIds ?? []), [employees, formEmployeeIds]);

  function patchForm(p: Partial<FormState>) {
    setForm((f) => (f ? { ...f, ...p } : f));
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function save() {
    if (!form) return;
    const name = form.namePreset === CUSTOM ? form.customName.trim() : form.namePreset;
    if (!form.startDate) return setFormError("請選擇日期");
    if (!name) return setFormError("請輸入名稱");
    const endDate = form.endDate || form.startDate;
    if (endDate < form.startDate) return setFormError("結束日不能早於開始日");
    if (form.scope === "departments" && form.departmentIds.length === 0) return setFormError("請至少選一個部門");
    if (form.scope === "employees" && form.employeeIds.length === 0) return setFormError("請至少選一位員工");
    setFormError(null);
    setBusy(true);
    const body = {
      startDate: form.startDate,
      endDate,
      name,
      paid: form.paid,
      scope: form.scope,
      departmentIds: form.scope === "departments" ? form.departmentIds : [],
      employeeIds: form.scope === "employees" ? form.employeeIds : [],
      note: form.note.trim() || null,
    };
    try {
      const res = form.id ? await updateSpecialLeaveDay(form.id, body) : await createSpecialLeaveDay(body);
      const summary = recalcSummary(res.recalc);
      setNotice(summary);
      toast.show(form.id ? "已更新特殊假日" : "已新增特殊假日", "success");
      setForm(null);
      if (Number(endDate.slice(0, 4)) !== year && Number(form.startDate.slice(0, 4)) !== year) {
        setYear(Number(form.startDate.slice(0, 4)));
      } else {
        await load();
      }
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      const res = await deleteSpecialLeaveDay(deleting.id);
      setNotice(recalcSummary(res.recalc));
      toast.show("已刪除", "success");
      setDeleting(null);
      await load();
    } catch (err) {
      toast.show(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-gray-500">特殊假日</h2>
            <p className="mt-1 text-xs leading-5 text-gray-400">
              颱風假、停班等特定日期。適用的員工當天不算曠職、遲到早退，也不影響全勤；有薪＝照常給薪，無薪＝依時薪扣當天沒做到的應到工時（同事假）。
              當天有到班照一般工時計並標「出勤」，加給請以薪資加減項處理。已核准的月表與已結算月份不追溯。
            </p>
            <details className="mt-1 text-xs leading-5 text-gray-500">
              <summary className="cursor-pointer select-none text-gray-500">ⓘ 計算方式與限制</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>應到工時＝員工當天班表淨工時（個人／預設班別），沒有班表才用每日正常工時。</li>
                <li>無薪扣款＝應到工時 − 實際工時 − 已核准請假 − 已核准出差／公出蓋到的時段；兼職不排班不扣。</li>
                <li>當天已核准的假照原假別處理（照常計請假時數、照原假別扣薪、餘額照扣）；員工請假時會看到提示。</li>
                <li>月薪制扣無薪工時；日薪制不另扣（本俸只算有出勤的天數），有薪特殊假日計入出勤天數。</li>
                <li>時薪制：有薪特殊假日不自動補薪，請以薪資加減項處理。</li>
                <li>部門範圍以「目前」所屬部門判斷：員工事後調部門，重算時會依新部門。</li>
              </ul>
            </details>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-sm text-gray-600">
              年度
              <Input
                type="number"
                min={2000}
                max={2100}
                value={year}
                onChange={(e) => {
                  const y = Number(e.target.value);
                  if (y >= 2000 && y <= 2100) setYear(y);
                }}
                className="ml-2 inline-block w-24"
              />
            </label>
            <Button
              onClick={() => {
                setFormError(null);
                setForm(emptyForm());
              }}
            >
              新增特殊假日
            </Button>
          </div>
        </div>

        {notice && (
          <p
            className={`mt-3 rounded-lg px-3 py-2 text-sm ${notice.warn ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800"}`}
            role="status"
          >
            {notice.text}
          </p>
        )}
        {error && (
          <div className="mt-3">
            <ErrorText>{error}</ErrorText>
          </div>
        )}

        {days === null ? (
          <Empty>載入中…</Empty>
        ) : days.length === 0 ? (
          <Empty>{year} 年還沒有特殊假日</Empty>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2">日期</th>
                  <th className="py-2">名稱</th>
                  <th className="py-2">類型</th>
                  <th className="py-2">適用範圍</th>
                  <th className="py-2 text-right">適用人數</th>
                  <th className="py-2">備註</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.id} className="border-b border-gray-100 align-top">
                    <td className="py-2 whitespace-nowrap text-gray-800">
                      {rangeText(d.startDate, d.endDate)}
                      {d.days > 1 && <span className="ml-1 text-xs text-gray-400">{d.days} 天</span>}
                    </td>
                    <td className="py-2 text-gray-800">{d.name}</td>
                    <td className="py-2">
                      <Pill tone={d.paid ? "green" : "amber"}>{d.paid ? "有薪" : "無薪"}</Pill>
                    </td>
                    <td className="py-2 text-gray-600">
                      <span className="text-xs text-gray-400">{SPECIAL_SCOPE_LABEL[d.scope]}</span>
                      {d.scope !== "all" && <div>{scopeText(d)}</div>}
                    </td>
                    <td className="py-2 text-right tabular-nums text-gray-800">{d.affectedCount}</td>
                    <td className="py-2 text-xs text-gray-500">{d.note ?? ""}</td>
                    <td className="py-2 whitespace-nowrap text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setFormError(null);
                          setForm(formOf(d));
                        }}
                      >
                        編輯
                      </Button>
                      <Button size="sm" variant="ghost" className="ml-1 text-red-600" onClick={() => setDeleting(d)}>
                        刪除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <BottomSheet open={!!form} onClose={() => (busy ? undefined : setForm(null))} title={form?.id ? "編輯特殊假日" : "新增特殊假日"}>
        {form && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="開始日期">
                <Input type="date" value={form.startDate} onChange={(e) => patchForm({ startDate: e.target.value })} />
              </Field>
              <Field label="結束日期" hint="單日可留空">
                <Input type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => patchForm({ endDate: e.target.value })} />
              </Field>
            </div>

            <Field label="名稱">
              <div className="flex flex-wrap gap-2">
                {[...SPECIAL_NAME_PRESETS, CUSTOM].map((n) => {
                  const picked = form.namePreset === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => patchForm({ namePreset: n })}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium ${picked ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                      style={picked ? { backgroundColor: "var(--brand)" } : undefined}
                    >
                      {n === CUSTOM ? "自訂…" : n}
                    </button>
                  );
                })}
              </div>
              {form.namePreset === CUSTOM && (
                <Input
                  className="mt-2"
                  maxLength={40}
                  placeholder="例：豪雨停班"
                  value={form.customName}
                  onChange={(e) => patchForm({ customName: e.target.value })}
                />
              )}
            </Field>

            <Field label="類型" hint={form.paid ? "照常給薪、不扣薪" : "依時薪扣當天沒做到的約定工時（同事假）；不影響全勤"}>
              <Segmented
                options={[
                  { value: "unpaid", label: "無薪" },
                  { value: "paid", label: "有薪" },
                ]}
                value={form.paid ? "paid" : "unpaid"}
                onChange={(v) => patchForm({ paid: v === "paid" })}
                aria-label="有薪或無薪"
              />
            </Field>

            <Field label="適用範圍">
              <Segmented
                options={(["all", "departments", "employees"] as SpecialScope[]).map((s) => ({ value: s, label: SPECIAL_SCOPE_LABEL[s] }))}
                value={form.scope}
                onChange={(v) => patchForm({ scope: v })}
                aria-label="適用範圍"
              />
            </Field>

            {form.scope === "departments" && (
              <Field label="部門" hint={`已選 ${form.departmentIds.length} 個`}>
                <div className="flex flex-wrap gap-2">
                  {departments.map((d) => {
                    const picked = form.departmentIds.includes(d.id);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => patchForm({ departmentIds: toggle(form.departmentIds, d.id) })}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium ${picked ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                        style={picked ? { backgroundColor: "var(--brand)" } : undefined}
                      >
                        {d.name}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            {form.scope === "employees" && (
              <Field label="員工" hint={`已選 ${form.employeeIds.length} 位`}>
                <div className="flex max-h-56 flex-wrap gap-2 overflow-y-auto">
                  {pickable.map((e) => {
                    const picked = form.employeeIds.includes(e.id);
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => patchForm({ employeeIds: toggle(form.employeeIds, e.id) })}
                        className={`rounded-full px-3 py-1.5 text-sm font-medium ${picked ? "text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                        style={picked ? { backgroundColor: "var(--brand)" } : undefined}
                      >
                        {e.name}
                        {employeeStatusNote(e) ? `（${employeeStatusNote(e)}）` : ""}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}

            <Field label="備註" hint="選填，例：臺北市、新北市停止上班">
              <Textarea rows={2} maxLength={500} value={form.note} onChange={(e) => patchForm({ note: e.target.value })} />
            </Field>

            <p className="text-xs leading-5 text-gray-400">
              當天已請假的員工：假單照原假別處理，無薪只扣請假以外沒做到的工時。落在例假日、休息日或國定假日的人不受影響。
            </p>

            {formError && <ErrorText>{formError}</ErrorText>}

            <div className="flex gap-2">
              <Button block onClick={() => void save()} loading={busy}>
                儲存
              </Button>
              <Button variant="secondary" block onClick={() => setForm(null)} disabled={busy}>
                取消
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>

      <ConfirmDialog
        open={!!deleting}
        title="刪除特殊假日"
        danger
        busy={busy}
        confirmLabel="刪除"
        message={
          deleting
            ? `確定刪除「${deleting.label}」（${rangeText(deleting.startDate, deleting.endDate)}）？\n刪除後未結算月份的草稿月表會自動重算，當天恢復一般工作日（未打卡會算缺勤）。`
            : undefined
        }
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
