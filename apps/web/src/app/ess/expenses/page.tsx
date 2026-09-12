"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthGate } from "@/components/AuthGate";
import { EssHeader } from "@/components/EssHeader";
import {
  getBranding,
  getMe,
  isAdminRole,
  getMyExpenseCategories,
  getMyExpenses,
  fileExpense,
  cancelExpense,
  uploadExpenseReceipt,
  getMyApprovedTrips,
  getMyTripAdvances,
  type Branding,
  type MyExpenseCategory,
  type MyExpenseClaim,
  type MyTrip,
  type MyTripAdvance,
} from "@/lib/ess-api";

function thisPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function money(n: number): string {
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

const STATUS_LABEL: Record<string, string> = {
  submitted: "待核銷",
  settled: "已核銷",
  cancelled: "已撤回",
  rejected: "已退件",
};

function ExpensesInner() {
  const [branding, setBranding] = useState<Branding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [categories, setCategories] = useState<MyExpenseCategory[]>([]);
  const [claims, setClaims] = useState<MyExpenseClaim[]>([]);
  const [period, setPeriod] = useState(thisPeriod);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 填報表單
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [incurredOn, setIncurredOn] = useState(today);
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  // 出差軌（模組三第 2 條）：這類報銷必須綁一張已核准的出差單。
  const [trips, setTrips] = useState<MyTrip[]>([]);
  const [tripRequestId, setTripRequestId] = useState("");
  const [advances, setAdvances] = useState<MyTripAdvance[]>([]);

  const load = useCallback(async () => {
    try {
      const [c, e, t, a] = await Promise.all([
        getMyExpenseCategories(),
        getMyExpenses(period),
        getMyApprovedTrips(),
        getMyTripAdvances(),
      ]);
      setCategories(c.categories.filter((x) => x.active));
      setClaims(e.claims);
      setTrips(t.requests);
      setAdvances(a.advances);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, [period]);

  useEffect(() => {
    getBranding().then((b) => setBranding(b.branding)).catch(() => null);
    getMe().then((m) => setIsAdmin(isAdminRole(m.role))).catch(() => null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = categories.find((c) => c.id === categoryId);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const created = await fileExpense({
        categoryId,
        amount: Number(amount),
        incurredOn,
        note: note.trim() || undefined,
        tripRequestId: selected?.requires_trip_approval ? tripRequestId : undefined,
      });
      // 憑證跟著單子一起送：事前審核可以省，憑證不能省。
      if (receipt) await uploadExpenseReceipt(created.id, receipt);
      setMessage(`已送出，歸屬 ${created.period} 月結`);
      setAmount("");
      setNote("");
      setReceipt(null);
      setTripRequestId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "送出失敗");
    } finally {
      setBusy(false);
    }
  }

  async function onCancel(id: string) {
    const reason = window.prompt("撤回理由（必填）：");
    if (reason === null) return;
    if (!reason.trim()) {
      setError("撤回理由為必填");
      return;
    }
    try {
      await cancelExpense(id, reason.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤回失敗");
    }
  }

  const total = claims
    .filter((c) => c.status === "submitted" || c.status === "settled")
    .reduce((a, c) => a + Number(c.amount), 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <EssHeader
        appName={branding?.appName}
        primaryColor={branding?.primaryColor}
        active="expenses"
        isAdmin={isAdmin}
      />
      <main className="mx-auto max-w-2xl space-y-4 px-3 pb-6 pt-4 sm:px-4">
        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="mb-1 text-lg font-semibold text-gray-800">填報日常支出</h2>
          <p className="mb-4 text-xs text-gray-500">
            送出後不需逐筆審核，由管理者於月結時一次核銷。請附上憑證。
          </p>

          {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
          {message && <p className="mb-3 text-sm text-green-700">{message}</p>}

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="cat">
                類別
              </label>
              <select
                id="cat"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                required
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
              >
                <option value="">請選擇</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {selected?.nature === "allowance" && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  此類別為<strong>定額補貼</strong>，屬薪資所得，會併入當月薪資扣繳。
                </p>
              )}
              {selected && selected.nature === "reimbursement" && selected.requires_receipt && (
                <p className="mt-2 text-xs text-gray-500">此類別需附憑證。</p>
              )}
            </div>

            {/* 出差軌：日常費用不必事前審核，長途出差必須先核准。 */}
            {selected?.requires_trip_approval && (
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="trip">
                  綁定出差單
                </label>
                {trips.length === 0 ? (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    你目前沒有已核准的出差單。此類別的費用必須先提出「公出/出差」
                    申請並經簽核，核准後才能報銷。
                  </p>
                ) : (
                  <>
                    <select
                      id="trip"
                      value={tripRequestId}
                      onChange={(e) => setTripRequestId(e.target.value)}
                      required
                      className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                    >
                      <option value="">請選擇</option>
                      {trips.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.start_at.slice(0, 10)}
                          {t.location ? ` · ${t.location}` : ""}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-400">
                      此類別的費用須掛在已核准的出差之下。
                    </p>
                  </>
                )}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="amt">
                  金額
                </label>
                <input
                  id="amt"
                  type="number"
                  min="1"
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                  className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="date">
                  發生日期
                </label>
                <input
                  id="date"
                  type="date"
                  value={incurredOn}
                  onChange={(e) => setIncurredOn(e.target.value)}
                  required
                  className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-gray-400">
                  填實際發生日。上月的單這月才交也沒關係，會歸到本月月結。
                </p>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="note">
                備註（選填）
              </label>
              <input
                id="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={250}
                className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700" htmlFor="receipt">
                憑證（發票／收據／乘車明細）
              </label>
              <input
                id="receipt"
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
                className="w-full text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={
                busy ||
                !categoryId ||
                (selected?.requires_trip_approval === true && !tripRequestId)
              }
              className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
              style={{ backgroundColor: "var(--brand)" }}
            >
              {busy ? "送出中…" : "送出"}
            </button>
          </form>
        </section>

        {advances.length > 0 && (
          <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
            <h2 className="mb-1 text-lg font-semibold text-gray-800">我的出差預支</h2>
            <p className="mb-4 text-xs text-gray-500">
              已撥款但尚未核銷的金額，回程請憑單據報銷後由公司沖抵，多退少補。
            </p>
            <ul className="space-y-2">
              {advances.map((a) => {
                const bal = a.balance === null ? null : Number(a.balance);
                return (
                  <li
                    key={a.id}
                    className="rounded-2xl border border-gray-100 bg-gray-50 p-3 text-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-gray-900">
                          {money(Number(a.amount))} 元
                        </div>
                        <div className="text-xs text-gray-500">
                          {a.status === "requested"
                            ? "已核准，尚未撥款"
                            : a.status === "paid"
                              ? `已撥款 ${a.paid_at?.slice(0, 10) ?? ""}・待核銷`
                              : a.status === "settled"
                                ? `已核銷 ${a.settled_at?.slice(0, 10) ?? ""}`
                                : a.status}
                        </div>
                      </div>
                      {a.status === "settled" && bal !== null && (
                        <span className="text-xs text-gray-600">
                          {bal === 0
                            ? "剛好結清"
                            : bal > 0
                              ? `公司補你 ${money(bal)}`
                              : `應退回 ${money(Math.abs(bal))}`}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-800">我的報銷</h2>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm"
            />
          </div>

          {claims.length === 0 ? (
            <p className="py-6 text-center text-sm text-gray-400">本期沒有報銷紀錄。</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-gray-600">
                本期合計 <strong>{money(total)}</strong> 元
              </p>
              <ul className="space-y-2">
                {claims.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-2xl border border-gray-100 bg-gray-50 p-3 text-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium text-gray-900">
                          {money(Number(c.amount))} 元
                          {c.nature === "allowance" && (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                              補貼
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">
                          {c.incurred_on}
                          {c.note ? ` · ${c.note}` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-xs text-gray-500">
                          {STATUS_LABEL[c.status] ?? c.status}
                        </span>
                        {c.status === "submitted" && (
                          <button
                            type="button"
                            onClick={() => void onCancel(c.id)}
                            className="mt-1 block text-xs text-red-600 underline"
                          >
                            撤回
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default function EssExpensesPage() {
  return (
    <AuthGate>
      <ExpensesInner />
    </AuthGate>
  );
}
