"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BottomSheet,
  Button,
  Card,
  ErrorText,
  Empty,
  PrimaryButton,
} from "@/components/admin-ui";
import {
  getAdvances,
  getOutstandingAdvances,
  payAdvance,
  getEmployees,
  type Advance,
  type Employee,
} from "@/lib/admin-api";
import { getAdvanceSettlementPreview, settleAdvanceChecked } from "@/lib/advances-api";
import {
  advanceDate,
  advanceSubject,
  apiErrorCode,
  claimStatusLabel,
  describeBalance,
  isValidPeriod,
  settlementWarnings,
  type AdvanceRequestInfo,
  type SettlementPreview,
} from "@/lib/advance-view";
import { todayKey } from "@/lib/ess-format";

function money(n: number): string {
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

/** GET /advances 每列附對應申請單的摘要（2026-10-11）；admin-api.ts 的 Advance 沒宣告，這裡補。 */
type AdvanceRow = Advance & { request?: AdvanceRequestInfo | null };

/** 預設從本月薪資結算（本地月份，不用 UTC 切片——月初／月底跨日才不會差一個月）。 */
function thisPeriod(): string {
  return todayKey().slice(0, 7);
}

export default function AdminAdvancesPage() {
  const [requested, setRequested] = useState<AdvanceRow[]>([]);
  const [outstanding, setOutstanding] = useState<
    Array<AdvanceRow & { daysOutstanding: number | null; overdue: boolean }>
  >([]);
  // 逾期門檻由伺服器給（取自 expense_settings），不在前端寫死。
  const [overdueDays, setOverdueDays] = useState(30);
  const [outstandingTotal, setOutstandingTotal] = useState(0);
  const [settled, setSettled] = useState<AdvanceRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 核銷前預覽（取代原本的 confirm＋prompt）：按「核銷」先讀預覽，確認對話框列出綁定的憑證、
  // 實支合計與差額，財務確認後才送出核銷。
  const [settleTarget, setSettleTarget] = useState<AdvanceRow | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [handling, setHandling] = useState<"payroll" | "cash">("payroll");
  const [recoveryPeriod, setRecoveryPeriod] = useState(thisPeriod);
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [req, out, set] = await Promise.all([
        getAdvances({ status: "requested" }),
        getOutstandingAdvances(),
        getAdvances({ status: "settled" }),
      ]);
      setRequested(req.advances);
      setOutstanding(out.advances);
      setOutstandingTotal(out.total);
      setOverdueDays(out.overdueDays);
      setSettled(set.advances);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, []);

  useEffect(() => {
    void load();
    getEmployees()
      .then((e) => setEmployees(e.employees))
      .catch(() => null);
  }, [load]);

  const empName = (id: string) =>
    employees.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  async function onPay(a: Advance) {
    const channel = window.confirm(
      `撥款 ${money(Number(a.amount))} 元給 ${empName(a.employee_id)}。\n\n` +
        "確定 = 現金\n取消 = 改選匯款（下一步會再問）",
    )
      ? "cash"
      : window.confirm("改以匯款撥款？\n\n確定 = 匯款\n取消 = 放棄")
        ? "transfer"
        : null;
    if (!channel) return;

    setBusyId(a.id);
    setError(null);
    setMessage(null);
    try {
      await payAdvance(a.id, { payoutChannel: channel as "cash" | "transfer" });
      setMessage(
        `已撥款 ${money(Number(a.amount))} 元（${channel === "cash" ? "現金" : "匯款"}）`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "撥款失敗");
    } finally {
      setBusyId(null);
    }
  }

  /** 按「核銷」：先讀預覽，讀到了才開確認對話框（讀不到就在頁面上報錯，不核銷）。 */
  async function onSettle(a: AdvanceRow) {
    setBusyId(a.id);
    setError(null);
    setMessage(null);
    try {
      const p = await getAdvanceSettlementPreview(a.id);
      setSettleTarget(a);
      setPreview(p);
      setHandling("payroll");
      setRecoveryPeriod(thisPeriod());
      setSettleError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取核銷預覽失敗");
    } finally {
      setBusyId(null);
    }
  }

  function closeSettle() {
    if (settleBusy) return;
    setSettleTarget(null);
    setPreview(null);
    setSettleError(null);
  }

  /** 對話框的「確認核銷」：帶上預覽看到的實支合計，預覽之後憑證有增減 → 重新預覽、請財務再確認一次。 */
  async function onConfirmSettle() {
    if (!settleTarget || !preview) return;
    // 差額為 0 時處理方式不影響金額，一律記現金（不用逼財務填期別）。
    const balanceHandling = preview.balance === 0 ? "cash" : handling;
    if (balanceHandling === "payroll" && !isValidPeriod(recoveryPeriod)) {
      setSettleError("期別格式須為 YYYY-MM（例：2026-10）");
      return;
    }
    setSettleBusy(true);
    setSettleError(null);
    try {
      const res = await settleAdvanceChecked(settleTarget.id, {
        balanceHandling,
        recoveryPeriod: balanceHandling === "payroll" ? recoveryPeriod.trim() : undefined,
        expectedActualTotal: preview.actualTotal,
      });
      setSettleTarget(null);
      setPreview(null);
      setMessage(
        `已核銷：預支 ${money(res.amount)}、實支 ${money(res.actualTotal)}、` +
          `差額 ${money(Math.abs(res.balance))} 元（${res.direction}）`,
      );
      await load();
    } catch (err) {
      if (apiErrorCode(err) === "claims_changed") {
        // 預覽之後員工又新增／撤回了綁定憑證：重新讀預覽，讓財務確認新的數字。
        try {
          setPreview(await getAdvanceSettlementPreview(settleTarget.id));
          setSettleError("員工的綁定憑證在你查看期間有變動，已重新計算，請再確認一次。");
        } catch (reloadErr) {
          setSettleError(reloadErr instanceof Error ? reloadErr.message : "重新讀取預覽失敗");
        }
      } else {
        setSettleError(err instanceof Error ? err.message : "核銷失敗");
      }
    } finally {
      setSettleBusy(false);
    }
  }

  const settleBalance = preview ? describeBalance(preview.balance, (n) => `${money(n)} 元`) : null;
  const settleWarningList = preview ? settlementWarnings(preview) : [];

  return (
    <>
      {(error || message) && (
        <Card>
          {error && <ErrorText>{error}</ErrorText>}
          {message && <p className="text-sm text-green-700">{message}</p>}
        </Card>
      )}

      {/* 未核銷＝公司對員工的債權。放最上面，因為這是唯一會「越拖越糟」的一區。 */}
      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">
          已撥款・尚未核銷（{outstanding.length}）
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-gray-500">
          這是<strong>公司對員工的未結債權</strong>——離職結算要扣回的依據，
          也是「錢拿走很久卻沒交單」的催辦清單。合計{" "}
          <strong>{money(outstandingTotal)}</strong> 元；逾 {overdueDays} 天標示為逾期。
        </p>

        {outstanding.length === 0 ? (
          <Empty>沒有未核銷的預支。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2">員工</th>
                  <th className="py-2">種類</th>
                  <th className="py-2 text-right">預支金額</th>
                  <th className="py-2">撥款日</th>
                  <th className="py-2">管道</th>
                  <th className="py-2 text-right">已過天數</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {outstanding.map((a) => {
                  const overdue = a.overdue;
                  return (
                    <tr
                      key={a.id}
                      className={`border-b border-gray-100 ${overdue ? "bg-amber-50" : ""}`}
                    >
                      <td className="py-2">{empName(a.employee_id)}</td>
                      <td className="py-2 text-xs">
                        <div>{advanceSubject(a)}</div>
                        <div className="text-gray-400">{advanceDate(a)}</div>
                      </td>
                      <td className="py-2 text-right">{money(Number(a.amount))}</td>
                      <td className="py-2 text-xs">{a.paid_at?.slice(0, 10) ?? "—"}</td>
                      <td className="py-2 text-xs">
                        {a.payout_channel === "cash" ? "現金" : a.payout_channel === "transfer" ? "匯款" : "—"}
                      </td>
                      <td
                        className={`py-2 text-right text-xs ${overdue ? "font-semibold text-amber-900" : ""}`}
                      >
                        {a.daysOutstanding ?? "—"}
                        {overdue ? " ⚠" : ""}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => void onSettle(a)}
                          disabled={busyId === a.id}
                          className="text-xs text-blue-600 underline disabled:opacity-50"
                        >
                          核銷
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">
          已核准・待撥款（{requested.length}）
        </h2>
        <p className="mb-4 text-xs text-gray-500">
          申請核准時自動開單，但<strong>錢還沒出去</strong>。撥款須指定管道，
          現金尤其要留痕。
        </p>

        {requested.length === 0 ? (
          <Empty>沒有待撥款的預支。</Empty>
        ) : (
          <ul className="space-y-2">
            {requested.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2 text-sm"
              >
                <span>
                  {empName(a.employee_id)} ·{" "}
                  <span className="text-xs text-gray-500">
                    {advanceDate(a)} {advanceSubject(a)}
                  </span>{" "}
                  · <strong>{money(Number(a.amount))}</strong> 元
                  <span className="ml-2 text-xs text-gray-500">
                    核准於 {a.created_at.slice(0, 10)}
                  </span>
                </span>
                <PrimaryButton onClick={() => void onPay(a)} disabled={busyId === a.id}>
                  {busyId === a.id ? "撥款中…" : "撥款"}
                </PrimaryButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">
          已核銷（{settled.length}）
        </h2>
        {settled.length === 0 ? (
          <Empty>尚無已核銷的預支。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="py-2">員工</th>
                  <th className="py-2 text-right">預支</th>
                  <th className="py-2 text-right">實支</th>
                  <th className="py-2 text-right">差額</th>
                  <th className="py-2">處理</th>
                  <th className="py-2">核銷日</th>
                </tr>
              </thead>
              <tbody>
                {settled.map((a) => {
                  const bal = Number(a.balance ?? 0);
                  return (
                    <tr key={a.id} className="border-b border-gray-100">
                      <td className="py-2">{empName(a.employee_id)}</td>
                      <td className="py-2 text-right">{money(Number(a.amount))}</td>
                      <td className="py-2 text-right">{money(Number(a.actual_total ?? 0))}</td>
                      <td className="py-2 text-right">
                        {bal === 0 ? (
                          <span className="text-xs text-gray-500">剛好結清</span>
                        ) : bal > 0 ? (
                          <span className="text-xs text-green-700">
                            公司補 {money(bal)}
                          </span>
                        ) : (
                          <span className="text-xs text-amber-800">
                            員工退 {money(Math.abs(bal))}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-xs">
                        {a.balance_handling === "payroll"
                          ? `薪資 ${a.recovery_period ?? ""}`
                          : a.balance_handling === "cash"
                            ? "現金"
                            : "—"}
                      </td>
                      <td className="py-2 text-xs">{a.settled_at?.slice(0, 10) ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 核銷前預覽：這筆預支綁了哪些憑證、合計多少、差額多少；確認後才核銷。 */}
      <BottomSheet open={settleTarget !== null && preview !== null} onClose={closeSettle} title="核銷預支">
        {settleTarget && preview && (
          <div className="space-y-4 text-sm text-gray-700">
            <div>
              <p className="font-medium text-gray-900">
                {empName(settleTarget.employee_id)} · {advanceDate(settleTarget)} {advanceSubject(settleTarget)}
              </p>
              <p className="text-xs text-gray-500">
                {settleTarget.kind === "petty_cash" ? "零用金預支" : "出差預支"} {money(preview.amount)} 元
                {settleTarget.paid_at ? ` · ${settleTarget.paid_at.slice(0, 10)} 撥款` : ""}
              </p>
            </div>

            {settleWarningList.length > 0 && (
              <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800" role="alert">
                {settleWarningList.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            <div>
              <h3 className="mb-1.5 text-xs font-medium text-gray-500">
                綁定的憑證（{preview.countedCount} 筆計入實支）
              </h3>
              {preview.claims.length === 0 ? (
                <Empty>沒有綁定任何憑證。</Empty>
              ) : (
                <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100">
                  {preview.claims.map((c) => (
                    <li
                      key={c.id}
                      className={`flex items-start justify-between gap-3 px-3 py-2 ${c.counted ? "" : "bg-gray-50 text-gray-400"}`}
                    >
                      <div className="min-w-0">
                        <div className="text-sm">
                          {c.incurredOn.slice(5).replace("-", "/")} · {c.categoryName ?? "（未分類）"}
                        </div>
                        <div className="truncate text-xs text-gray-500">
                          {c.note ? `${c.note} · ` : ""}
                          {claimStatusLabel(c.status)}
                          {c.counted ? (c.receiptCount > 0 ? ` · 附單據 ${c.receiptCount} 份` : " · 缺單據") : "（不計入）"}
                        </div>
                      </div>
                      <div className={`shrink-0 text-sm ${c.counted ? "font-medium text-gray-900" : "line-through"}`}>
                        {money(c.amount)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-xl bg-gray-50 px-3 py-2.5">
              <dt className="text-gray-500">預支金額</dt>
              <dd className="text-right">{money(preview.amount)} 元</dd>
              <dt className="text-gray-500">實支合計</dt>
              <dd className="text-right">{money(preview.actualTotal)} 元</dd>
              <dt className="font-medium text-gray-700">差額</dt>
              <dd
                className={`text-right font-semibold ${
                  settleBalance?.tone === "green"
                    ? "text-green-700"
                    : settleBalance?.tone === "amber"
                      ? "text-amber-800"
                      : "text-gray-600"
                }`}
              >
                {settleBalance?.text}
              </dd>
            </dl>

            {preview.balance === 0 ? (
              <p className="text-xs text-gray-500">差額為 0，不需另外處理。</p>
            ) : (
              <fieldset className="space-y-1">
                <legend className="mb-1 text-xs font-medium text-gray-500">差額怎麼處理？</legend>
                <label className="flex min-h-9 cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="settle-handling"
                    checked={handling === "payroll"}
                    onChange={() => setHandling("payroll")}
                    className="h-4 w-4 accent-[var(--brand)]"
                  />
                  從薪資{preview.balance > 0 ? "補" : "扣"}
                </label>
                {handling === "payroll" && (
                  <div className="ml-6 flex items-center gap-2 text-xs text-gray-500">
                    <label htmlFor="settle-period">從哪一期薪資結算</label>
                    <input
                      id="settle-period"
                      type="month"
                      value={recoveryPeriod}
                      onChange={(e) => setRecoveryPeriod(e.target.value)}
                      className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm text-gray-900"
                    />
                  </div>
                )}
                <label className="flex min-h-9 cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="settle-handling"
                    checked={handling === "cash"}
                    onChange={() => setHandling("cash")}
                    className="h-4 w-4 accent-[var(--brand)]"
                  />
                  現金找補
                </label>
              </fieldset>
            )}

            {settleError && <ErrorText>{settleError}</ErrorText>}

            <div className="grid grid-cols-2 gap-3 pt-1">
              <Button variant="secondary" size="lg" onClick={closeSettle} disabled={settleBusy}>
                取消
              </Button>
              <Button size="lg" onClick={() => void onConfirmSettle()} loading={settleBusy} disabled={!preview.settleable}>
                確認核銷
              </Button>
            </div>
          </div>
        )}
      </BottomSheet>
    </>
  );
}
