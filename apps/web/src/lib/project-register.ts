/**
 * 「所有專案」列表 ＝ 公司「專案申請單總表」Excel 的欄位（業主 2026-10-27：欄頭一字不差、順序相同）。
 *
 * 固定欄 A:P（項次…備註），科別發包欄（空調、消防、汙水…依租戶設定）從 Q 欄起接在後面。
 * 資料來自 GET /projects?view=register（金額依權限遮罩：moneyVisible=false 的列顯示「—」）。
 * 純函式，畫面與測試共用。
 */

export interface ProjectRegisterCells {
  projectId: string
  dateRoc: string | null
  contractStatus: "未簽約" | "已簽約"
  engineerSignature: string
  leadName: string | null
  moneyVisible: boolean
  amountUntaxed: number | null
  taxAmount: number | null
  amountTotal: number | null
  receivedTotal: number | null
  unreceived: number | null
  invoicedTotal: number | null
  subcontractTotal: number | null
  subcontractByDiscipline: Record<string, number>
  note: string
}

/** 原 Excel 第 4 列 A:P 的欄頭，一字不差。 */
export const REGISTER_FIXED_HEADERS = [
  "項次", "專案單號", "日期", "客戶", "工程名稱", "金額", "稅金", "含稅",
  "已收帳款", "應收帳款", "已開發票", "合約", "簽證", "發包", "業務", "備註",
] as const

/** 原 Excel 的欄寬（字元寬，A:P）；科別欄原檔一律 13。畫面換算成 px 用。 */
export const REGISTER_FIXED_WIDTHS = [5.18, 13, 11.18, 15.82, 25.45, 13.82, 13.18, 14.45, 12.82, 13.45, 12.82, 6.91, 11.45, 10.82, 8.63, 19] as const
export const REGISTER_DISCIPLINE_WIDTH = 13

/** 凍結窗格：原檔 F5 → 凍結 A:E（項次、專案單號、日期、客戶、工程名稱）與表頭。 */
export const REGISTER_FROZEN_COLUMNS = 5

export type RegisterAlign = "center" | "left" | "right"

export interface RegisterColumn {
  header: string
  width: number
  align: RegisterAlign
  /** true＝金額類，無權限時顯示「—」。 */
  money: boolean
}

export function registerColumns(disciplines: string[]): RegisterColumn[] {
  const fixed: RegisterColumn[] = REGISTER_FIXED_HEADERS.map((header, i) => ({
    header,
    width: REGISTER_FIXED_WIDTHS[i],
    // 原檔除了備註（靠左）其餘置中；畫面上金額改靠右比較好對位數。
    align: header === "備註" ? "left" : i >= 5 && i <= 10 || header === "發包" ? "right" : "center",
    money: (i >= 5 && i <= 10) || header === "發包" || header === "備註",
  }))
  const disc: RegisterColumn[] = disciplines.map((header) => ({ header, width: REGISTER_DISCIPLINE_WIDTH, align: "right", money: true }))
  return [...fixed, ...disc]
}

/**
 * Excel 字元寬 → px。原檔字型是 12pt 標楷體（比預設 Calibri 11 寬），畫面是 14px 字＋左右各 8px 留白，
 * 取每單位 8px＋10px，讓「項次」「合約」「業務」這些原檔剛好塞得下的窄欄在畫面上也不折行。
 */
export function excelWidthToPx(width: number): number {
  return Math.round(width * 8 + 10)
}

/**
 * 原檔金額格式 `_-* #,##0_-;\-* #,##0_-;_-* "-"??_-;_-@_-`：千分位、負數前置減號、0 顯示「-」。
 * null（沒有金額）顯示空白，跟 Excel 空儲存格一樣。
 */
export function formatRegisterMoney(value: number | null | undefined): string {
  if (value == null) return ""
  const rounded = Math.round(value)
  if (rounded === 0) return "-"
  return rounded < 0 ? `-${Math.abs(rounded).toLocaleString("en-US")}` : rounded.toLocaleString("en-US")
}

export interface RegisterInput {
  seq: number
  code: string | null
  clientName: string | null
  name: string
  register: ProjectRegisterCells | null | undefined
}

export const MASKED = "—"

/** 一列的所有儲存格文字（順序同 registerColumns）。 */
export function registerRowCells(item: RegisterInput, disciplines: string[]): string[] {
  const r = item.register
  const visible = r?.moneyVisible === true
  const money = (v: number | null | undefined) => (visible ? formatRegisterMoney(v) : r ? MASKED : "")
  return [
    String(item.seq),
    item.code ?? "",
    r?.dateRoc ?? "",
    item.clientName ?? "",
    item.name,
    money(r?.amountUntaxed),
    money(r?.taxAmount),
    money(r?.amountTotal),
    money(r?.receivedTotal),
    money(r?.unreceived),
    money(r?.invoicedTotal),
    r?.contractStatus ?? "",
    r?.engineerSignature ?? "",
    money(r?.subcontractTotal),
    r?.leadName ?? "",
    visible ? (r?.note ?? "") : "",
    ...disciplines.map((d) => (visible ? formatRegisterMoney(r?.subcontractByDiscipline[d]) : r ? MASKED : "")),
  ]
}
