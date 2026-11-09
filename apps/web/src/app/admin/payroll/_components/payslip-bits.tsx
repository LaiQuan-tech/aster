"use client";

/**
 * 薪資單（工資清冊）共用零件（2026-11-09 自原 /admin/payslips 頁搬來；「薪資單」併入「月結發薪」/admin/payroll）。
 * 勞基法 §23 II 要求工資清冊記到「各項目計算方式明細」並保存五年：扣項側與實發（勞健保、勞退自提、預支扣回、代墊）
 * 與逐列明細都在這裡。扣項來自 payslips.breakdown（引擎 PayslipResult）；沒有 breakdown 的舊資料以 0 呈現。
 * 後端 Email 版（apps/api/src/services/payslip-html.ts）與這裡的 printPayslip 欄位一致。
 */
import { useState } from "react";
import type { Payslip, PayslipBreakdown } from "@/lib/admin-api";
import type { PayslipSendFields } from "@/lib/cash-payouts-api";
import { adjustmentDisplayOf, adjustmentPrintRows, signedMoney, TREATMENT_LABEL } from "@/lib/payroll-adjustments-api";
import {
  hourlyRateText,
  fixedAllowanceDisplayOf,
  laborCostOf,
  pensionRatePct,
  type BreakdownAllowanceFields,
} from "@/lib/fixed-allowances-api";

/** M3：`sent_at`／`sent_to` 在 migration 0050 之後才有（lib/admin-api.ts 是 WP0 的檔，不改）。 */
export type PayslipRow = Payslip & PayslipSendFields & {
  /** 2026-11-08：草稿內嵌的固定津貼跟現在不一致（API 只對 HR 的草稿標）；要重新執行薪資作業才能定案。 */
  fixed_allowances_stale?: boolean;
  /** 草稿算的時候用的勞退設定（手填提繳工資、適用新制）跟現在不一致。 */
  pension_settings_stale?: boolean;
};

export function fmtSentAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const SEND_SKIP_LABEL: Record<string, string> = {
  not_finalized: "尚未定案",
  no_recipient: "沒有 email",
  send_failed: "寄送失敗",
};

export const OT_LABEL: Record<string, string> = {
  weekday_ot: "平日加班",
  rest_day: "休息日",
  regular_leave: "例假",
  fixed_holiday: "國定假日",
};

export function n(v: string | number | undefined | null): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}
export function money(v: number): string {
  return v.toLocaleString("zh-TW");
}
/** breakdown ＋ 2026-11-08 固定津貼／公司負擔欄位（舊薪資單沒有，一律以 0／不顯示呈現）。 */
export type Breakdown = PayslipBreakdown & BreakdownAllowanceFields;
export function bd(p: Payslip): Breakdown {
  return (p.breakdown ?? {}) as Breakdown;
}
/** 實發：有 breakdown 用引擎算的；沒有就等於應發（舊資料沒扣項）。 */
export function netOf(p: Payslip): number {
  const b = bd(p);
  return typeof b.net === "number" ? b.net : n(p.gross);
}


export interface PayslipTotals {
  gross: number;
  deductions: number;
  expenses: number;
  net: number;
  employerPension: number;
  laborCost: number;
  draft: number;
  finalized: number;
  sent: number;
}

/** 合計卡（應發／應扣／實發／雇主勞退／人事成本／草稿與張數）。 */
export function payslipTotalsOf(payslips: readonly PayslipRow[]): PayslipTotals {
  const t: PayslipTotals = { gross: 0, deductions: 0, expenses: 0, net: 0, employerPension: 0, laborCost: 0, draft: 0, finalized: 0, sent: 0 };
  for (const p of payslips) {
    t.gross += n(p.gross);
    t.employerPension += n(bd(p).employerPension);
    t.laborCost += laborCostOf(n(p.gross), bd(p));
    t.deductions += n(bd(p).totalDeductions);
    t.expenses += n(bd(p).expenses);
    t.net += netOf(p);
    if (p.status !== "finalized") t.draft += 1;
    else t.finalized += 1;
    if (p.sent_at) t.sent += 1;
  }
  return t;
}

export function printPayslip(p: Payslip, name: string) {
  const b = bd(p);
  const w = window.open("", "_blank", "width=720,height=960");
  if (!w) return;
  const lines = (b.lines ?? []).map(
    (l) => `<tr><td>${esc(l.label)}</td><td style="text-align:right">${money(l.amount)}</td></tr>`,
  );
  const fixed = fixedAllowanceDisplayOf(b);
  const fixedTaxableRows = fixed
    .filter((f) => f.taxableAmount > 0)
    .map((f) => `<tr><td>${esc(f.taxFreeAmount > 0 ? `${f.name}(超過免稅額)` : f.name)}</td><td style="text-align:right">${money(f.taxableAmount)}</td></tr>`)
    .join("");
  const fixedTaxFreeRows = fixed
    .filter((f) => f.taxFreeAmount > 0)
    .map((f) => `<tr><td>${esc(f.name)}(免稅)</td><td style="text-align:right">${money(f.taxFreeAmount)}</td></tr>`)
    .join("");
  const employerSection =
    typeof b.employerPension === "number"
      ? `<h2>公司負擔（不從實發扣除）</h2><table>
<tr><td>雇主勞退提撥（月提繳工資 ${money(n(b.pensionWage))} × ${pensionRatePct(b.employerPensionRate)}）</td><td style="text-align:right">${money(b.employerPension)}</td></tr>
<tr class="sum"><td>公司負擔合計</td><td style="text-align:right">${money(b.employerPension)}</td></tr></table>`
      : "";
  const ot = (b.overtimeSegments ?? []).map(
    (s) =>
      `<tr><td>${esc(OT_LABEL[s.when] ?? s.when)} × ${s.multiplier}</td><td style="text-align:right">${s.hours} 小時</td><td style="text-align:right">${money(s.amount)}</td></tr>`,
  );
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>薪資單 ${p.period}</title>
<style>body{font-family:ui-sans-serif,system-ui,'Noto Sans TC';padding:32px;color:#111;max-width:680px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:20px 0 6px;color:#555}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;font-size:13px;text-align:left}
.sum td{font-weight:600;background:#f7f7f7}.muted{color:#777;font-size:12px}</style></head><body>
<h1>薪資單　${esc(name)}</h1>
<div class="muted">期間 ${p.period}　狀態 ${p.status === "finalized" ? "已定案" : "草稿"}　基準時薪 ${hourlyRateText(n(b.hourlyWage))}${typeof b.overtimeHourlyBase === "number" ? `　加班時薪基數 ${hourlyRateText(b.overtimeHourlyBase)}（含固定津貼）` : ""}</div>
<h2>應發</h2><table>
<tr><td>本薪</td><td style="text-align:right">${money(n(p.base))}</td></tr>
<tr><td>加班費</td><td style="text-align:right">${money(n(p.overtime_pay))}</td></tr>
<tr><td>夜間加給</td><td style="text-align:right">${money(n(p.night_pay))}</td></tr>
<tr><td>全勤獎金</td><td style="text-align:right">${money(n(p.attendance_bonus))}</td></tr>
<tr><td>定額補貼</td><td style="text-align:right">${money(n(b.allowances))}</td></tr>
${fixedTaxableRows}
${adjustmentPrintRows(b, "earning", { money, esc })}
<tr class="sum"><td>應發合計</td><td style="text-align:right">${money(n(p.gross))}</td></tr></table>
<h2>應扣</h2><table>
<tr><td>勞保自付</td><td style="text-align:right">${money(n(b.laborInsurance))}</td></tr>
<tr><td>健保自付</td><td style="text-align:right">${money(n(b.healthInsurance))}</td></tr>
<tr><td>勞退自提</td><td style="text-align:right">${money(n(b.pensionVoluntary))}</td></tr>
<tr><td>預支扣回</td><td style="text-align:right">${money(n(b.advance))}</td></tr>
<tr><td>請假扣款</td><td style="text-align:right">${money(n(b.leaveDeduction))}</td></tr>
<tr><td>遲到早退扣款</td><td style="text-align:right">${money(n(b.lateEarlyDeduction))}</td></tr>
${adjustmentPrintRows(b, "deduction", { money, esc })}
<tr class="sum"><td>應扣合計</td><td style="text-align:right">${money(n(b.totalDeductions))}</td></tr></table>
<h2>實發</h2><table>
<tr><td>代墊支出（不計薪資所得）</td><td style="text-align:right">${money(n(b.expenses))}</td></tr>
${adjustmentPrintRows(b, "non_taxable", { money, esc })}
${fixedTaxFreeRows}
<tr class="sum"><td>實發金額</td><td style="text-align:right">${money(netOf(p))}</td></tr></table>
${employerSection}
${ot.length ? `<h2>加班費分段</h2><table>${ot.join("")}</table>` : ""}
${lines.length ? `<h2>逐項明細</h2><table>${lines.join("")}</table>` : ""}
<script>window.print()</script></body></html>`);
  w.document.close();
}


export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 薪資單逐項明細（加班費分段、加減項、固定津貼、公司負擔、逐項明細）；工資清冊展開列與月結發薪頁的員工明細共用。 */
export function PayslipDetailGrid({ b }: { b: Breakdown }) {
  const lines = b.lines ?? [];
  const ot = b.overtimeSegments ?? [];
  const adjustments = adjustmentDisplayOf(b);
  const fixed = fixedAllowanceDisplayOf(b);
  const hasEmployer = typeof b.employerPension === "number";
  if (lines.length === 0 && ot.length === 0 && adjustments.all.length === 0 && fixed.length === 0 && !hasEmployer) {
    return <p className="text-xs text-gray-400">沒有逐項明細（舊資料）</p>;
  }
  return (
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
      {adjustments.all.length > 0 && (
        <div data-testid="payslip-adjustments-block">
          <p className="mb-1 text-xs font-semibold text-gray-500">加減項（前期更正）</p>
          <table className="w-full text-xs">
            <tbody>
              {adjustments.all.map((a, i) => (
                <tr key={a.id ?? i}>
                  <td className="py-0.5 pr-3 text-gray-700">{a.label}</td>
                  <td className="py-0.5 pr-3 text-gray-400">{TREATMENT_LABEL[a.treatment]}</td>
                  <td className={`py-0.5 text-right ${a.signed < 0 ? "text-rose-700" : ""}`}>{signedMoney(a.signed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fixed.length > 0 && (
        <div data-testid="payslip-fixed-allowances-block">
          <p className="mb-1 text-xs font-semibold text-gray-500">固定津貼</p>
          <table className="w-full text-xs">
            <tbody>
              {fixed.map((f) => (
                <tr key={f.key}>
                  <td className="py-0.5 pr-3 text-gray-700">{f.name}</td>
                  <td className="py-0.5 pr-3 text-gray-400">{f.taxNote}</td>
                  <td className="py-0.5 text-right">{money(f.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasEmployer && (
        <div data-testid="payslip-employer-block">
          <p className="mb-1 text-xs font-semibold text-gray-500">公司負擔（不從實發扣除）</p>
          <table className="w-full text-xs">
            <tbody>
              <tr>
                <td className="py-0.5 pr-3 text-gray-700">
                  雇主勞退提撥（月提繳工資 {money(n(b.pensionWage))} × {pensionRatePct(b.employerPensionRate)}）
                </td>
                <td className="py-0.5 text-right text-violet-700">{money(n(b.employerPension))}</td>
              </tr>
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
  );
}

export function PayslipLedgerRow({
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
  b: Breakdown;
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
  // 一次性加減項（前期更正）：薪資單逐項列出，標「(更正 YYYY-MM)」；舊薪資單沒有。
  const adjustments = adjustmentDisplayOf(b);
  const fixed = fixedAllowanceDisplayOf(b);
  const hasEmployer = typeof b.employerPension === "number";
  const hasDetail = lines.length > 0 || ot.length > 0 || adjustments.all.length > 0 || fixed.length > 0 || hasEmployer;
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
          {adjustments.all.length > 0 && (
            <span
              className="ml-2 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-normal text-sky-700"
              title="含一次性加減項（前期更正）：展開看逐項明細；應發／應扣／實發都已包含"
              data-testid="payslip-has-adjustments"
            >
              含更正 {adjustments.all.length} 筆
            </span>
          )}
          {p.status !== "finalized" && p.pension_settings_stale && (
            <span
              className="ml-2 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-normal text-rose-700"
              title="勞退月提繳工資或「適用勞退新制」在執行薪資之後有異動：請重新執行本月薪資（月結發薪頁的「重算此人」或「執行薪資（全部）」），否則無法定案"
              data-testid="payslip-pension-settings-stale"
            >
              勞退設定有異動，需重新執行
            </span>
          )}
          {p.status !== "finalized" && p.fixed_allowances_stale && (
            <span
              className="ml-2 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-normal text-rose-700"
              title="固定津貼在執行薪資之後有異動：請重新執行本月薪資（月結發薪頁的「重算此人」或「執行薪資（全部）」），否則無法定案"
              data-testid="payslip-fixed-allowances-stale"
            >
              固定津貼有異動，需重新執行
            </span>
          )}
        </td>
        <td
          className="py-2 pr-3 text-right text-gray-500"
          title={typeof b.overtimeHourlyBase === "number" ? `加班時薪基數（含計入的固定津貼）；基準時薪 ${hourlyRateText(n(b.hourlyWage))} 用於請假扣款` : undefined}
        >
          {hourlyRateText(n(b.overtimeHourlyBase ?? b.hourlyWage))}
          {typeof b.overtimeHourlyBase === "number" && <span className="ml-1 text-[10px] text-sky-600">加班</span>}
        </td>
        <td className="py-2 pr-3 text-right">{money(n(p.base))}</td>
        <td className="py-2 pr-3 text-right">{money(n(p.overtime_pay))}</td>
        <td className="py-2 pr-3 text-right">{money(n(p.night_pay))}</td>
        <td className="py-2 pr-3 text-right">{money(n(p.attendance_bonus))}</td>
        <td className="py-2 pr-3 text-right">{money(n(b.allowances))}</td>
        <td className="py-2 pr-3 text-right">{money(n(b.fixedAllowancesTaxable))}</td>
        <td className="py-2 pr-3 text-right font-medium">{money(n(p.gross))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.laborInsurance))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.healthInsurance))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.pensionVoluntary))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.advance))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.leaveDeduction))}</td>
        <td className="py-2 pr-3 text-right text-rose-700">{money(n(b.lateEarlyDeduction))}</td>
        <td className="py-2 pr-3 text-right">{money(n(b.expenses))}</td>
        <td className="py-2 pr-3 text-right">{money(n(b.fixedAllowancesTaxFree))}</td>
        <td className="py-2 pr-3 text-right font-semibold text-emerald-700">{money(netOf(p))}</td>
        <td className="py-2 pr-3 text-right text-violet-700">{money(n(b.employerPension))}</td>
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
          <td colSpan={22} className="px-4 py-3">
            <PayslipDetailGrid b={b} />
          </td>
        </tr>
      )}
    </>
  );
}

/** 工資清冊全表（每人一列 22 欄＋合計列；點姓名展開逐項明細）。原 /admin/payslips 的主表，月結發薪頁收在「工資清冊明細」裡。 */
export function PayslipLedgerTable({
  rows,
  totals,
  empName,
  busy,
  onFinalize,
  onSend,
}: {
  rows: PayslipRow[];
  totals: PayslipTotals;
  empName: (id: string) => string;
  busy: boolean;
  onFinalize: (id: string) => void;
  onSend: (p: PayslipRow) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
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
            <th className="py-2 pr-3 text-right" title="員工固定津貼的應稅部分（已含在應發）">固定津貼(應稅)</th>
            <th className="py-2 pr-3 text-right font-semibold">應發</th>
            <th className="py-2 pr-3 text-right">勞保</th>
            <th className="py-2 pr-3 text-right">健保</th>
            <th className="py-2 pr-3 text-right">勞退自提</th>
            <th className="py-2 pr-3 text-right">預支</th>
            <th className="py-2 pr-3 text-right">請假扣款</th>
            <th className="py-2 pr-3 text-right">遲到早退扣款</th>
            <th className="py-2 pr-3 text-right">代墊</th>
            <th className="py-2 pr-3 text-right" title="固定津貼的免稅部分（伙食費免稅額內）：不在應發、加在實發">免稅津貼</th>
            <th className="py-2 pr-3 text-right font-semibold">實發</th>
            <th className="py-2 pr-3 text-right" title="公司負擔，不從實發扣除">雇主勞退</th>
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
              <PayslipLedgerRow
                key={p.id}
                p={p}
                b={b}
                open={open}
                name={empName(p.employee_id)}
                busy={busy}
                onToggle={() => setOpenId(open ? null : p.id)}
                onPrint={() => printPayslip(p, empName(p.employee_id))}
                onFinalize={() => onFinalize(p.id)}
                onSend={() => onSend(p)}
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
            <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).fixedAllowancesTaxable), 0))}</td>
            <td className="py-2 pr-3 text-right">{money(totals.gross)}</td>
            <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).laborInsurance), 0))}</td>
            <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).healthInsurance), 0))}</td>
            <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).pensionVoluntary), 0))}</td>
            <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).advance), 0))}</td>
            <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).leaveDeduction), 0))}</td>
            <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).lateEarlyDeduction), 0))}</td>
            <td className="py-2 pr-3 text-right">{money(totals.expenses)}</td>
            <td className="py-2 pr-3 text-right">{money(rows.reduce((s, p) => s + n(bd(p).fixedAllowancesTaxFree), 0))}</td>
            <td className="py-2 pr-3 text-right">{money(totals.net)}</td>
            <td className="py-2 pr-3 text-right">{money(totals.employerPension)}</td>
            <td colSpan={3} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
