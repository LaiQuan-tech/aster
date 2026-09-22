import crypto from "node:crypto"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { resolveSelf } from "../middleware/scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { getTenantTimezone } from "../lib/tenant-tz.js"
import { todayKey } from "../lib/tz.js"
import { writeAuditLog } from "../services/audit.js"
import { birthdaysInMonth, loadBirthdayProfiles } from "../services/birthday.js"

/**
 * 生日紅包登記（M7；表 `birthday_gifts`、私有 bucket `birthday-photos`）。
 *
 *   GET    /birthday-gifts/upcoming?month=YYYY-MM   當月壽星＋各自的登記狀態
 *   GET    /birthday-gifts?year=YYYY                該年度所有登記
 *   POST   /birthday-gifts                          登記（一人一年一列）
 *   PATCH  /birthday-gifts/:id                      改金額／日期／備註
 *   POST   /birthday-gifts/:id/photo                現場拍照（base64）
 *   DELETE /birthday-gifts/:id/photo                刪照片（列保留）
 *
 * 全部限 HR：紅包金額是薪酬周邊資訊，一般員工與會計都看不到。照片走私有 bucket，
 * 讀取一律短效（900 秒）signed URL，不落任何公開連結。
 *
 * 壽星清單的來源是 `employee_profiles.birthday`（純邏輯在 services/birthday.ts，
 * 含 2/29 在平年視為 2/28 的處理）；提醒通知由 WP9 的每日 cron 呼叫
 * `remindBirthdays` 發給 HR。
 */
export const birthdayGiftsRouter = Router()

const BUCKET = "birthday-photos"
const MAX_PHOTO_BYTES = 8 * 1024 * 1024
const PHOTO_URL_TTL_SECONDS = 900

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const COLS =
  "id, employee_id, year, given_on, amount, photo_path, photo_file_name, note, created_by_emp_id, created_at, updated_at"

const createSchema = z.object({
  employeeId: z.string().uuid(),
  year: z.number().int().min(2000).max(2200),
  givenOn: z.string().regex(DATE_RE).nullish(),
  amount: z.number().min(0).max(9_999_999).nullish(),
  note: z.string().trim().max(500).nullish(),
})

const updateSchema = z
  .object({
    givenOn: z.string().regex(DATE_RE).nullish(),
    amount: z.number().min(0).max(9_999_999).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "no fields to update" })

const photoSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1),
})

interface GiftRow {
  id: string
  employee_id: string
  year: number
  given_on: string | null
  amount: string | number | null
  photo_path: string | null
  photo_file_name: string | null
  note: string | null
  created_by_emp_id: string | null
  created_at: string
  updated_at: string | null
}

async function signPhoto(path: string | null): Promise<string | null> {
  if (!path) return null
  const { data } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, PHOTO_URL_TTL_SECONDS)
  return data?.signedUrl ?? null
}

async function decorate(rows: GiftRow[], names: Map<string, string>) {
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      amount: row.amount === null ? null : Number(row.amount),
      employeeName: names.get(row.employee_id) ?? null,
      photoUrl: await signPhoto(row.photo_path),
    })),
  )
}

async function namesOf(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)))
  if (unique.length === 0) return new Map()
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .in("id", unique)
  if (error) throw new Error(`birthday gifts (names): ${error.message}`)
  return new Map((data ?? []).map((r) => [r.id as string, (r.name as string) ?? ""]))
}

async function loadGift(tenantId: string, id: string): Promise<GiftRow | null> {
  const { data, error } = await supabaseAdmin
    .from("birthday_gifts")
    .select(COLS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`load birthday gift: ${error.message}`)
  return (data as GiftRow | null) ?? null
}

/**
 * GET /birthday-gifts/upcoming?month=YYYY-MM — 當月壽星（預設本月，租戶時區）。
 *
 * 每位壽星附上今年的登記列（沒有就 null），HR 一眼看得出「這個月誰過生日、
 * 哪幾個還沒包」。`date` 是今年實際落在哪一天（2/29 在平年＝2/28）。
 */
birthdayGiftsRouter.get(
  "/birthday-gifts/upcoming",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const tz = await getTenantTimezone(tenantId)
      const raw = typeof req.query.month === "string" ? req.query.month.trim() : ""
      const month = MONTH_RE.test(raw) ? raw : todayKey(tz).slice(0, 7)
      const year = Number(month.slice(0, 4))

      const profiles = await loadBirthdayProfiles(tenantId)
      const hits = birthdaysInMonth(profiles, month)

      const { data, error } = await supabaseAdmin
        .from("birthday_gifts")
        .select(COLS)
        .eq("tenant_id", tenantId)
        .eq("year", year)
      if (error) {
        next(new Error(`GET /birthday-gifts/upcoming: ${error.message}`))
        return
      }
      const rows = (data ?? []) as GiftRow[]
      const names = await namesOf(tenantId, [...hits.map((h) => h.employeeId), ...rows.map((r) => r.employee_id)])
      const decorated = await decorate(rows, names)
      const giftByEmp = new Map(decorated.map((g) => [g.employee_id, g]))

      res.status(200).json({
        month,
        year,
        birthdays: hits.map((hit) => ({
          ...hit,
          name: hit.name ?? names.get(hit.employeeId) ?? null,
          gift: giftByEmp.get(hit.employeeId) ?? null,
        })),
      })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /birthday-gifts?year=YYYY — 該年度所有登記（預設今年）。 */
birthdayGiftsRouter.get(
  "/birthday-gifts",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const tz = await getTenantTimezone(tenantId)
      const raw = typeof req.query.year === "string" ? req.query.year.trim() : ""
      const year = /^\d{4}$/.test(raw) ? Number(raw) : Number(todayKey(tz).slice(0, 4))

      const { data, error } = await supabaseAdmin
        .from("birthday_gifts")
        .select(COLS)
        .eq("tenant_id", tenantId)
        .eq("year", year)
        .order("given_on", { ascending: true, nullsFirst: false })
      if (error) {
        next(new Error(`GET /birthday-gifts: ${error.message}`))
        return
      }
      const rows = (data ?? []) as GiftRow[]
      const names = await namesOf(tenantId, rows.map((r) => r.employee_id))
      const gifts = await decorate(rows, names)
      res.status(200).json({
        year,
        gifts,
        totalAmount: gifts.reduce((sum, g) => sum + (g.amount ?? 0), 0),
      })
    } catch (err) {
      next(err)
    }
  },
)

/** POST /birthday-gifts — 登記（一人一年一列；重複 409）。 */
birthdayGiftsRouter.post(
  "/birthday-gifts",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const { data: emp, error: empErr } = await supabaseAdmin
        .from("employees")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("id", parsed.data.employeeId)
        .maybeSingle()
      if (empErr) {
        next(new Error(`POST /birthday-gifts (employee): ${empErr.message}`))
        return
      }
      if (!emp) {
        res.status(404).json({ error: "employee_not_found" })
        return
      }

      const actor = await resolveSelf(tenantId, req.auth?.userId ?? "")
      const { data, error } = await supabaseAdmin
        .from("birthday_gifts")
        .insert({
          tenant_id: tenantId,
          employee_id: parsed.data.employeeId,
          year: parsed.data.year,
          given_on: parsed.data.givenOn ?? null,
          amount: parsed.data.amount ?? null,
          note: parsed.data.note ?? null,
          created_by_emp_id: actor?.id ?? null,
        })
        .select(COLS)
        .single()
      if (error || !data) {
        if (error?.code === "23505") {
          res.status(409).json({ error: "already_recorded" })
          return
        }
        next(new Error(`POST /birthday-gifts: ${error?.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "birthday_gifts",
        recordId: (data as GiftRow).id,
        action: "INSERT",
        newRow: { employeeId: parsed.data.employeeId, year: parsed.data.year, amount: parsed.data.amount ?? null },
        actorEmpId: actor?.id ?? null,
        context: "POST /birthday-gifts — 生日紅包登記",
      })

      res.status(201).json({ gift: { ...(data as GiftRow), photoUrl: null } })
    } catch (err) {
      next(err)
    }
  },
)

/** PATCH /birthday-gifts/:id — 改金額／發放日／備註。 */
birthdayGiftsRouter.patch(
  "/birthday-gifts/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (parsed.data.givenOn !== undefined) patch.given_on = parsed.data.givenOn
      if (parsed.data.amount !== undefined) patch.amount = parsed.data.amount
      if (parsed.data.note !== undefined) patch.note = parsed.data.note

      const { data, error } = await supabaseAdmin
        .from("birthday_gifts")
        .update(patch)
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .select(COLS)
        .maybeSingle()
      if (error) {
        next(new Error(`PATCH /birthday-gifts/${id}: ${error.message}`))
        return
      }
      if (!data) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const row = data as GiftRow
      res.status(200).json({ gift: { ...row, amount: row.amount === null ? null : Number(row.amount), photoUrl: await signPhoto(row.photo_path) } })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /birthday-gifts/:id/photo — 現場拍照留存（base64，比照假單附件的上傳模式）。
 * 換照片時舊檔直接砍掉：這是「有發、有拍」的佐證，不是需要版本鏈的法律文件。
 */
birthdayGiftsRouter.post(
  "/birthday-gifts/:id/photo",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    const parsed = photoSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const gift = await loadGift(tenantId, id)
      if (!gift) {
        res.status(404).json({ error: "not_found" })
        return
      }

      let bytes: Buffer
      try {
        bytes = Buffer.from(parsed.data.dataBase64, "base64")
      } catch {
        res.status(400).json({ error: "invalid_base64" })
        return
      }
      if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) {
        res.status(413).json({ error: "file_too_large", maxBytes: MAX_PHOTO_BYTES })
        return
      }

      // Storage key 必須 ASCII-safe；真實（可能是中文的）檔名存 DB 欄位。
      const ext = (parsed.data.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
      const path = `${tenantId}/${id}/${crypto.randomUUID()}${ext}`
      const { error: upErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType: parsed.data.contentType })
      if (upErr) {
        next(new Error(`POST /birthday-gifts/${id}/photo (upload): ${upErr.message}`))
        return
      }

      const previous = gift.photo_path
      const { error } = await supabaseAdmin
        .from("birthday_gifts")
        .update({
          photo_path: path,
          photo_file_name: parsed.data.fileName,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (error) {
        await supabaseAdmin.storage.from(BUCKET).remove([path]) // 索引寫不進去就別留孤兒 blob
        next(new Error(`POST /birthday-gifts/${id}/photo: ${error.message}`))
        return
      }
      if (previous && previous !== path) {
        await supabaseAdmin.storage.from(BUCKET).remove([previous])
      }

      res.status(201).json({
        id,
        fileName: parsed.data.fileName,
        sizeBytes: bytes.length,
        photoUrl: await signPhoto(path),
      })
    } catch (err) {
      next(err)
    }
  },
)

/** DELETE /birthday-gifts/:id/photo — 刪照片（登記列保留）。 */
birthdayGiftsRouter.delete(
  "/birthday-gifts/:id/photo",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string
    try {
      const gift = await loadGift(tenantId, id)
      if (!gift) {
        res.status(404).json({ error: "not_found" })
        return
      }
      if (!gift.photo_path) {
        res.status(200).json({ id, removed: false })
        return
      }
      const { error } = await supabaseAdmin
        .from("birthday_gifts")
        .update({ photo_path: null, photo_file_name: null, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", id)
      if (error) {
        next(new Error(`DELETE /birthday-gifts/${id}/photo: ${error.message}`))
        return
      }
      await supabaseAdmin.storage.from(BUCKET).remove([gift.photo_path])
      res.status(200).json({ id, removed: true })
    } catch (err) {
      next(err)
    }
  },
)
