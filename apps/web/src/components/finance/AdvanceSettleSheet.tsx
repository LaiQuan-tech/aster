"use client";

/**
 * 預支核銷前預覽對話框（原 /admin/advances 內嵌，2026-11-09 抽出共用：預支區塊與合併頁明細面板都用）。
 *
 * 呼叫端先讀 GET /advances/:id/settlement-preview，讀到了才把 target＋preview 傳進來開框（讀不到就在呼叫端報錯，不核銷）。
 * 確認時帶預覽看到的實支合計；預覽之後憑證有增減（claims_changed）→ 重新預覽、請財務再確認一次。
 */
import { useEffect, useState } from "react";
import { BottomSheet, Button, ErrorText, Empty } from "@/components/admin-ui";
import type { Advance } from "@/lib/admin-api";
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
import { money } from "@/lib/cash-payouts-api";
import { todayKey } from "@/lib/ess-format";
import { errorMessageOf } from "@/lib/period-closed";

/** GET /advances 每列附對應申請單的摘要（2026-10-11）；admin-api.ts 的 Advance 沒宣告，這裡補。 */
export type AdvanceRow = Advance & { request?: AdvanceRequestInfo | null };

/** 預設從本月薪資結算（本地月份，不用 UTC 切片——月初／月底跨日才不會差一個月）。 */
export function thisLocalPeriod(): string {
  return todayKey().slice(0, 7);
}

export function AdvanceSettleSheet({
  target: settleTarget,
  initialPreview,
  empName,
  onClose,
  onSettled,
}: {
  target: AdvanceRow | null;
  initialPreview: SettlementPreview | null;
  empName: (id: string) => string;
  onClose: () => void;
  /** 核銷成功：訊息交給呼叫端顯示並重新載入。 */
  onSettled: (message: string) => void;
}) {
  const [preview, setPreview] = useState<SettlementPreview | null>(initialPreview);
  const [handling, setHandling] = useState<"payroll" | "cash">("payroll");
  const [recoveryPeriod, setRecoveryPeriod] = useState(thisLocalPeriod);
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  // 每次開新的一筆：重設成預設值（同原頁 onSettle 的重設）。
  useEffect(() => {
    setPreview(initialPreview);
    setHandling("payroll");
    setRecoveryPeriod(thisLocalPeriod());
    setSettleError(null);
  }, [settleTarget?.id, initialPreview]);

  function closeSettle() {
    if (settleBusy) return;
    setSettleError(null);
    onClose();
  }

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
      onSettled(
        `已核銷：預支 ${money(res.amount)}、實支 ${money(res.actualTotal)}、` +
          `差額 ${money(Math.abs(res.balance))} 元（${res.direction}）`,
      );
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
        // 差額要從某一期薪資扣回／補發、而那一期已發薪鎖定 → 409 period_closed →「YYYY-MM 已結算，請洽管理者」。
        setSettleError(errorMessageOf(err, "核銷失敗"));
      }
    } finally {
      setSettleBusy(false);
    }
  }

  const settleBalance = preview ? describeBalance(preview.balance, (n) => `${money(n)} 元`) : null;
  const settleWarningList = preview ? settlementWarnings(preview) : [];

  return (
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
  );
}
