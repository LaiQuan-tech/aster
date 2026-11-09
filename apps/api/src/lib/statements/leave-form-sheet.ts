import { GridBuilder, STATEMENT_FONT, rocPeriodTitle, rocYear, type StatementGrid } from "./grid.js"
import { DAY_ROWS, DAY_ROW_START, letterheadRows, statementDayContent, statementDays } from "./attendance-statement.js"
import type { StatementData, StatementLeaveDay } from "./types.js"

/**
 * 請假單（客戶 Excel「115-10 出勤統計表」工作表「請假單」，列印範圍 A1:J36）的格線。純函式。
 *
 * 逐日 31 列鏡像「出勤」：日期｜請假時間（核准假單當日起訖）｜請假日(時)數｜公司假別｜請假事由｜勞保局（＝出勤「內容」）；
 * 隱藏欄 D/E/F/J（職務代理人、經理簽核、老闆核准、請假人）照原檔保留欄位但隱藏；週末／假日列隱藏同「出勤」。
 * 列 37「加總」。
 */

export const LEAVE_FORM_COLUMN_WIDTHS = [12, 13.625, 13.625, 12.375, 12.375, 12.375, 20.75, 11.625, 12, 12.5]
export const LEAVE_FORM_HIDDEN_COLUMNS = [3, 4, 5, 9]
const HEADER_FILL = "#D6E3BC"

function leaveTimeText(items: StatementLeaveDay[]): string {
  return items
    .map((l) => (l.start && l.end ? `${l.start}~${l.end}` : ""))
    .filter(Boolean)
    .join("、")
}

function uniqueJoin(values: Array<string | null | undefined>): string {
  return [...new Set(values.map((v) => (v ?? "").trim()).filter(Boolean))].join("、")
}

export function buildLeaveFormGrid(data: StatementData): StatementGrid {
  const g = new GridBuilder()
  const center = { align: "center" as const }
  const LAST = 9
  const [yy, mm] = data.period.split("-").map(Number)
  letterheadRows(g, data, LAST)
  g.set(3, 1, { value: rocYear(yy), format: "yearZh", size: 14, ...center })
  g.set(3, 2, { value: mm, format: "monthZh", size: 14, ...center })
  g.set(3, 6, { value: "請假單", size: 14, ...center })
  g.set(3, 7, { value: data.employee.name, size: 14, ...center })
  for (let c = 0; c <= LAST; c += 1) g.border(3, c, { bottom: "thin" })
  ;["日期", "請假時間", "請假日(時)數", "職務代理人", "經理簽核", "老闆核准", "公司假別", "請假事由", "勞保局", "請假人"].forEach((label, c) =>
    g.set(4, c, { value: label, bold: true, fill: HEADER_FILL, wrap: true, ...center }),
  )
  g.thinGrid(4, 0, 4, LAST)

  const { infos, hiddenRows } = statementDays(data)
  let total = 0
  infos.forEach((info, i) => {
    const r = DAY_ROW_START + i
    if (!info) {
      for (let c = 0; c <= LAST; c += 1) g.set(r, c, { value: null })
      return
    }
    const items = data.leaveDays?.[info.date] ?? []
    const hours = Math.round(((info.day?.leaveMinutes ?? 0) / 60) * 100) / 100
    total += hours
    g.set(r, 0, { value: info.date, format: "mdZh", ...center })
    g.set(r, 1, { value: leaveTimeText(items), ...center, wrap: true })
    g.set(r, 2, { value: hours, format: "general", ...center })
    g.set(r, 6, { value: uniqueJoin(items.map((l) => l.name)), ...center, wrap: true })
    g.set(r, 7, { value: uniqueJoin(items.map((l) => l.reason)), ...center, wrap: true })
    g.set(r, 8, { value: statementDayContent(info), ...center, wrap: true })
  })
  g.thinGrid(DAY_ROW_START, 0, DAY_ROW_START + DAY_ROWS - 1, LAST)
  const T = DAY_ROW_START + DAY_ROWS
  g.set(T, 1, { value: "加總", ...center })
  g.set(T, 2, { value: Math.round(total * 100) / 100, format: "general", ...center })
  g.thinGrid(T, 0, T, LAST)

  const rowHeights = Array.from({ length: T + 1 }, (_, i) => (i >= 4 && i < T ? 45.75 : 22.35))
  return {
    kind: "leaveForm",
    title: `${rocPeriodTitle(data.period)}請假單-${data.employee.name}`,
    columns: LEAVE_FORM_COLUMN_WIDTHS,
    rowHeights,
    font: STATEMENT_FONT,
    cells: g.build(),
    hiddenColumns: LEAVE_FORM_HIDDEN_COLUMNS,
    hiddenRows,
    page: {
      orientation: "portrait",
      paperSize: 9,
      printTitleRows: [1, 4],
      fit: "none",
      margins: { left: 0.51, right: 0.31, top: 0.35, bottom: 0.35 },
      printArea: "A1:J36",
    },
  }
}
