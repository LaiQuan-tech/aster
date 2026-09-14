import { Router, type Request, type Response, type NextFunction } from "express"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { todayKey } from "../lib/tz.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { DISBURSEMENT_COLS, serializeMany, type DisbursementRow, type SerializedDisbursement } from "../services/disbursements.js"
import { DISBURSEMENT_PIVOT_GROUP_BYS, pivotDisbursements, type DisbursementPivotGroupBy } from "../services/disbursement-pivot.js"
import { disbursementPivotFilename, disbursementPivotWorkbookBuffer } from "../lib/xlsx/disbursement-pivot.js"

export const disbursementReportsRouter = Router()

/**
 * B3：放款年度 × 廠商／付款公司／專案樞紐（老闆年底報稅一眼看「今年給每家
 * 廠商多少錢」）。全新檔案；不改 routes/disbursements.ts、services/disbursements.ts。
 *
 * 路徑是 /disbursements/pivot、/disbursements/pivot.xlsx —— 必須掛在
 * disbursementsRouter 之前（見 app.ts），否則 'pivot' 會被 GET /disbursements/:id
 * 當 id 吃掉（同 projects-annual.ts／project-overview.ts 的理由；雖然那個
 * :id 路由有 UUID 檢查、非 UUID 會 next() 放行，這裡仍照專案慣例把新路由掛
 * 在前面，不依賴那個隱性的 fallthrough）。
 *
 * 口徑只算 status='paid'（同 buildSummary／summarizeDisbursements 的分工：
 * 「只算 status='paid' 的列，呼叫端先過濾」）——草稿還沒真的付錢、作廢已經
 * 反向沖銷，年底報稅要看的是「真的給出去多少」，這也是本頁「本年放款」卡片
 * 已經在用的口徑，樞紐總計才會跟老闆平常看的卡片對得起來。
 *
 * `listDisbursements` 有 `.limit(1000)`，一整年的匯款筆數可能超過，這裡不
 * 沿用它，直接查表＋自己分頁撈全部（見 loadYearPaidDisbursements）。
 */

const guards = [requireAuth, requireTenant, requireHrAdmin] as const
const PAGE_SIZE = 1000

function parseGroupBy(v: unknown): DisbursementPivotGroupBy | null {
  if (typeof v !== "string") return null
  return (DISBURSEMENT_PIVOT_GROUP_BYS as readonly string[]).includes(v) ? (v as DisbursementPivotGroupBy) : null
}

/** `?year=`；省略時取租戶當地今年。純西元 4 位數字——這裡月份直接切 paidOn
 * 字串比對西元年，不像 P3 年度總表接受民國年（混用只會條件永遠不中）。 */
function parseYear(v: unknown, todayYear: number): number | null {
  if (v === undefined) return todayYear
  if (typeof v !== "string" || !/^\d{4}$/.test(v)) return null
  const y = Number(v)
  return y >= 2000 && y <= 2100 ? y : null
}

/**
 * 直接查表撈「這個租戶、這個年度、status='paid'」的匯款單，用 `.range()` 分頁
 * 繞過 `listDisbursements` 的 1000 筆上限（見檔頭註記）；口徑（status='paid'、
 * paid_on 落在年度範圍）同 `buildSummary`。撈完照抄 `serializeMany` 一次批次
 * 補齊分攤／專案／公司名，形狀跟列表頁一致。
 */
async function loadYearPaidDisbursements(tenantId: string, year: number): Promise<SerializedDisbursement[]> {
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const rows: DisbursementRow[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("disbursements")
      .select(DISBURSEMENT_COLS)
      .eq("tenant_id", tenantId)
      .eq("status", "paid")
      .gte("paid_on", from)
      .lte("paid_on", to)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`loadYearPaidDisbursements: ${error.message}`)
    const batch = (data ?? []) as unknown as DisbursementRow[]
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return serializeMany(tenantId, rows)
}

/** 同 routes/disbursements.ts 的 sendXlsx——那邊是私有函式沒有 export，這裡複製
 * 一份，不 import 私有函式。 */
function sendXlsx(res: Response, buffer: Buffer, filename: string): void {
  res
    .status(200)
    .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(buffer)
}

async function resolveYearAndGroupBy(
  tenantId: string,
  query: Request["query"],
): Promise<{ ok: true; year: number; groupBy: DisbursementPivotGroupBy } | { ok: false; error: string }> {
  const tz = await getTenantTimezone(tenantId)
  const todayYear = Number(todayKey(tz).slice(0, 4))
  const year = parseYear(query.year, todayYear)
  if (year === null) return { ok: false, error: "invalid_year" }
  const groupBy = query.groupBy === undefined ? "vendor" : parseGroupBy(query.groupBy)
  if (groupBy === null) return { ok: false, error: "invalid_group_by" }
  return { ok: true, year, groupBy }
}

// ── GET /disbursements/pivot?year=&groupBy=vendor|company|project ──────
disbursementReportsRouter.get("/disbursements/pivot", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const parsed = await resolveYearAndGroupBy(tenantId, req.query)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }
    const rows = await loadYearPaidDisbursements(tenantId, parsed.year)
    res.status(200).json(pivotDisbursements(rows, { groupBy: parsed.groupBy, year: parsed.year }))
  } catch (err) {
    next(err)
  }
})

// ── GET /disbursements/pivot.xlsx?year=&groupBy=vendor|company|project ──
disbursementReportsRouter.get("/disbursements/pivot.xlsx", ...guards, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  try {
    const parsed = await resolveYearAndGroupBy(tenantId, req.query)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }
    const rows = await loadYearPaidDisbursements(tenantId, parsed.year)
    const pivot = pivotDisbursements(rows, { groupBy: parsed.groupBy, year: parsed.year })
    const buffer = await disbursementPivotWorkbookBuffer(pivot)
    sendXlsx(res, buffer, disbursementPivotFilename(pivot))
  } catch (err) {
    next(err)
  }
})
