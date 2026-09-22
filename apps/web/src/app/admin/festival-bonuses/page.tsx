"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { apiDownload } from "@/lib/api-client";
import {
  FESTIVALS,
  FESTIVAL_LABEL,
  festivalBonusExportPath,
  getFestivalBonuses,
  patchFestivalBonus,
  payFestivalBonuses,
  prepareFestivalBonuses,
  money,
  todayKey,
  type Festival,
  type FestivalBonus,
} from "@/lib/cash-payouts-api";

/**
 * 三節／節慶獎金（M6）。客戶的流程是「去年給多少先帶出來 → 到職未滿一年按月折算 →
 * 老闆逐人加減 → 一次發放」，這頁就照這個順序排：
 *   ① 上方產生器：節日／年度／折算基準日／基準金額 → 產生（可重複按，已發放的列不動）
 *   ② 中間表格：逐人改「實發金額」與備註（只有草稿可改，離開輸入框即存）
 *   ③ 下方發放：填發放日 → 一次把全部草稿轉已發放並凍結（之後不能改）
 *
 * 金額不進薪資單（現金給付），所以這頁與「加班超額另計」一樣只有老闆與 HR 看得到。
 */

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

const currentYear = new Date().getFullYear();

export default function FestivalBonusesPage() {
  const [festival, setFestival] = useState<Festival>("mid_autumn");
  const [year, setYear] = useState(currentYear);
  const [referenceDate, setReferenceDate] = useState(todayKey());
  const [baseAmount, setBaseAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayKey());

  const [rows, setRows] = useState<FestivalBonus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getFestivalBonuses(festival, year);
      setRows(res.bonuses);
      setError(null);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [festival, year]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const t = { suggested: 0, final: 0, draft: 0, paid: 0, prorated: 0 };
    for (const r of rows) {
      t.suggested += r.suggested_amount ?? 0;
      t.final += r.final_amount ?? r.suggested_amount ?? 0;
      if (r.status === "paid") t.paid += 1;
      else t.draft += 1;
      if (r.prorate_months !== null && r.prorate_months < 12) t.prorated += 1;
    }
    return t;
  }, [rows]);

  async function onPrepare() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await prepareFestivalBonuses({
        festival,
        year,
        referenceDate,
        ...(baseAmount ? { baseAmount: Number(baseAmount) } : {}),
      });
      setRows(res.bonuses);
      setError(null);
      setMsg(
        `已產生：新增 ${res.created} 人、更新 ${res.updated} 人` +
          (res.skipped.length > 0 ? `，略過已發放 ${res.skipped.length} 人` : ""),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "產生失敗");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveRow(row: FestivalBonus, patch: { finalAmount?: number | null; note?: string | null }) {
    try {
      const res = await patchFestivalBonus(row.id, patch);
      setRows((prev) => prev.map((r) => (r.id === row.id ? res.bonus : r)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
      void load(); // 失敗就把畫面拉回伺服器的真實狀態
    }
  }

  async function onPay() {
    if (totals.draft === 0) return;
    if (
      !confirm(
        `確定發放 ${year} ${FESTIVAL_LABEL[festival]} 獎金？共 ${totals.draft} 人、合計 ${money(totals.final)} 元。\n發放後整批凍結，不能再修改。`,
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await payFestivalBonuses({ festival, year, paidOn });
      setRows(res.bonuses);
      setError(null);
      setMsg(`已發放 ${res.paid} 人（發放日 ${res.paidOn}），本批已凍結`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "發放失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <div className="mb-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">產生建議金額</h2>
        <p className="mb-4 text-xs text-gray-400">
          建議金額＝去年同一個節日的實發金額（有就優先）否則基準金額；到職未滿一年者按「到職日至折算基準日的整月數 ÷ 12」折算。
          已發放的人不會被覆蓋。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>節日</label>
            <select
              className={inputCls}
              value={festival}
              onChange={(e) => setFestival(e.target.value as Festival)}
            >
              {FESTIVALS.map((f) => (
                <option key={f} value={f}>
                  {FESTIVAL_LABEL[f]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>年度</label>
            <input
              type="number"
              className={inputCls}
              value={year}
              onChange={(e) => setYear(Number(e.target.value) || currentYear)}
            />
          </div>
          <div>
            <label className={labelCls}>折算基準日</label>
            <input
              type="date"
              className={inputCls}
              value={referenceDate}
              onChange={(e) => setReferenceDate(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>基準金額（每人）</label>
            <input
              type="number"
              className={inputCls}
              value={baseAmount}
              placeholder="例 10000"
              onChange={(e) => setBaseAmount(e.target.value)}
            />
          </div>
          <PrimaryButton type="button" onClick={() => void onPrepare()} disabled={busy}>
            產生
          </PrimaryButton>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            重新整理
          </button>
          <button
            type="button"
            onClick={() =>
              apiDownload(
                festivalBonusExportPath(festival, year),
                `三節獎金_${year}_${FESTIVAL_LABEL[festival]}.xlsx`,
              ).catch((e) => setError(e.message))
            }
            disabled={rows.length === 0}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            匯出 xlsx
          </button>
          {msg && <span className="text-sm text-green-600">{msg}</span>}
        </div>
      </Card>

      <Card>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="建議合計" value={money(totals.suggested)} tone="slate" />
          <Stat label="實發合計" value={money(totals.final)} tone="emerald" />
          <Stat label="草稿 / 全部" value={`${totals.draft} / ${rows.length}`} tone="amber" />
          <Stat label="折算（未滿一年）" value={`${totals.prorated} 人`} tone="orange" />
        </div>

        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>
            {year} {FESTIVAL_LABEL[festival]} 還沒有資料——填好上面的基準金額後按「產生」。
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-3">員工</th>
                  <th className="py-2 pr-3">到職日</th>
                  <th className="py-2 pr-3 text-right">折算月數</th>
                  <th className="py-2 pr-3 text-right">建議金額</th>
                  <th className="py-2 pr-3 text-right">實發金額</th>
                  <th className="py-2 pr-3">備註</th>
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2">發放日</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <BonusRow key={r.id} row={r} onSave={onSaveRow} />
                ))}
                <tr className="border-t border-gray-300 bg-gray-50 text-sm font-semibold">
                  <td className="py-2 pr-3" colSpan={3}>
                    合計（{rows.length} 人）
                  </td>
                  <td className="py-2 pr-3 text-right">{money(totals.suggested)}</td>
                  <td className="py-2 pr-3 text-right">{money(totals.final)}</td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">發放</h2>
        <p className="mb-4 text-xs text-gray-400">
          一次把本節本年度所有「草稿」轉成「已發放」並凍結；凍結之後金額與備註都不能再改（資料庫層也會擋）。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>發放日</label>
            <input type="date" className={inputCls} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          </div>
          <PrimaryButton type="button" onClick={() => void onPay()} disabled={busy || totals.draft === 0}>
            發放並凍結（{totals.draft} 人）
          </PrimaryButton>
        </div>
      </Card>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "slate" | "emerald" | "amber" | "orange" }) {
  const cls = {
    slate: ["bg-slate-50", "text-slate-500", "text-slate-900"],
    emerald: ["bg-emerald-50", "text-emerald-600", "text-emerald-700"],
    amber: ["bg-amber-50", "text-amber-700", "text-amber-800"],
    orange: ["bg-orange-50", "text-orange-600", "text-orange-700"],
  }[tone];
  return (
    <div className={`rounded-xl p-4 ${cls[0]}`}>
      <p className={`text-xs ${cls[1]}`}>{label}</p>
      <p className={`mt-1 text-xl font-semibold ${cls[2]}`}>{value}</p>
    </div>
  );
}

function BonusRow({
  row,
  onSave,
}: {
  row: FestivalBonus;
  onSave: (row: FestivalBonus, patch: { finalAmount?: number | null; note?: string | null }) => Promise<void>;
}) {
  const paid = row.status === "paid";
  const [finalAmount, setFinalAmount] = useState(row.final_amount === null ? "" : String(row.final_amount));
  const [note, setNote] = useState(row.note ?? "");

  // 伺服器回來的新值（例如重新產生後）要蓋掉尚未編輯的本地狀態。
  useEffect(() => {
    setFinalAmount(row.final_amount === null ? "" : String(row.final_amount));
    setNote(row.note ?? "");
  }, [row.final_amount, row.note]);

  const name = row.employee_name ?? row.employee_id.slice(0, 8);
  const label = row.emp_no ? `${row.emp_no} · ${name}` : name;

  return (
    <tr className="border-b border-gray-50">
      <td className="py-2 pr-3 font-medium text-gray-800">{label}</td>
      <td className="py-2 pr-3 text-gray-500">{row.hire_date ?? "—"}</td>
      <td className="py-2 pr-3 text-right">
        {row.prorate_months === null ? (
          "—"
        ) : row.prorate_months < 12 ? (
          <span className="font-medium text-orange-600" title="到職未滿一年，按整月數折算">
            {row.prorate_months} / 12
          </span>
        ) : (
          <span className="text-gray-500">12 / 12</span>
        )}
      </td>
      <td className="py-2 pr-3 text-right text-gray-500">{money(row.suggested_amount)}</td>
      <td className="py-2 pr-3 text-right">
        {paid ? (
          <span className="font-semibold text-emerald-700">{money(row.final_amount)}</span>
        ) : (
          <input
            type="number"
            value={finalAmount}
            onChange={(e) => setFinalAmount(e.target.value)}
            onBlur={() => {
              const next = finalAmount === "" ? null : Number(finalAmount);
              if (next !== row.final_amount) void onSave(row, { finalAmount: next });
            }}
            className="w-28 rounded-md border border-gray-300 px-2 py-1 text-right text-sm focus:border-gray-400 focus:outline-none"
          />
        )}
      </td>
      <td className="py-2 pr-3">
        {paid ? (
          <span className="text-gray-500">{row.note ?? "—"}</span>
        ) : (
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              if (note !== (row.note ?? "")) void onSave(row, { note: note || null });
            }}
            placeholder="加減事由"
            className="w-44 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-gray-400 focus:outline-none"
          />
        )}
      </td>
      <td className="py-2 pr-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${paid ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}
        >
          {paid ? "已發放" : "草稿"}
        </span>
      </td>
      <td className="py-2 text-gray-500">{row.paid_on ?? "—"}</td>
    </tr>
  );
}
