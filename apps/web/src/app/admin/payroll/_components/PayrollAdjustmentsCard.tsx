"use client";

/**
 * 薪資作業 →「薪資加減項（前期更正）」（2026-10-11 業主拍板）。
 *
 * 已匯款的月份不改原薪資單，改在下個月薪資補發或扣回：選一個薪資月份，對某位員工展開「加減項」編輯區，
 * 加一行有說明的補發／扣回（名稱、金額、是否課稅、更正的是哪個月、HR 備註）。薪資執行時併進該月薪資單，
 * 薪資單上（後台列印、員工端、Email）逐項列出並標「更正 YYYY-MM」：
 *   • 課稅的補發 → 計入應發（併入扣繳基礎）   • 扣回 → 計入應扣、只減實發（不減應發，保守）
 *   • 不課稅的補發 → 只加在實發
 * 新增、修改、刪除後要**重新執行薪資作業**才會反映到草稿薪資單（草稿過期時定稿會被擋）；該月已結算或該員工薪資單已定稿則不能改。
 *
 * 「前期更正」入口連結（lib/payroll-periods-api.ts 的 PRIOR_PERIOD_CORRECTION_HREF）指到這張卡的 #payroll-adjustments。
 * 純函式（表單驗證、歸屬、合計、錯誤訊息）與 API 呼叫在 lib/payroll-adjustments-api.ts（有單元測試）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, InlineError, Input, Pill, Select, Skeleton, useToast } from "@/components/admin-ui";
import type { Employee } from "@/lib/admin-api";
import {
  LABEL_MAX,
  NOTE_MAX,
  TREATMENT_LABEL,
  adjustmentDisplayLabel,
  adjustmentErrorMessage,
  adjustmentTreatment,
  buildCreateBody,
  buildPatch,
  createPayrollAdjustment,
  deletePayrollAdjustment,
  draftFromAdjustment,
  emptyAdjustmentDraft,
  listPayrollAdjustments,
  payslipStateNote,
  signedMoney,
  summarizeAdjustments,
  updatePayrollAdjustment,
  type AdjustmentDraft,
  type PayrollAdjustmentWithState,
  type PayslipAdjustState,
  type PeriodLockState,
} from "@/lib/payroll-adjustments-api";

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function money(n: number): string {
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
}

interface Props {
  /** 薪資作業頁已載入的員工（名稱、工號用來列表與搜尋）。 */
  employees: Employee[];
  /** 頁面上每執行一次薪資作業就加 1，卡片重新讀一次（草稿薪資單是否跟上了）。 */
  refreshKey?: number;
}

export function PayrollAdjustmentsCard({ employees, refreshKey = 0 }: Props) {
  const toast = useToast();
  const [period, setPeriod] = useState(currentMonth);
  const [rows, setRows] = useState<PayrollAdjustmentWithState[]>([]);
  const [periodState, setPeriodState] = useState<PeriodLockState | undefined>(undefined);
  /** API 回的：草稿薪資單沒跟上加減項的員工 id（含加減項已全刪光、草稿卻還內嵌舊的）。 */
  const [staleIds, setStaleIds] = useState<string[]>([]);
  /** API 回的：範圍外員工的提醒（沒有薪資結構、已離職或停用）。 */
  const [notes, setNotes] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [openEmpId, setOpenEmpId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdjustmentDraft>(() => emptyAdjustmentDraft(currentMonth()));
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 剛做完新增／修改／刪除，後端回的該員工薪資單狀態（草稿是否過期、是否已定稿）。 */
  const [lastState, setLastState] = useState<{ empId: string; state: PayslipAdjustState } | null>(null);

  // 請求序號：快速換月份或連續操作時，只採用「最後一次發出」的回應，慢回來的舊月份資料不會蓋掉新月份。
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const res = await listPayrollAdjustments({ period });
      if (seq !== loadSeq.current) return;
      setRows(res.adjustments);
      setPeriodState(res.periodState);
      setStaleIds(res.staleEmployees ?? []);
      setNotes(res.employeeNotes ?? {});
      setLoadError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // 載入失敗不能留著舊資料（可能是別的月份的）：清空，錯誤訊息另外顯示。
      setRows([]);
      setPeriodState(undefined);
      setStaleIds([]);
      setNotes({});
      setLoadError(adjustmentErrorMessage(err, "載入失敗"));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // 頁面重新執行了薪資作業（refreshKey 變了）：剛才操作後記下的狀態作廢，改以重新讀回來的為準。
  useEffect(() => {
    setLastState(null);
  }, [refreshKey]);

  // 換月份：收起編輯區、清掉表單、提醒，以及上一個月份的資料。
  useEffect(() => {
    setOpenEmpId(null);
    setEditingId(null);
    setDraft(emptyAdjustmentDraft(period));
    setFormError(null);
    setLastState(null);
    setRows([]);
    setPeriodState(undefined);
    setStaleIds([]);
    setNotes({});
  }, [period]);

  const byEmployee = useMemo(() => {
    const map = new Map<string, PayrollAdjustmentWithState[]>();
    for (const row of rows) map.set(row.employeeId, [...(map.get(row.employeeId) ?? []), row]);
    return map;
  }, [rows]);

  const nameOf = useCallback(
    (id: string) => {
      const e = employees.find((x) => x.id === id);
      if (!e) return id.slice(0, 8);
      return e.emp_no ? `${e.name}（${e.emp_no}）` : e.name;
    },
    [employees],
  );

  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const list = kw
      ? employees.filter((e) => `${e.name} ${e.emp_no ?? ""}`.toLowerCase().includes(kw))
      : showAll
        ? employees
        : employees.filter((e) => byEmployee.has(e.id) || staleIds.includes(e.id));
    return [...list].sort((a, b) => {
      const diff = Number(byEmployee.has(b.id) || staleIds.includes(b.id)) - Number(byEmployee.has(a.id) || staleIds.includes(a.id));
      return diff !== 0 ? diff : a.name.localeCompare(b.name, "zh-TW");
    });
  }, [employees, byEmployee, keyword, showAll, staleIds]);

  // 草稿沒跟上加減項的員工：以 API 回的為準（包含加減項已全刪光、不在列表裡的那種），再補上列表各列自己帶的。
  const staleEmployees = useMemo(() => {
    const ids = new Set<string>(staleIds);
    for (const row of rows) if (row.payslip.stale) ids.add(row.employeeId);
    return ids;
  }, [rows, staleIds]);

  const periodClosed = periodState === "closed";

  function toggle(empId: string) {
    setOpenEmpId((cur) => (cur === empId ? null : empId));
    setEditingId(null);
    setDraft(emptyAdjustmentDraft(period));
    setFormError(null);
    setLastState((cur) => (cur?.empId === empId ? cur : null));
  }

  function startEdit(row: PayrollAdjustmentWithState) {
    setEditingId(row.id);
    setDraft(draftFromAdjustment(row));
    setFormError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyAdjustmentDraft(period));
    setFormError(null);
  }

  async function submit(empId: string) {
    if (busy) return;
    setFormError(null);
    // 先驗證（錯誤訊息直接給人看）再送；修改只送可改的欄位（員工與期別不能改，要換就刪掉重建）。
    const editing = editingId;
    const create = editing ? null : buildCreateBody(draft, { employeeId: empId, period });
    const patch = editing ? buildPatch(draft, period) : null;
    const invalid = create && !create.ok ? create.error : patch && !patch.ok ? patch.error : null;
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setBusy(true);
    try {
      const res =
        editing && patch?.ok
          ? await updatePayrollAdjustment(editing, patch.value)
          : create?.ok
            ? await createPayrollAdjustment(create.value)
            : null;
      if (!res) return;
      setLastState({ empId, state: res.payslip });
      toast.show(editing ? "已更新加減項" : "已新增加減項", "success");
      // 範圍外員工（沒有薪資結構、已離職或停用）：新增成功但要講清楚這筆不會自動發放／月結檢查看不到。
      const warnings = (res as { warnings?: string[] }).warnings;
      if (warnings && warnings.length > 0) toast.show(warnings.join("；"), "info");
      setEditingId(null);
      setDraft(emptyAdjustmentDraft(period));
      await load();
    } catch (err) {
      setFormError(adjustmentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(empId: string, row: PayrollAdjustmentWithState) {
    if (busy) return;
    if (!window.confirm(`刪除「${row.label}」（${signedMoney(row.amount)}）？\n刪除後要重新執行薪資作業才會從薪資單拿掉。`)) return;
    setBusy(true);
    setFormError(null);
    try {
      const res = await deletePayrollAdjustment(row.id);
      setLastState({ empId, state: res.payslip });
      toast.show("已刪除加減項", "success");
      if (editingId === row.id) cancelEdit();
      await load();
    } catch (err) {
      setFormError(adjustmentErrorMessage(err, "刪除失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="payroll-adjustments" className="scroll-mt-4" data-testid="payroll-adjustments-card">
      <Card title="薪資加減項（前期更正）">
        <p className="-mt-1 mb-3 text-sm text-gray-500">
          已匯款的月份不改原薪資單，改在下個月薪資補發或扣回。選薪資月份，對員工加一行有說明的補發或扣回：薪資單（後台列印、員工端、
          Email）會逐項列出並標「更正 YYYY-MM」。<span className="font-medium text-gray-700">新增或修改後要重新執行薪資作業才會反映。</span>
        </p>

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="block w-44 text-xs font-medium text-gray-500">
            放進哪一期的薪資單
            <Input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="mt-1" />
          </label>
          <label className="block min-w-[12rem] flex-1 text-xs font-medium text-gray-500">
            搜尋員工（姓名或工號）
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="輸入姓名或工號" className="mt-1" />
          </label>
          {!keyword.trim() && (
            <label className="flex items-center gap-2 pb-2 text-sm text-gray-600">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              列出全部員工
            </label>
          )}
        </div>

        {periodClosed && (
          <p role="note" data-testid="adjustments-period-closed" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {period} 已結算（發薪鎖定），不能再改加減項；要改請先由老闆或老闆指定的人重新開放，或改加在下個月。
          </p>
        )}
        {staleEmployees.size > 0 && (
          <p role="status" data-testid="adjustments-stale-banner" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            有 {staleEmployees.size} 位員工的草稿薪資單還沒跟上加減項（{[...staleEmployees].map(nameOf).join("、")}）：請到下方「執行薪資/獎金作業」重新執行 {period}
            的薪資，否則無法定稿。
          </p>
        )}
        {loadError && <InlineError className="mb-3">載入加減項失敗：{loadError}</InlineError>}

        {loading && rows.length === 0 ? (
          <Skeleton lines={3} />
        ) : visible.length === 0 ? (
          <p className="text-sm text-gray-400">
            {keyword.trim() ? "找不到符合的員工" : `${period} 還沒有任何加減項。輸入姓名或工號搜尋員工，或勾選「列出全部員工」後展開要加的那位。`}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {visible.map((emp) => {
              const list = byEmployee.get(emp.id) ?? [];
              const totals = summarizeAdjustments(list);
              const open = openEmpId === emp.id;
              const rowState = list[0]?.payslip ?? null;
              // 列表重新讀回來的狀態優先；沒有任何加減項（例如剛刪光）才用剛操作後記下的。
              const state = rowState ?? (lastState?.empId === emp.id ? lastState.state : null);
              const staleNow = staleEmployees.has(emp.id);
              const note = payslipStateNote(state ? { ...state, stale: state.stale || staleNow } : staleNow ? { status: "draft", stale: true } : null, period);
              const empNotes = notes[emp.id] ?? [];
              const locked = periodClosed || state?.status === "finalized";
              return (
                <li key={emp.id} data-testid={`adjustments-emp-${emp.id}`}>
                  <button
                    type="button"
                    onClick={() => toggle(emp.id)}
                    aria-expanded={open}
                    aria-controls={`adjustments-panel-${emp.id}`}
                    className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50"
                  >
                    <span className="w-4 text-gray-400" aria-hidden="true">
                      {open ? "▾" : "▸"}
                    </span>
                    <span className="font-medium text-gray-800">{nameOf(emp.id)}</span>
                    {list.length > 0 && <Pill tone="blue">{list.length} 筆</Pill>}
                    {list.length > 0 && (
                      <span className={`text-sm tabular-nums ${totals.netEffect < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                        實發 {signedMoney(totals.netEffect)}
                      </span>
                    )}
                    {state?.status === "finalized" && <Pill tone="green">薪資單已定稿</Pill>}
                    {(state?.stale || staleNow) && state?.status !== "finalized" && <Pill tone="amber">草稿未更新</Pill>}
                    {empNotes.length > 0 && <Pill tone="red">需注意</Pill>}
                  </button>

                  {open && (
                    <div id={`adjustments-panel-${emp.id}`} className="space-y-3 border-t border-gray-100 bg-gray-50/50 px-3 py-3">
                      {empNotes.map((text) => (
                        <p key={text} role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="adjustment-employee-note">
                          {text}
                        </p>
                      ))}
                      {note && (
                        <p
                          role={note.tone === "warn" ? "status" : "note"}
                          className={`rounded-lg px-3 py-2 text-sm ${note.tone === "warn" ? "bg-amber-50 text-amber-800" : "bg-gray-100 text-gray-600"}`}
                        >
                          {note.text}
                        </p>
                      )}

                      {list.length === 0 ? (
                        <p className="text-sm text-gray-400">這位員工在 {period} 還沒有加減項。</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead>
                              <tr className="border-b border-gray-200 text-xs text-gray-500">
                                <th className="py-1.5 pr-3">名稱（薪資單上的標題）</th>
                                <th className="py-1.5 pr-3 text-right">金額</th>
                                <th className="py-1.5 pr-3">歸屬</th>
                                <th className="py-1.5 pr-3">HR 備註</th>
                                <th className="py-1.5" />
                              </tr>
                            </thead>
                            <tbody>
                              {list.map((row) => (
                                <tr key={row.id} className="border-b border-gray-100 align-top">
                                  <td className="py-1.5 pr-3 text-gray-800">{adjustmentDisplayLabel(row.label, row.relatedPeriod)}</td>
                                  <td className={`py-1.5 pr-3 text-right tabular-nums ${row.amount < 0 ? "text-rose-700" : "text-emerald-700"}`}>
                                    {signedMoney(row.amount)}
                                  </td>
                                  <td className="py-1.5 pr-3 text-xs text-gray-500">{TREATMENT_LABEL[adjustmentTreatment(row)]}</td>
                                  <td className="py-1.5 pr-3 text-xs text-gray-500">{row.note ?? "—"}</td>
                                  <td className="whitespace-nowrap py-1.5 text-right">
                                    <button
                                      type="button"
                                      disabled={locked || busy}
                                      onClick={() => startEdit(row)}
                                      className="mr-3 text-sm text-gray-600 hover:underline disabled:opacity-40 disabled:no-underline"
                                    >
                                      修改
                                    </button>
                                    <button
                                      type="button"
                                      disabled={locked || busy}
                                      onClick={() => void remove(emp.id, row)}
                                      className="text-sm text-red-600 hover:underline disabled:opacity-40 disabled:no-underline"
                                    >
                                      刪除
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="text-xs text-gray-500">
                                <td className="pt-2 pr-3">
                                  合計：計入應發 {money(totals.earnings)}、計入應扣 {money(totals.deductions)}、只加實發 {money(totals.nonTaxable)}
                                </td>
                                <td className="pt-2 pr-3 text-right font-medium tabular-nums text-gray-700">{signedMoney(totals.netEffect)}</td>
                                <td colSpan={3} />
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      )}

                      {locked ? null : (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void submit(emp.id);
                          }}
                          className="space-y-3 rounded-xl border border-gray-200 bg-white p-3"
                          aria-label={editingId ? "修改加減項" : "新增加減項"}
                        >
                          <p className="text-sm font-medium text-gray-700">{editingId ? "修改加減項" : "新增加減項"}</p>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
                            <label className="block text-xs font-medium text-gray-500 sm:col-span-3">
                              名稱（員工看得到）
                              <Input
                                value={draft.label}
                                maxLength={LABEL_MAX}
                                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                                placeholder="例：補發 9 月加班費"
                                className="mt-1"
                              />
                            </label>
                            <label className="block text-xs font-medium text-gray-500">
                              方向
                              <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as AdjustmentDraft["kind"] })} className="mt-1">
                                <option value="add">補發（加）</option>
                                <option value="deduct">扣回（減）</option>
                              </Select>
                            </label>
                            <label className="block text-xs font-medium text-gray-500">
                              金額
                              <Input
                                value={draft.amount}
                                inputMode="decimal"
                                onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                                placeholder="3000"
                                className="mt-1"
                              />
                            </label>
                            <label className="block text-xs font-medium text-gray-500">
                              更正的月份
                              <Input
                                type="month"
                                value={draft.relatedPeriod}
                                max={period}
                                onChange={(e) => setDraft({ ...draft, relatedPeriod: e.target.value })}
                                className="mt-1"
                              />
                            </label>
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
                            <label className="block text-xs font-medium text-gray-500 sm:col-span-4">
                              HR 備註（只有 HR 看得到，不會印在薪資單上）
                              <Input
                                value={draft.note}
                                maxLength={NOTE_MAX}
                                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                                className="mt-1"
                              />
                            </label>
                            <label className="flex items-center gap-2 pb-2 text-sm text-gray-700 sm:col-span-2 sm:self-end">
                              <input
                                type="checkbox"
                                checked={draft.taxable}
                                onChange={(e) => setDraft({ ...draft, taxable: e.target.checked })}
                              />
                              {draft.kind === "deduct" ? "追回的是已課稅的所得" : "屬薪資所得（併入應發與扣繳）"}
                            </label>
                          </div>
                          <p className="text-xs text-gray-400">
                            補發勾「屬薪資所得」→ 計入應發並併入扣繳基礎；不勾 → 只加在實發。扣回一律只減實發、不減應發（已扣繳的稅不退，年度結算再調整）；
                            勾「追回的是已課稅的所得」只影響工資清冊的分欄——年度申報時才知道全年應發合計裡有多少是已經收回的。
                          </p>
                          {formError && <InlineError>{formError}</InlineError>}
                          <div className="flex flex-wrap justify-end gap-2">
                            {editingId && (
                              <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={busy}>
                                取消修改
                              </Button>
                            )}
                            <Button type="submit" size="sm" loading={busy}>
                              {editingId ? "儲存修改" : "新增"}
                            </Button>
                          </div>
                        </form>
                      )}
                      {locked && formError && <InlineError>{formError}</InlineError>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
