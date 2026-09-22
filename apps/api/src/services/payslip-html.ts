/**
 * 薪資條 Email 版面（M3，2026-09-23）——**純函式，不連 DB、不寄信**。
 *
 * 欄位與後台列印版（`apps/web/src/app/admin/payslips/page.tsx` 的 `printOne`）一致：
 * 應發（本薪／加班費／夜間加給／全勤獎金／定額補貼／應發合計）→ 應扣（勞保／健保／
 * 勞退自提／預支扣回／請假扣款／遲到早退扣款／應扣合計）→ 實發（代墊支出／實發金額），
 * 之後才是加班費分段與逐項明細。三段的順序與標題是驗收條件，改動前先看
 * `__tests__/payslip-html.test.ts`。
 *
 * 與列印版的兩個差別：
 *   ① **不含任何 `<script>`**（列印版結尾有 `window.print()`；信件裡的腳本不會執行，
 *      而且會被郵件服務判定成可疑內容）——測試直接斷言 html 不含 "<script"。
 *   ② 全部樣式寫成 inline style（`<style>` 區塊在多數郵件客戶端會被剝掉）。
 *
 * 金額一律 `toLocaleString("zh-TW")`（千分位、無小數），與畫面同一份格式；
 * 姓名／備註等自由文字一律 `esc()` 後才進 HTML。
 */

/** 只取用得到的欄位，舊資料 breakdown 可能是 `{}`，全部 optional。 */
export interface PayslipBreakdownLike {
  hourlyWage?: number
  allowances?: number
  laborInsurance?: number
  healthInsurance?: number
  pensionVoluntary?: number
  advance?: number
  leaveDeduction?: number
  lateEarlyDeduction?: number
  totalDeductions?: number
  expenses?: number
  net?: number
  overtimeSegments?: Array<{ when: string; multiplier: number; hours: number; amount: number }>
  lines?: Array<{ label: string; amount: number }>
}

/** PostgREST 的 numeric 欄位回字串；這裡一律接受 string | number | null。 */
export interface PayslipLike {
  period: string
  base?: string | number | null
  overtime_pay?: string | number | null
  night_pay?: string | number | null
  attendance_bonus?: string | number | null
  gross?: string | number | null
  status?: string | null
}

export interface RenderPayslipInput {
  payslip: PayslipLike
  employeeName: string
  empNo?: string | null
  breakdown?: PayslipBreakdownLike | null
  /** 信尾署名（租戶名稱）；省略＝不加署名段。 */
  appName?: string | null
}

const OT_LABEL: Record<string, string> = {
  weekday_ot: "平日加班",
  rest_day: "休息日",
  fixed_holiday: "國定假日",
}

/** 數字化：字串 numeric、null、NaN 一律當 0（與畫面 `n()` 同語意）。 */
function n(v: string | number | null | undefined): number {
  const x = typeof v === "number" ? v : Number(v)
  return Number.isFinite(x) ? x : 0
}

/** 金額格式：千分位、無小數（與畫面 `money()` 同一份）。 */
export function money(v: number): string {
  return Math.round(v).toLocaleString("zh-TW")
}

/** HTML escape（與畫面列印版的 `esc()` 同一份，另補上引號）。 */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** 實發：有 breakdown.net 用引擎算的；沒有就等於應發（舊資料沒扣項）。 */
function netOf(p: PayslipLike, b: PayslipBreakdownLike): number {
  return typeof b.net === "number" ? b.net : n(p.gross)
}

function displayName(employeeName: string, empNo?: string | null): string {
  return empNo ? `${empNo} · ${employeeName}` : employeeName
}

/** 信件主旨：`{period} 薪資單`（§3.2）。 */
export function payslipMailSubject(period: string): string {
  return `${period} 薪資單`
}

type Row = [label: string, value: string]

function tableHtml(rows: Row[], sumIndex: number): string {
  const tds = rows.map(([label, value], i) => {
    const bold = i === sumIndex ? "font-weight:600;background:#f7f7f7;" : ""
    return `<tr><td style="border:1px solid #ddd;padding:6px 8px;font-size:13px;${bold}">${esc(label)}</td><td style="border:1px solid #ddd;padding:6px 8px;font-size:13px;text-align:right;${bold}">${esc(value)}</td></tr>`
  })
  return `<table style="border-collapse:collapse;width:100%">${tds.join("")}</table>`
}

/** 三段（應發／應扣／實發）的資料列——html 與純文字共用同一份，兩版不會走鐘。 */
function sections(p: PayslipLike, b: PayslipBreakdownLike): Array<{ title: string; rows: Row[] }> {
  return [
    {
      title: "應發",
      rows: [
        ["本薪", money(n(p.base))],
        ["加班費", money(n(p.overtime_pay))],
        ["夜間加給", money(n(p.night_pay))],
        ["全勤獎金", money(n(p.attendance_bonus))],
        ["定額補貼", money(n(b.allowances))],
        ["應發合計", money(n(p.gross))],
      ],
    },
    {
      title: "應扣",
      rows: [
        ["勞保自付", money(n(b.laborInsurance))],
        ["健保自付", money(n(b.healthInsurance))],
        ["勞退自提", money(n(b.pensionVoluntary))],
        ["預支扣回", money(n(b.advance))],
        ["請假扣款", money(n(b.leaveDeduction))],
        ["遲到早退扣款", money(n(b.lateEarlyDeduction))],
        ["應扣合計", money(n(b.totalDeductions))],
      ],
    },
    {
      title: "實發",
      rows: [
        ["代墊支出（不計薪資所得）", money(n(b.expenses))],
        ["實發金額", money(netOf(p, b))],
      ],
    },
  ]
}

/**
 * 薪資條 HTML（信件本文）。**不含 `<script>`**，樣式全部 inline。
 */
export function renderPayslipHtml(input: RenderPayslipInput): string {
  const p = input.payslip
  const b = input.breakdown ?? {}
  const h2 = 'style="font-size:14px;margin:20px 0 6px;color:#555"'
  const parts: string[] = []

  parts.push(
    `<div style="font-family:ui-sans-serif,system-ui,'Noto Sans TC',sans-serif;color:#111;max-width:680px">`,
    `<h1 style="font-size:20px;margin:0 0 4px">薪資單　${esc(displayName(input.employeeName, input.empNo))}</h1>`,
    `<div style="color:#777;font-size:12px">期間 ${esc(p.period)}　狀態 ${p.status === "finalized" ? "已定案" : "草稿"}　基準時薪 ${money(n(b.hourlyWage))}</div>`,
  )

  for (const s of sections(p, b)) {
    parts.push(`<h2 ${h2}>${s.title}</h2>`, tableHtml(s.rows, s.rows.length - 1))
  }

  const ot = b.overtimeSegments ?? []
  if (ot.length > 0) {
    const rows = ot
      .map(
        (s) =>
          `<tr><td style="border:1px solid #ddd;padding:6px 8px;font-size:13px">${esc(OT_LABEL[s.when] ?? s.when)} × ${s.multiplier}</td><td style="border:1px solid #ddd;padding:6px 8px;font-size:13px;text-align:right">${s.hours} 小時</td><td style="border:1px solid #ddd;padding:6px 8px;font-size:13px;text-align:right">${money(s.amount)}</td></tr>`,
      )
      .join("")
    parts.push(`<h2 ${h2}>加班費分段</h2><table style="border-collapse:collapse;width:100%">${rows}</table>`)
  }

  const lines = b.lines ?? []
  if (lines.length > 0) {
    parts.push(
      `<h2 ${h2}>逐項明細</h2>`,
      tableHtml(
        lines.map((l) => [l.label, money(l.amount)] as Row),
        -1,
      ),
    )
  }

  parts.push(
    `<p style="color:#777;font-size:12px;margin-top:24px">本信由系統自動寄出，內容以公司出具之工資清冊為準；如有疑問請洽人資。${input.appName ? `<br>${esc(input.appName)}` : ""}</p>`,
    `</div>`,
  )
  return parts.join("")
}

/**
 * 純文字版（信件的 text 欄；不支援 HTML 的客戶端看這份）。段落順序與 html 相同。
 */
export function renderPayslipText(input: RenderPayslipInput): string {
  const p = input.payslip
  const b = input.breakdown ?? {}
  const out: string[] = [
    `薪資單　${displayName(input.employeeName, input.empNo)}`,
    `期間 ${p.period}　狀態 ${p.status === "finalized" ? "已定案" : "草稿"}　基準時薪 ${money(n(b.hourlyWage))}`,
  ]
  for (const s of sections(p, b)) {
    out.push("", `【${s.title}】`)
    for (const [label, value] of s.rows) out.push(`${label}：${value}`)
  }
  out.push("", "本信由系統自動寄出，內容以公司出具之工資清冊為準；如有疑問請洽人資。")
  if (input.appName) out.push(input.appName)
  return out.join("\n")
}
