"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { apiDownload, apiErrorMessage } from "@/lib/api-client";
import {
  getEmployees,
  getPayslips,
  finalizePayslip,
  type Employee,
  type Payslip,
  type PayslipBreakdown,
} from "@/lib/admin-api";
import {
  sendPayslip,
  sendPayslipsBatch,
  type PayslipSendFields,
} from "@/lib/cash-payouts-api";

/** M3：`sent_at`／`sent_to` 在 migration 0050 之後才有（lib/admin-api.ts 是 WP0 的檔，不改）。 */
type PayslipRow = Payslip & PayslipSendFields;

function fmtSentAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SEND_SKIP_LABEL: Record<string, string> = {
  not_finalized: "尚未定案",
  no_recipient: "沒有 email",
  send_failed: "寄送失敗",
};

/**
 * 薪資明細表（工資清冊）。勞基法 §23 II 要求工資清冊記到「各項目計算方式明細」並
 * 保存五年，所以這頁的重點是**扣項側與實發**（勞健保、勞退自提、預支扣回、代墊）
 * 與逐列明細——薪資作業頁只管薪資結構與執行結算，查詢／列印／定案全在這裡。
 * 扣項來自 payslips.breakdown（引擎 PayslipResult）；沒有 breakdown 的舊資料以 0 呈現。
 */

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

const OT_LABEL: Record<string, string> = {
  weekday_ot: "平日加班",
  rest_day: "休息日",
  fixed_holiday: "國定假日",
};

function n(v: string | number | undefined | null): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}
function money(v: number): string {
  return v.toLocaleString("zh-TW");
}
function bd(p: Payslip): PayslipBreakdown {
  return p.breakdown ?? {};
}
/** 實發：有 breakdown 用引擎算的；沒有就等於應發（舊資料沒扣項）。 */
function netOf(p: Payslip): number {
  const b = bd(p);
  return typeof b.net === "number" ? b.net : n(p.gross);
}

export default function PayslipsPage() {
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const [period, setPeriod] = useState(currentPeriod);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payslips, setPayslips] = useState<PayslipRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  useEffect(() => {
    getEmployees()
      .then((r) => setEmployees(r.employees))
      .catch((err) => setError(err instanceof Error ? err.message : "載入員工失敗"));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await getPayslips(period || undefined);
      setPayslips(res.payslips as PayslipRow[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入薪資單失敗");
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const empName = (id: string) => {
    const e = employees.find((x) => x.id === id);
    if (!e) return id.slice(0, 8);
    return e.emp_no ? `${e.emp_no} · ${e.name}` : e.name;
  };

  const rows = useMemo(
    () => [...payslips].sort((a, b) => empName(a.employee_id).localeCompare(empName(b.employee_id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payslips, employees],
  );

  const totals = useMemo(() => {
    const t = { gross: 0, deductions: 0, expenses: 0, net: 0, draft: 0, finalized: 0, sent: 0 };
    for (const p of payslips) {
      t.gross += n(p.gross);
      t.deductions += n(bd(p).totalDeductions);
      t.expenses += n(bd(p).expenses);
      t.net += netOf(p);
      if (p.status !== "finalized") t.draft += 1;
      else t.finalized += 1;
      if (p.sent_at) t.sent += 1;
    }
    return t;
  }, [payslips]);

  async function finalizeOne(id: string) {
    setBusy(true);
    try {
      await finalizePayslip(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "定案失敗");
    } finally {
      setBusy(false);
    }
  }

  async function finalizeAll() {
    const drafts = payslips.filter((p) => p.status !== "finalized");
    if (drafts.length === 0) return;
    if (!confirm(`確定將 ${period} 的 ${drafts.length} 張草稿全部定案？定案後不可再重算。`)) return;
    setBusy(true);
    try {
      for (const p of drafts) await finalizePayslip(p.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "定案失敗");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 寄送失敗的訊息：優先顯示 API 附的中文說明（例如 409 mail_not_configured 的
   * 「尚未設定 RESEND_API_KEY」），沒有才退回 `[409] mail_not_configured` 這種代碼——
   * 2026-09-23 正式站驗收：HR 只看到代碼、看不懂要去設什麼。
   */
  function describeSendError(err: unknown, fallback: string): string {
    const msg = apiErrorMessage(err, fallback);
    return msg === fallback ? msg : `${fallback}：${msg}`;
  }

  async function sendOne(p: PayslipRow) {
    setBusy(true);
    try {
      await sendPayslip(p.id);
      await load();
      setError(null);
    } catch (err) {
      setError(describeSendError(err, "寄送失敗"));
    } finally {
      setBusy(false);
    }
  }

  /** 批次寄送：只寄已定案的，未寄成功的逐筆列出原因（HR 照清單補）。 */
  async function sendBatch() {
    const finalized = payslips.filter((p) => p.status === "finalized");
    if (finalized.length === 0) return;
    if (!confirm(`確定把 ${period} 的 ${finalized.length} 張已定案薪資單寄給本人？`)) return;
    setBusy(true);
    setSendMsg(null);
    try {
      const res = await sendPayslipsBatch(period);
      const skipped = res.skipped.filter((s) => s.reason !== "not_finalized");
      setSendMsg(
        `已寄出 ${res.sent} 張` +
          (skipped.length > 0
            ? `；未寄出 ${skipped.length} 張（${skipped
                .map((s) => `${empName(s.employeeId)}：${SEND_SKIP_LABEL[s.reason] ?? s.reason}`)
                .join("、")}）`
            : ""),
      );
      await load();
      setError(null);
    } catch (err) {
      setError(describeSendError(err, "批次寄送失敗"));
    } finally {
      setBusy(false);
    }
  }

  function printOne(p: Payslip) {
    const b = bd(p);
    const w = window.open("", "_blank", "width=720,height=960");
    if (!w) return;
    const lines = (b.lines ?? []).map(
      (l) => `<tr><td>${esc(l.label)}</td><td style="text-align:right">${money(l.amount)}</td></tr>`,
    );
    const ot = (b.overtimeSegments ?? []).map(
      (s) =>
        `<tr><td>${esc(OT_LABEL[s.when] ?? s.when)} × ${s.multiplier}</td><td style="text-align:right">${s.hours} 小時</td><td style="text-align:right">${money(s.amount)}</td></tr>`,
    );
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>薪資單 ${p.period}</title>
<style>body{font-family:ui-sans-serif,system-ui,'Noto Sans TC';padding:32px;color:#111;max-width:680px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:20px 0 6px;color:#555}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;font-size:13px;text-align:left}
.sum td{font-weight:600;background:#f7f7f7}.muted{color:#777;font-size:12px}</style></head><body>
<h1>薪資單　${esc(empName(p.employee_id))}</h1>
<div class="muted">期間 ${p.period}　狀態 ${p.status === "finalized" ? "已定案" : "草稿"}　基準時薪 ${money(n(b.hourlyWage))}</div>
<h2>應發</h2><table>
<tr><td>本薪</td><td style="text-align:right">${money(n(p.base))}</td></tr>
<tr><td>加班費</td><td style="text-align:right">${money(n(p.overtime_pay))}</td></tr>
<tr><td>夜間加給</td><td style="text-align:right">${money(n(p.night_pay))}</td></tr>
<tr><td>全勤獎金</td><td style="text-align:right">${money(n(p.attendance_bonus))}</td></tr>
<tr><td>定額補貼</td><td style="text-align:right">${money(n(b.allowances))}</td></tr>
<tr class="sum"><td>應發合計</td><td style="text-align:right">${money(n(p.gross))}</td></tr></table>
<h2>應扣</h2><table>
<tr><td>勞保自付</td><td style="text-align:right">${money(n(b.laborInsurance))}</td></tr>
<tr><td>健保自付</td><td style="text-align:right">${money(n(b.healthInsurance))}</td></tr>
<tr><td>勞退自提</td><td style="text-align:right">${money(n(b.pensionVoluntary))}</td></tr>
<tr><td>預支扣回</td><td style="text-align:right">${money(n(b.advance))}</td></tr>
<tr><td>請假扣款</td><td style="text-align:right">${money(n(b.leaveDeduction))}</td></tr>
<tr><td>遲到早退扣款</td><td style="text-align:right">${money(n(b.lateEarlyDeduction))}</td></tr>
<tr class="sum"><td>應扣合計</td><td style="text-align:right">${money(n(b.totalDeductions))}</td></tr></table>
<h2>實發</h2><table>
<tr><td>代墊支出（不計薪資所得）</td><td style="text-align:right">${money(n(b.expenses))}</td></tr>
<tr class="sum"><td>實發金額</td><td style="text-align:right">${money(netOf(p))}</td></tr></table>
${ot.length ? `<h2>加班費分段</h2><table>${ot.join("")}</table>` : ""}
${lines.length ? `<h2>逐項明細</h2><table>${lines.join("")}</table>` : ""}
<script>window.print()</script></body></html>`);
    w.document.close();
  }

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>期間</label>
            <input type="month" className={inputCls} value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
          <PrimaryButton type="button" onClick={() => void load()}>查詢</PrimaryButton>
          <button
            type="button"
            onClick={() => apiDownload(`/reports/payroll?period=${period}&format=csv`, `工資清冊_${period}.csv`).catch((e) => setError(e.message))}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700"
          >
            匯出工資清冊 CSV
          </button>
          <button
            type="button"
            onClick={() => void finalizeAll()}
            disabled={busy || totals.draft === 0}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            全部定案（{totals.draft}）
          </button>
          <button
            type="button"
            onClick={() => void sendBatch()}
            disabled={busy || totals.finalized === 0}
            title="把本期已定案的薪資單寄到每位同仁的公司信箱（無則個人信箱／登入信箱）"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            批次寄送 Email（{totals.finalized}）
          </button>
          {sendMsg && <span className="text-sm text-gray-600">{sendMsg}</span>}
          <Link href="/admin/payroll" className="ml-auto text-sm text-gray-500 hover:underline">
            沒有本期薪資單？到薪資作業執行結算 →
          </Link>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs text-slate-500">應發合計</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{money(totals.gross)}</p>
          </div>
          <div className="rounded-xl bg-rose-50 p-4">
            <p className="text-xs text-rose-600">應扣合計</p>
            <p className="mt-1 text-xl font-semibold text-rose-700">{money(totals.deductions)}</p>
          </div>
          <div className="rounded-xl bg-emerald-50 p-4">
            <p className="text-xs text-emerald-600">實發合計</p>
            <p className="mt-1 text-xl font-semibold text-emerald-700">{money(totals.net)}</p>
          </div>
          <div className="rounded-xl bg-amber-50 p-4">
            <p className="text-xs text-amber-700">草稿 / 全部</p>
            <p className="mt-1 text-xl font-semibold text-amber-800">{totals.draft} / {payslips.length}</p>
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty>{period} 沒有薪資單</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-3">員工</th>
                  <th className="py-2 pr-3 text-right">時薪</th>
                  <th className="py-2 pr-3 text-right">本薪</th>
                  <th className="py-2 pr-3 text-right">加班費</th>
                  <th className="py-2 pr-3 text-right">夜間</th>
                  <th className="py-2 pr-3 text-right">全勤</th>
                  <th className="py-2 pr-3 text-right">補貼</th>
                  <th className="py-2 pr-3 text-right font-semibold">應發</th>
                  <th className="py-2 pr-3 text-right">勞保</th>
                  <th className="py-2 pr-3 text-right">健保</th>
                  <th className="py-2 pr-3 text-right">勞退自提</th>
                  <th className="py-2 pr-3 text-right">預支</th>
                  <th className="py-2 pr-3 text-right">請假扣款</th>
                  <th className="py-2 pr-3 text-right">遲到早退扣款</th>
                  <th className="py-2 pr-3 text-right">代墊</th>
                  <th className="py-2 pr-3 text-right font-semibold">實發</th>
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2 pr-3">寄送</th>
                  <th className="py-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const b = bd(p);
                  const open = openId === p.id;
                  return (
                    <PayslipRow
                      key={p.id}
                      p={p}
                      b={b}
                      open={open}
                      name={empName(p.employee_id)}
                      busy={busy}
                      onToggle={() => setOpenId(open ? null : p.id)}
                      onPrint={() => printOne(p)}
                      onFinalize={() => void finalizeOne(p.id)}
                      onSend={() => void sendOne(p)}
                    />
                  );
                })}
                <tr className="border-t border-gray-300 bg-gray-50 text-sm font-semibold">
                  <td className="py-2 pr-3">合計（{rows.length} 人）</td>
                  <td className="py-2 pr-3 text-right text-gray-400" title="時薪為個人費率，不加總">—</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(p.base), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(p.overtime_pay), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(p.night_pay), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(p.attendance_bonus), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).allowances), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(totals.gross)}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).laborInsurance), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).healthInsurance), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).pensionVoluntary), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).advance), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).leaveDeduction), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).lateEarlyDeduction), 0))}</td>
                  <td className="py-2 pr-3 text-right">{money(totals.expenses)}</td>
                  <td className="py-2 pr-3 text-right">{money(totals.net)}</td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function PayslipRow({
  p,
  b,
  open,
  name,
  busy,
  onToggle,
  onPrint,
  onFinalize,
  onSend,
}: {
  p: PayslipRow;
  b: PayslipBreakdown;
  open: boolean;
  name: string;
  busy: boolean;
  onToggle: () => void;
  onPrint: () => void;
  onFinalize: () => void;
  onSend: () => void;
}) {
  const lines = b.lines ?? [];
  const ot = b.overtimeSegments ?? [];
  const hasDetail = lines.length > 0 || ot.length > 0;
  return (
    <>
      <tr className="border-b border-gray-50">
        <td className="py-2 pr-3 font-medium text-gray-800">
          {hasDetail ? (
            <button type="button" onClick={onToggle} className="text-left hover:underline" title="展開逐項明細">
              {open ? "▾" : "▸"} {name}
            </button>
          ) : (
            name
          )}
        </td>
        <td className="py-2 pr-3 text-right text-gray-500">{money(n(b.hourlyWage))}</td>
        <td className="py-2 pr-3 text-right">{money(n(p.base))}</td>
        <td className="py-2 pr-3 text-right">{money(n(p.overtime_pay))}</td>
        <td className="py-2 pr-3 text-right">{money(n(p.night_pay))}</td>
        <td className="py-2 pr-3 text-right">{money(n(p.attendance_bonus))}</td>
        <td className="py-2 pr-3 text-right">{money(n(b.allowances))}</td>
        <td className="py-2 pr-3 text-right font-medium">{money(n(p.gross))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.laborInsurance))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.healthInsurance))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.pensionVoluntary))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.advance))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.leaveDeduction))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.lateEarlyDeduction))}</td>
        <td className="py-2 pr-3 text-right">{money(n(b.expenses))}</td>
        <td className="py-2 pr-3 text-right font-semibold text-emerald-700">{money(netOf(p))}</td>
        <td className="py-2 pr-3">
          <span className={`rounded-full px-2 py-0.5 text-xs ${p.status === "finalized" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
            {p.status === "finalized" ? "已定案" : "草稿"}
          </span>
        </td>
        <td className="py-2 pr-3 whitespace-nowrap text-xs">
          {p.sent_at ? (
            <span className="text-emerald-700" title={p.sent_to ?? undefined}>
              已寄送 {fmtSentAt(p.sent_at)}
            </span>
          ) : (
            <span className="text-gray-400">未寄送</span>
          )}
        </td>
        <td className="py-2 whitespace-nowrap">
          <button type="button" onClick={onPrint} className="mr-3 text-sm text-gray-600 hover:underline">
            列印
          </button>
          {p.status === "finalized" && (
            <button
              type="button"
              onClick={onSend}
              disabled={busy}
              title={p.sent_at ? "再寄一次（會覆蓋寄送時間）" : "寄到本人信箱"}
              className="mr-3 text-sm text-gray-600 hover:underline disabled:opacity-50"
            >
              {p.sent_at ? "重寄" : "寄送"}
            </button>
          )}
          {p.status !== "finalized" && (
            <button type="button" onClick={onFinalize} disabled={busy} className="text-sm font-medium disabled:opacity-50" style={{ color: "var(--brand)" }}>
              定案
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-gray-100 bg-gray-50/60">
          <td colSpan={19} className="px-4 py-3">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {ot.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold text-gray-500">加班費分段</p>
                  <table className="w-full text-xs">
                    <tbody>
                      {ot.map((s, i) => (
                        <tr key={i}>
                          <td className="py-0.5 pr-3 text-gray-700">{OT_LABEL[s.when] ?? s.when} × {s.multiplier}</td>
                          <td className="py-0.5 pr-3 text-right text-gray-500">{s.hours} 小時</td>
                          <td className="py-0.5 text-right">{money(s.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {lines.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold text-gray-500">逐項明細（正加項、負扣項）</p>
                  <table className="w-full text-xs">
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={i}>
                          <td className="py-0.5 pr-3 text-gray-700">{l.label}</td>
                          <td className={`py-0.5 text-right ${l.amount < 0 ? "text-rose-700" : ""}`}>{money(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
