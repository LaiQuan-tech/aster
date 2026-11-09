"use client";

/**
 * 預支區塊（原 /admin/advances 整頁，2026-11-09 併入「費用與給付」）。
 *
 * requested（申請單核准後自動開）→ 撥款（必填管道）→ 核銷（差額併薪資扣回需期別或現金；先看預覽）。
 * 三區：已撥款未核銷（逾期標示）、已核准待撥款、已核銷。核准步驟在申請簽核，不在此頁。
 */
import { useCallback, useEffect, useState } from "react";
import {
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
import { getAdvanceSettlementPreview } from "@/lib/advances-api";
import { advanceDate, advanceSubject, type SettlementPreview } from "@/lib/advance-view";
import { money } from "@/lib/cash-payouts-api";
import { AdvanceSettleSheet, type AdvanceRow } from "@/components/finance/AdvanceSettleSheet";

/** 撥款管道詢問（原頁的兩段 confirm）：確定＝現金；取消→再問匯款；再取消＝放棄。 */
export function askPayoutChannel(amount: number, name: string): "cash" | "transfer" | null {
  return window.confirm(
    `撥款 ${money(amount)} 元給 ${name}。\n\n` + "確定 = 現金\n取消 = 改選匯款（下一步會再問）",
  )
    ? "cash"
    : window.confirm("改以匯款撥款？\n\n確定 = 匯款\n取消 = 放棄")
      ? "transfer"
      : null;
}

export function AdvancesSection({
  refreshKey = 0,
  onChanged,
}: {
  refreshKey?: number;
  onChanged?: () => void;
}) {
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

  // 核銷前預覽：按「核銷」先讀預覽，確認對話框列出綁定的憑證、實支合計與差額，財務確認後才送出核銷。
  const [settleTarget, setSettleTarget] = useState<AdvanceRow | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);

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
  }, [load, refreshKey]);

  useEffect(() => {
    getEmployees()
      .then((e) => setEmployees(e.employees))
      .catch(() => null);
  }, []);

  const empName = (id: string) =>
    employees.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  async function onPay(a: Advance) {
    const channel = askPayoutChannel(Number(a.amount), empName(a.employee_id));
    if (!channel) return;

    setBusyId(a.id);
    setError(null);
    setMessage(null);
    try {
      await payAdvance(a.id, { payoutChannel: channel });
      setMessage(
        `已撥款 ${money(Number(a.amount))} 元（${channel === "cash" ? "現金" : "匯款"}）`,
      );
      await load();
      onChanged?.();
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "讀取核銷預覽失敗");
    } finally {
      setBusyId(null);
    }
  }

  function closeSettle() {
    setSettleTarget(null);
    setPreview(null);
  }

  async function onSettled(msg: string) {
    setSettleTarget(null);
    setPreview(null);
    setMessage(msg);
    await load();
    onChanged?.();
  }

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

      <AdvanceSettleSheet
        target={settleTarget}
        initialPreview={preview}
        empName={empName}
        onClose={closeSettle}
        onSettled={(msg) => void onSettled(msg)}
      />
    </>
  );
}
