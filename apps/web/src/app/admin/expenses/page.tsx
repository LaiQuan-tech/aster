"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  PageHeader,
  ErrorText,
  Empty,
  PrimaryButton,
  inputCls,
  labelCls,
} from "@/components/admin-ui";
import {
  getExpenseCategories,
  getExpenseReview,
  getExpenseSettlements,
  settleExpenses,
  upsertExpenseCategory,
  type ExpenseCategory,
  type ExpenseReview,
  type ExpenseSettlement,
} from "@/lib/admin-api";

/** 'YYYY-MM' for today. */
function thisPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function money(n: number): string {
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

export default function AdminExpensesPage() {
  const [period, setPeriod] = useState(thisPeriod);
  const [review, setReview] = useState<ExpenseReview | null>(null);
  const [settlement, setSettlement] = useState<ExpenseSettlement | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rev, sets, cats] = await Promise.all([
        getExpenseReview(period),
        getExpenseSettlements(period),
        getExpenseCategories(),
      ]);
      setReview(rev);
      setSettlement(sets.settlements[0] ?? null);
      setCategories(cats.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
      setReview(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const isSettled = settlement?.status === "settled";
  const issueCount = useMemo(() => {
    if (!review) return 0;
    const i = review.issues;
    return i.missingReceipt.length + i.overCap.length + i.attendanceMismatch.length;
  }, [review]);

  async function onSettle() {
    if (!review) return;
    const warn =
      issueCount > 0
        ? `本期仍有 ${issueCount} 筆待確認項目。核銷後該期即鎖定，不得再增減。\n\n仍要核銷嗎？`
        : "核銷後該期即鎖定，不得再增減。確定核銷？";
    if (!window.confirm(warn)) return;
    const note = window.prompt("核銷備註（可留空）：") ?? undefined;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await settleExpenses(period, note || undefined);
      setMessage(
        `已核銷 ${res.claimCount} 筆：實報實銷 ${money(res.reimbursementTotal)} 元、` +
          `定額補貼 ${money(res.allowanceTotal)} 元`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "核銷失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="日常費用月結"
        desc="同仁線上填報、月結一次性核銷。省的是逐筆事前審核，不是憑證。"
      />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls} htmlFor="period">
              結算期別
            </label>
            <input
              id="period"
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className={inputCls}
            />
          </div>
          <PrimaryButton onClick={() => void load()} disabled={loading}>
            {loading ? "載入中…" : "重新整理"}
          </PrimaryButton>
          <div className="grow" />
          {isSettled ? (
            <span className="rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-600">
              此期已核銷於 {settlement?.settled_at?.slice(0, 10) ?? "—"}，已鎖定
            </span>
          ) : (
            <PrimaryButton onClick={() => void onSettle()} disabled={busy || !review}>
              {busy ? "核銷中…" : "一次性核銷本期"}
            </PrimaryButton>
          )}
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        {message && <p className="mt-3 text-sm text-green-700">{message}</p>}
      </Card>

      {/* 兩種性質分開呈現 —— 這不是排版偏好，是稅務歸屬不同。 */}
      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">本期合計</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-gray-200 p-4">
            <div className="text-xs text-gray-500">待核銷筆數</div>
            <div className="mt-1 text-2xl font-semibold">{review?.claimCount ?? 0}</div>
          </div>
          <div className="rounded-lg border border-gray-200 p-4">
            <div className="text-xs text-gray-500">實報實銷</div>
            <div className="mt-1 text-2xl font-semibold">
              {money(review?.reimbursementTotal ?? 0)}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">
              非所得，不課稅、不計入投保薪資。不進應發，直接加在實發。
            </p>
          </div>
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <div className="text-xs text-amber-800">定額補貼</div>
            <div className="mt-1 text-2xl font-semibold text-amber-900">
              {money(review?.allowanceTotal ?? 0)}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-amber-800">
              <strong>屬薪資所得</strong>，須併入扣繳，且應計入勞健保投保薪資。
              本期有補貼者需覆核是否要重新申報投保級距。
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">
          待確認項目{issueCount > 0 ? `（${issueCount}）` : ""}
        </h2>
        <p className="mb-4 text-xs text-gray-500">
          客戶要的是「不需逐筆事前審核」。這份清單就是讓那一次月結審核有意義的東西。
        </p>

        {!review || issueCount === 0 ? (
          <Empty>本期沒有待確認項目。</Empty>
        ) : (
          <div className="space-y-6">
            {review.issues.missingReceipt.length > 0 && (
              <section>
                <h3 className="text-sm font-medium text-gray-800">
                  缺憑證（{review.issues.missingReceipt.length}）
                </h3>
                <p className="mb-2 text-xs text-gray-500">
                  類別要求憑證卻未附。沒有憑證的給付，國稅局傾向認定為薪資。
                </p>
                <ul className="space-y-1 text-sm">
                  {review.issues.missingReceipt.map((r) => (
                    <li key={r.claimId} className="rounded border border-gray-200 px-3 py-2">
                      員工 <code className="text-xs">{r.employeeId.slice(0, 8)}</code> ·{" "}
                      {money(r.amount)} 元
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {review.issues.overCap.length > 0 && (
              <section>
                <h3 className="text-sm font-medium text-gray-800">
                  超過月限額（{review.issues.overCap.length}）
                </h3>
                <p className="mb-2 text-xs text-gray-500">不擋填報，只標示。</p>
                <ul className="space-y-1 text-sm">
                  {review.issues.overCap.map((r) => (
                    <li
                      key={`${r.employeeId}-${r.categoryId}`}
                      className="rounded border border-gray-200 px-3 py-2"
                    >
                      員工 <code className="text-xs">{r.employeeId.slice(0, 8)}</code> ·
                      合計 {money(r.total)} / 上限 {money(r.cap)}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {review.issues.attendanceMismatch.length > 0 && (
              <section>
                <h3 className="text-sm font-medium text-red-800">
                  報銷與出勤不符（{review.issues.attendanceMismatch.length}）
                </h3>
                <p className="mb-2 text-xs leading-relaxed text-red-700">
                  夜間交通費報銷，但該日沒有對應的加班紀錄。
                  報銷單據在勞檢與訴訟中會被用來證明實際工時 ——
                  出勤顯示準時下班、同日卻有深夜車資，兩份紀錄互相矛盾，
                  而矛盾比單純漏記更難解釋。請確認是補工時還是退件。
                </p>
                <ul className="space-y-1 text-sm">
                  {review.issues.attendanceMismatch.map((r) => (
                    <li
                      key={r.claimId}
                      className="rounded border border-red-200 bg-red-50 px-3 py-2"
                    >
                      {r.incurredOn} · 員工{" "}
                      <code className="text-xs">{r.employeeId.slice(0, 8)}</code> ·{" "}
                      {money(r.amount)} 元
                      <span className="ml-2 text-xs text-red-700">{r.hint}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </Card>

      <CategoryManager categories={categories} onChanged={() => void load()} />
    </>
  );
}

/**
 * 類別目錄。`nature` 是本模組最關鍵的設定：設錯等於漏報薪資所得 ＋ 高薪低報，
 * 故在畫面上把兩種性質的後果直接寫出來，而不是只給一個下拉選單。
 */
function CategoryManager({
  categories,
  onChanged,
}: {
  categories: ExpenseCategory[];
  onChanged: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [nature, setNature] = useState<"reimbursement" | "allowance">("reimbursement");
  const [requiresReceipt, setRequiresReceipt] = useState(true);
  const [crossCheck, setCrossCheck] = useState(false);
  const [cap, setCap] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await upsertExpenseCategory({
        code: code.trim(),
        name: name.trim(),
        nature,
        requiresReceipt,
        crossCheckAttendance: crossCheck,
        monthlyCap: cap.trim() ? Number(cap) : undefined,
      });
      setCode("");
      setName("");
      setCap("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-4 text-sm font-medium text-gray-500">報銷類別</h2>

      {categories.length === 0 ? (
        <Empty>尚未建立任何類別。</Empty>
      ) : (
        <div className="mb-6 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                <th className="py-2">代碼</th>
                <th className="py-2">名稱</th>
                <th className="py-2">稅務性質</th>
                <th className="py-2">憑證</th>
                <th className="py-2">出勤檢核</th>
                <th className="py-2">月限額</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} className="border-b border-gray-100">
                  <td className="py-2">
                    <code className="text-xs">{c.code}</code>
                  </td>
                  <td className="py-2">{c.name}</td>
                  <td className="py-2">
                    {c.nature === "allowance" ? (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                        定額補貼 · 屬薪資所得
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                        實報實銷 · 非所得
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-xs">{c.requires_receipt ? "必附" : "免附"}</td>
                  <td className="py-2 text-xs">{c.cross_check_attendance ? "是" : "—"}</td>
                  <td className="py-2 text-xs">
                    {c.monthly_cap ? money(Number(c.monthly_cap)) : "無上限"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4 border-t border-gray-200 pt-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="cat-code">
              代碼
            </label>
            <input
              id="cat-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              placeholder="night_taxi"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="cat-name">
              名稱
            </label>
            <input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="夜間計程車"
              className={inputCls}
            />
          </div>
        </div>

        <fieldset>
          <legend className={labelCls}>稅務性質</legend>
          <div className="space-y-2">
            <label className="flex items-start gap-2 rounded border border-gray-200 p-3 text-sm">
              <input
                type="radio"
                name="nature"
                checked={nature === "reimbursement"}
                onChange={() => setNature("reimbursement")}
                className="mt-1"
              />
              <span>
                <strong>實報實銷</strong>（有憑證、金額＝實際支出）
                <span className="mt-1 block text-xs text-gray-500">
                  非所得，不課稅、不計入投保薪資。不進應發，直接加在實發。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
              <input
                type="radio"
                name="nature"
                checked={nature === "allowance"}
                onChange={() => setNature("allowance")}
                className="mt-1"
              />
              <span>
                <strong>定額補貼</strong>（每月固定金額，不論實際花費）
                <span className="mt-1 block text-xs text-amber-800">
                  <strong>屬薪資所得</strong>，須併入扣繳，且應計入勞健保投保薪資。
                  設成「實報實銷」等於漏報薪資所得並高薪低報。
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requiresReceipt}
              onChange={(e) => setRequiresReceipt(e.target.checked)}
            />
            需附憑證
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={crossCheck}
              onChange={(e) => setCrossCheck(e.target.checked)}
            />
            與出勤交叉檢核（夜間交通費類）
          </label>
          <div>
            <label className={labelCls} htmlFor="cat-cap">
              月限額（留空＝無上限）
            </label>
            <input
              id="cat-cap"
              type="number"
              min="0"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {error && <ErrorText>{error}</ErrorText>}
        <PrimaryButton type="submit" disabled={busy}>
          {busy ? "儲存中…" : "建立 / 更新類別"}
        </PrimaryButton>
      </form>
    </Card>
  );
}
