"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { MonthPicker } from "@/components/MonthPicker";
import { apiDownload } from "@/lib/api-client";
import { getEmployees, type Employee } from "@/lib/admin-api";
import {
  OT_CHANNELS,
  OT_CHANNEL_LABEL,
  OT_SOURCE_LABEL,
  createOvertimeSettlement,
  getOvertimeSettlements,
  minutesLabel,
  money,
  overtimeSettlementExportPath,
  patchOvertimeSettlement,
  payOvertimeSettlement,
  todayKey,
  type OvertimeChannel,
  type OvertimeSettlement,
} from "@/lib/cash-payouts-api";

/**
 * 加班超額另計（M1，2026-09-22 業主決策 1）。月加班超過上限（預設 40 小時）的分鐘
 * **不進薪資單**——出勤月表核准時自動在這裡開一列草稿，由老闆／HR 另以現金、補休或
 * 併入薪資給付。付款後整列凍結。
 *
 * 預設只看草稿：漏標記付款＝漏付錢，所以清單預設篩掉已付款的列（§3.7 的風險對策）。
 * 端點由 WP1 實作（`routes/overtime-settlements.ts`），這頁照 §3.2 的契約呼叫。
 */

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

const currentPeriod = new Date().toISOString().slice(0, 7);

type StatusFilter = "draft" | "paid" | "all";

export default function OvertimeSettlementsPage() {
  const [period, setPeriod] = useState(currentPeriod);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("draft");
  const [rows, setRows] = useState<OvertimeSettlement[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // 手動補登
  const [manualEmpId, setManualEmpId] = useState("");
  const [manualMinutes, setManualMinutes] = useState("");
  const [manualAmount, setManualAmount] = useState("");
  const [manualChannel, setManualChannel] = useState<OvertimeChannel>("cash");
  const [manualNote, setManualNote] = useState("");

  useEffect(() => {
    getEmployees()
      .then((r) => setEmployees(r.employees))
      .catch(() => setEmployees([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getOvertimeSettlements({
        period,
        ...(statusFilter === "all" ? {} : { status: statusFilter }),
      });
      setRows(res.settlements);
      setError(null);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [period, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const empLabel = useCallback(
    (row: OvertimeSettlement) => {
      const fromApi = row.employee_name
        ? row.emp_no
          ? `${row.emp_no} · ${row.employee_name}`
          : row.employee_name
        : null;
      if (fromApi) return fromApi;
      const e = employees.find((x) => x.id === row.employee_id);
      if (!e) return row.employee_id.slice(0, 8);
      return e.emp_no ? `${e.emp_no} · ${e.name}` : e.name;
    },
    [employees],
  );

  const totals = useMemo(() => {
    const t = { minutes: 0, amount: 0, draft: 0, paid: 0 };
    for (const r of rows) {
      t.minutes += r.minutes ?? 0;
      t.amount += r.amount ?? 0;
      if (r.status === "paid") t.paid += 1;
      else t.draft += 1;
    }
    return t;
  }, [rows]);

  async function onSaveRow(
    row: OvertimeSettlement,
    patch: { amount?: number | null; channel?: OvertimeChannel; note?: string | null },
  ) {
    try {
      const res = await patchOvertimeSettlement(row.id, patch);
      setRows((prev) => prev.map((r) => (r.id === row.id ? res.settlement : r)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
      void load();
    }
  }

  async function onPay(row: OvertimeSettlement, paidOn: string) {
    if (!confirm(`確定標記「${empLabel(row)}」${row.period} 這筆已付款？付款後整列凍結。`)) return;
    setBusy(true);
    try {
      await payOvertimeSettlement(row.id, {
        paidOn,
        channel: (row.channel as OvertimeChannel) ?? "cash",
        amount: row.amount,
      });
      setMsg(`已標記付款：${empLabel(row)}`);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "標記付款失敗");
    } finally {
      setBusy(false);
    }
  }

  async function onManualCreate() {
    if (!manualEmpId || !manualMinutes) return;
    setBusy(true);
    setMsg(null);
    try {
      await createOvertimeSettlement({
        employeeId: manualEmpId,
        period,
        minutes: Number(manualMinutes),
        amount: manualAmount ? Number(manualAmount) : null,
        channel: manualChannel,
        note: manualNote || null,
      });
      setManualEmpId("");
      setManualMinutes("");
      setManualAmount("");
      setManualNote("");
      setMsg("已補登一筆");
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "補登失敗");
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
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>月份</label>
            <MonthPicker value={period} onChange={setPeriod} disabled={busy} />
          </div>
          <div>
            <label className={labelCls}>狀態</label>
            <select
              className={inputCls}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="draft">未付款（草稿）</option>
              <option value="paid">已付款</option>
              <option value="all">全部</option>
            </select>
          </div>
          <PrimaryButton type="button" onClick={() => void load()} disabled={busy}>
            查詢
          </PrimaryButton>
          <button
            type="button"
            onClick={() =>
              apiDownload(overtimeSettlementExportPath(period), `加班超額另計_${period}.xlsx`).catch((e) =>
                setError(e.message),
              )
            }
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            匯出 xlsx
          </button>
          {msg && <span className="text-sm text-green-600">{msg}</span>}
          <Link href="/admin/attendance-sheets" className="ml-auto text-sm text-gray-500 hover:underline">
            超額分鐘從哪來？看出勤月表 →
          </Link>
        </div>

        <p className="mb-4 text-xs text-gray-400">
          月加班超過上限的分鐘不計入薪資單的加班費，核准出勤月表時自動列在這裡。
          逐筆決定給付方式（現金／補休／併入薪資）與金額，付款後整列凍結、不能再改。
        </p>

        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="超額時數合計" value={minutesLabel(totals.minutes)} tone="orange" />
          <Stat label="金額合計" value={money(totals.amount)} tone="emerald" />
          <Stat label="未付款" value={`${totals.draft} 筆`} tone="amber" />
          <Stat label="已付款" value={`${totals.paid} 筆`} tone="slate" />
        </div>

        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>{period} 沒有需要另行給付的加班超額（月表核准後才會產生）</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-3">員工</th>
                  <th className="py-2 pr-3">來源</th>
                  <th className="py-2 pr-3 text-right">超額時數</th>
                  <th className="py-2 pr-3">給付方式</th>
                  <th className="py-2 pr-3 text-right">金額</th>
                  <th className="py-2 pr-3">備註</th>
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <SettlementRow
                    key={r.id}
                    row={r}
                    label={empLabel(r)}
                    busy={busy}
                    onSave={onSaveRow}
                    onPay={onPay}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">手動補登一筆</h2>
        <p className="mb-4 text-xs text-gray-400">
          月表沒抓到、或另有協議要另行給付的加班時數，可以直接補一筆在 {period}。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56">
            <label className={labelCls}>員工</label>
            <select className={inputCls} value={manualEmpId} onChange={(e) => setManualEmpId(e.target.value)}>
              <option value="">請選擇</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.emp_no ? `${e.emp_no} · ${e.name}` : e.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>分鐘</label>
            <input
              type="number"
              min={0}
              className={inputCls}
              value={manualMinutes}
              onChange={(e) => setManualMinutes(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls}>給付方式</label>
            <select
              className={inputCls}
              value={manualChannel}
              onChange={(e) => setManualChannel(e.target.value as OvertimeChannel)}
            >
              {OT_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {OT_CHANNEL_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>金額（選填）</label>
            <input
              type="number"
              className={inputCls}
              value={manualAmount}
              onChange={(e) => setManualAmount(e.target.value)}
            />
          </div>
          <div className="min-w-48">
            <label className={labelCls}>備註</label>
            <input className={inputCls} value={manualNote} onChange={(e) => setManualNote(e.target.value)} />
          </div>
          <PrimaryButton
            type="button"
            onClick={() => void onManualCreate()}
            disabled={busy || !manualEmpId || !manualMinutes}
          >
            補登
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

function SettlementRow({
  row,
  label,
  busy,
  onSave,
  onPay,
}: {
  row: OvertimeSettlement;
  label: string;
  busy: boolean;
  onSave: (
    row: OvertimeSettlement,
    patch: { amount?: number | null; channel?: OvertimeChannel; note?: string | null },
  ) => Promise<void>;
  onPay: (row: OvertimeSettlement, paidOn: string) => Promise<void>;
}) {
  const paid = row.status === "paid";
  const [amount, setAmount] = useState(row.amount === null ? "" : String(row.amount));
  const [note, setNote] = useState(row.note ?? "");
  const [paidOn, setPaidOn] = useState(todayKey());

  useEffect(() => {
    setAmount(row.amount === null ? "" : String(row.amount));
    setNote(row.note ?? "");
  }, [row.amount, row.note]);

  return (
    <tr className="border-b border-gray-50">
      <td className="py-2 pr-3 font-medium text-gray-800">{label}</td>
      <td className="py-2 pr-3 text-xs text-gray-500">{OT_SOURCE_LABEL[row.source] ?? row.source}</td>
      <td className="py-2 pr-3 text-right font-medium text-orange-700">{minutesLabel(row.minutes)}</td>
      <td className="py-2 pr-3">
        {paid ? (
          <span className="text-gray-600">{OT_CHANNEL_LABEL[row.channel as OvertimeChannel] ?? row.channel}</span>
        ) : (
          <select
            value={row.channel}
            onChange={(e) => void onSave(row, { channel: e.target.value as OvertimeChannel })}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-gray-400 focus:outline-none"
          >
            {OT_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {OT_CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className="py-2 pr-3 text-right">
        {paid ? (
          <span className="font-semibold text-emerald-700">{money(row.amount)}</span>
        ) : (
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => {
              const next = amount === "" ? null : Number(amount);
              if (next !== row.amount) void onSave(row, { amount: next });
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
            className="w-40 rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-gray-400 focus:outline-none"
          />
        )}
      </td>
      <td className="py-2 pr-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${paid ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}
        >
          {paid ? `已付款 ${row.paid_on ?? ""}` : "未付款"}
        </span>
      </td>
      <td className="py-2 whitespace-nowrap">
        {!paid && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:border-gray-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void onPay(row, paidOn)}
              disabled={busy}
              className="text-sm font-medium disabled:opacity-50"
              style={{ color: "var(--brand)" }}
            >
              標記付款
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
