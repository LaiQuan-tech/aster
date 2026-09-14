"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, PageHeader, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getStampDutyReport,
  getProjectSettings,
  updateProjectSettings,
  DOC_TYPE_LABELS,
  OUR_ROLE_SHORT_LABELS,
  type StampDutyItem,
  type StampDutySummary,
} from "@/lib/projects-api";

function fmt(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

/**
 * 印花稅計算與申報備查清單（模組四第 3 條）。
 *
 * 清單真正的用途是「哪些該貼而還沒貼」，所以未貼花那一格放在最顯眼處，
 * 而「缺金額 / 缺簽訂日」另外計數——那些算不出稅額，併進「未貼 0 元」
 * 會看起來像沒事。
 */
export default function StampDutyPage() {
  const [items, setItems] = useState<StampDutyItem[]>([]);
  const [summary, setSummary] = useState<StampDutySummary | null>(null);
  const [range, setRange] = useState<{ from: string; to: string; lookbackYears: number } | null>(null);
  const [disclaimer, setDisclaimer] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [lookback, setLookback] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, st] = await Promise.all([
        getStampDutyReport({ from: from || undefined, to: to || undefined, unpaidOnly }),
        getProjectSettings(),
      ]);
      setItems(r.items);
      setSummary(r.summary);
      setRange(r.range);
      setDisclaimer(r.disclaimer);
      setLookback(st.settings.stampDutyLookbackYears);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [from, to, unpaidOnly]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveLookback(years: number) {
    setError(null);
    try {
      const res = await updateProjectSettings({ stampDutyLookbackYears: years });
      setLookback(res.settings.stampDutyLookbackYears);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  return (
    <>
      <PageHeader
        title="印花稅計算與申報備查清單"
        desc="凡我方為承攬人或雙重身分（各自貼）且已簽訂的合約與追加減帳，自動納入本清單。報價單不是契據，不課印花稅。"
      />

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className={labelCls}>起（簽訂日）</label>
            <input className={inputCls} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>迄</label>
            <input className={inputCls} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>回溯年數</label>
            <select
              className={inputCls}
              value={lookback ?? 7}
              onChange={(e) => saveLookback(Number(e.target.value))}
            >
              <option value={5}>5 年（已依規定申報）</option>
              <option value={7}>7 年（未申報／建議）</option>
            </select>
            <p className="mt-1 text-xs text-gray-400">
              稅捐稽徵法 §21：未申報的核課期間是 7 年。沒貼過花就是未申報。
            </p>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-1.5 pb-2 text-sm text-gray-600">
              <input type="checkbox" checked={unpaidOnly} onChange={(e) => setUnpaidOnly(e.target.checked)} />
              只看我方應貼未貼
            </label>
          </div>
        </div>
        {range && (
          <p className="mt-2 text-xs text-gray-400">
            目前區間 {range.from} ～ {range.to}（預設回溯 {range.lookbackYears} 年）
          </p>
        )}
        <ErrorText>{error}</ErrorText>
      </Card>

      {summary && (
        <Card>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <p className="text-xs text-gray-500">應貼花</p>
              <p className="text-xl font-semibold text-gray-900">{summary.dutiableCount} 件</p>
              <p className="text-sm text-gray-500">{fmt(summary.dutiableTotal)} 元</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">已貼花</p>
              <p className="text-xl font-semibold text-green-700">{summary.paidCount} 件</p>
              <p className="text-sm text-gray-500">{fmt(summary.paidTotal)} 元</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">未貼花</p>
              <p className="text-xl font-semibold text-red-600">{summary.unpaidCount} 件</p>
              <p className="text-sm text-gray-500">{fmt(summary.unpaidTotal)} 元</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">資料不全</p>
              <p className="text-xl font-semibold text-amber-600">
                {summary.missingAmountCount + summary.missingSignedOn} 件
              </p>
              <p className="text-sm text-gray-500">
                缺金額 {summary.missingAmountCount}／缺簽訂日 {summary.missingSignedOn}
              </p>
            </div>
          </div>
          {(summary.missingAmountCount > 0 || summary.missingSignedOn > 0) && (
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              有應貼花的文件缺金額或缺簽訂日，算不出稅額，也不會出現在上面的未貼花金額裡。
              缺簽訂日的更不會落在任何區間查詢中——請到各專案補齊。
            </p>
          )}
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">明細</h2>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : items.length === 0 ? (
          <Empty>此區間沒有資料</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-2 pr-3">簽訂日</th>
                  <th className="py-2 pr-3">專案</th>
                  <th className="py-2 pr-3">類型</th>
                  <th className="py-2 pr-3">貼花方式</th>
                  <th className="py-2 pr-3">文件</th>
                  <th className="py-2 pr-3">對方</th>
                  <th className="py-2 pr-3 text-right">金額</th>
                  <th className="py-2 pr-3 text-right">份數</th>
                  <th className="py-2 pr-3 text-right">稅額</th>
                  <th className="py-2 pr-3">狀態</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 text-gray-600">{i.signedOn ?? "—"}</td>
                    <td className="py-2 pr-3">
                      <Link href={`/admin/projects/${i.projectId}`} className="font-medium" style={{ color: "var(--brand)" }}>
                        {i.projectCode ?? i.projectName ?? "—"}
                      </Link>
                    </td>
                    <td className="py-2 pr-3 text-gray-600">{DOC_TYPE_LABELS[i.docType]}</td>
                    <td className="py-2 pr-3 text-gray-600" title={i.stampDutyNote ?? undefined}>
                      {OUR_ROLE_SHORT_LABELS[i.ourRole]}
                      {i.stampDutyNote ? <span className="ml-1 text-gray-300">•</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-gray-900">{i.title}</td>
                    <td className="py-2 pr-3 text-gray-600">{i.counterparty ?? "—"}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">{fmt(i.amount)}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">{i.copies}</td>
                    <td className="py-2 pr-3 text-right text-gray-600">
                      {!i.dutiable ? "—" : i.amount == null ? <span className="text-amber-600">缺金額</span> : fmt(i.stampDutyAmount)}
                    </td>
                    <td className="py-2 pr-3">
                      {!i.dutiable ? (
                        <span className="text-xs text-gray-400">不課</span>
                      ) : i.stampDutyPaidOn ? (
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                          已貼 {i.stampDutyPaidOn}
                        </span>
                      ) : (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">未貼</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {disclaimer && <p className="mt-3 text-xs text-gray-400">{disclaimer}</p>}
      </Card>
    </>
  );
}
