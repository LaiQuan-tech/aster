import crypto from "node:crypto"
import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { requireHrAdmin } from "../middleware/role.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"

export const announcementsRouter = Router()

/** 掃描檔的私有 bucket。⚠️ 需先在 Supabase 建立（同 request-attachments）。 */
const SHEET_BUCKET = "announcement-sheets"
const MAX_SHEET_BYTES = 10 * 1024 * 1024

const ACK_KINDS = ["consent_to_change", "accept_on_hire"] as const
const CHANGE_TYPES = ["initial", "amendment", "annual_rollover"] as const
const dateRe = /^\d{4}-\d{2}-\d{2}$/

const versionFields = {
  changeNote: z.string().trim().min(1).max(500).optional(),
  effectiveFrom: z.string().regex(dateRe).optional(),
  requiresSignature: z.boolean().optional(),
  isAdverseChange: z.boolean().optional(),
}

const createSchema = z.object({
  title: z.string().trim().min(1, "title is required"),
  body: z.string().trim().min(1, "body is required"),
  audience: z.string().trim().min(1).optional(),
  ...versionFields,
})

/**
 * PATCH 不再就地覆寫，而是**發新版**。故內容三欄可全數省略——
 * 「跨年度」進版（changeType='annual_rollover'）正是條款一字未改卻要新版的
 * 情況（年度特休、年度福利額度這類條款，適用年度不同即為不同版本）。
 * 客戶原文：「當條款**跨年度**或有**增修**時」——兩種觸發都要能表達。
 */
const updateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).optional(),
  audience: z.string().trim().min(1).optional(),
  changeType: z.enum(["amendment", "annual_rollover"]).optional(),
  ...versionFields,
})

const deleteAnnouncementSchema = z.object({
  reason: z.string().trim().min(1).max(250),
})

const sheetUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1),
  note: z.string().trim().min(1).max(250).optional(),
})

const acknowledgeSchema = z.object({
  /** 省略＝標記自己「已閱讀」；給定＝HR 代該員登錄紙本簽署。 */
  employeeId: z.string().uuid().optional(),
  kind: z.enum(ACK_KINDS).optional(),
  /** 紙本實際簽署日。掃描檔上看不出來，必須人工輸入。 */
  signedAt: z.string().datetime().optional(),
  signatureSheetId: z.string().uuid().optional(),
  note: z.string().trim().min(1).max(250).optional(),
})

const SELECT_COLS =
  "id, tenant_id, title, body, audience, current_version_id, created_by, created_at, updated_at"
const VERSION_COLS =
  "id, announcement_id, version_no, title, body, audience, change_type, change_note, " +
  "effective_from, effective_to, requires_signature, is_adverse_change, content_hash, " +
  "created_by_emp_id, created_at"

/**
 * Announcement routes (公佈欄／規章備查).
 *
 * 讀取開放給租戶內任何已登入員工；寫入僅 HR。租戶邊界是承重的守衛：
 * 每一次查詢都被強制綁到 res.locals.tenantId（來自 JWT），即使 supabaseAdmin
 * 繞過 RLS 也不可能碰到別的租戶。
 *
 * **兩條版本軸**（模組二第 2、3 條）：
 *   • 內容版本 `announcement_versions` —— 條款增修或跨年度時進版
 *   • 簽署快照 `announcement_signature_sheets` —— 有人補簽時加一份掃描檔，
 *     **不動內容版本**（新人補簽不會讓規章變成第 17 版）
 *
 * 本表的 title/body/audience 是現行版的去正規化快取，讓既有列表維持單表讀取；
 * 權威來源是 announcement_versions。
 */

/** 呼叫者在本租戶的 employees.id，無則 null。 */
async function resolveEmpId(tenantId: string, userId?: string): Promise<string | null> {
  if (!userId) return null
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`announcements resolve employee: ${error.message}`)
  return (data?.id as string | undefined) ?? null
}

/** 內容 hash：證明某一版的文字未被事後替換。 */
function contentHashOf(title: string, body: string, audience: string): string {
  return crypto.createHash("sha256").update(`${title}\n${body}\n${audience}`).digest("hex")
}

/** 未註銷的公告列，找不到回 null。 */
async function loadAnnouncement(tenantId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("announcements")
    .select(SELECT_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  if (error) throw new Error(`announcements load: ${error.message}`)
  return data
}

/** 版本列（含所屬公告的租戶檢查），找不到回 null。 */
async function loadVersion(tenantId: string, versionId: string) {
  const { data, error } = await supabaseAdmin
    .from("announcement_versions")
    .select(VERSION_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", versionId)
    .maybeSingle()
  if (error) throw new Error(`announcement version load: ${error.message}`)
  return data
}

/**
 * GET /announcements — 本租戶的公告，新到舊。
 *
 * 每列附帶現行版的 `requires_signature` 與 `version_no`：員工端據此只對
 * **需簽收的規章**記錄查閱（`viewed_at`），一般佈告不記。規章少、佈告多，
 * 對每則公告都寫一次查閱紀錄既無意義也浪費。
 *
 * 沒有用 foreign-table select —— `current_version_id` 刻意無 FK（與
 * announcement_versions.announcement_id 互為環狀參照），故分兩次查詢再併。
 */
announcementsRouter.get(
  "/announcements",
  requireAuth,
  requireTenant,
  async (_req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const { data, error } = await supabaseAdmin
        .from("announcements")
        .select(SELECT_COLS)
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })

      if (error) {
        next(new Error(`GET /announcements: ${error.message}`))
        return
      }
      const rows = data ?? []
      const versionIds = rows
        .map((r) => r.current_version_id as string | null)
        .filter((id): id is string => !!id)

      const versionById = new Map<string, { requires_signature: boolean; version_no: number }>()
      if (versionIds.length > 0) {
        const { data: vers, error: verErr } = await supabaseAdmin
          .from("announcement_versions")
          .select("id, requires_signature, version_no")
          .eq("tenant_id", tenantId)
          .in("id", versionIds)
        if (verErr) {
          next(new Error(`GET /announcements (versions): ${verErr.message}`))
          return
        }
        for (const v of vers ?? []) {
          versionById.set(v.id as string, {
            requires_signature: v.requires_signature as boolean,
            version_no: v.version_no as number,
          })
        }
      }

      const announcements = rows.map((r) => {
        const v = r.current_version_id
          ? versionById.get(r.current_version_id as string)
          : undefined
        return {
          ...r,
          requires_signature: v?.requires_signature ?? false,
          version_no: v?.version_no ?? null,
        }
      })
      res.status(200).json({ announcements })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /announcements/:id/versions — 內容版本鏈，版號由小到大。
 * 這是勞檢／訴訟時「請提出當時生效的第幾版」的答案來源。
 */
announcementsRouter.get(
  "/announcements/:id/versions",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const ann = await loadAnnouncement(tenantId, req.params.id as string)
      if (!ann) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const { data, error } = await supabaseAdmin
        .from("announcement_versions")
        .select(VERSION_COLS)
        .eq("tenant_id", tenantId)
        .eq("announcement_id", req.params.id as string)
        .order("version_no", { ascending: true })
      if (error) {
        next(new Error(`GET /announcements/${req.params.id as string}/versions: ${error.message}`))
        return
      }
      res.status(200).json({ versions: data ?? [] })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /announcements/:id/acknowledgements?versionId= — 簽收盤點（HR）。
 *
 * 回傳 signed / pending 兩份名單。**pending 才是重點**——一張紙本傳閱單
 * 傳完，沒人知道少了誰；這個端點就是要回答那個問題。
 *
 * `consentRate` 只計 kind='consent_to_change' 者：新人到職補簽
 * （'accept_on_hire'）不是「同意變更」的對象，既不進分母也不進分子。
 * 混算會讓同意率失真，而該比率正是不利益變更是否生效的關鍵事實。
 */
announcementsRouter.get(
  "/announcements/:id/acknowledgements",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    try {
      const ann = await loadAnnouncement(tenantId, req.params.id as string)
      if (!ann) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const versionId =
        (typeof req.query.versionId === "string" ? req.query.versionId : null) ??
        (ann.current_version_id as string | null)
      if (!versionId) {
        res.status(200).json({ versionId: null, signed: [], pending: [], consentRate: null })
        return
      }

      const { data: acks, error: ackErr } = await supabaseAdmin
        .from("announcement_acknowledgements")
        .select("id, employee_id, kind, viewed_at, signed_at, signature_sheet_id, note")
        .eq("tenant_id", tenantId)
        .eq("version_id", versionId)
      if (ackErr) {
        next(new Error(`GET acknowledgements: ${ackErr.message}`))
        return
      }

      const rows = acks ?? []
      const signed = rows.filter((r) => r.signed_at !== null)
      const pending = rows.filter((r) => r.signed_at === null)

      // 同意率只看「同意變更」那一類（見上方說明）。
      const consentRows = rows.filter((r) => r.kind === "consent_to_change")
      const consentRate =
        consentRows.length === 0
          ? null
          : {
              signed: consentRows.filter((r) => r.signed_at !== null).length,
              total: consentRows.length,
            }

      res.status(200).json({ versionId, signed, pending, consentRate })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /announcements — 發佈公告（HR）。同時建立第一版（version_no = 1，
 * change_type = 'initial'）並把 current_version_id 指過去。
 */
announcementsRouter.post(
  "/announcements",
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
    const { title, body } = parsed.data
    const audience = parsed.data.audience ?? "all"

    try {
      const actorEmpId = await resolveEmpId(tenantId, req.auth?.userId)

      const { data: ann, error } = await supabaseAdmin
        .from("announcements")
        .insert({
          tenant_id: tenantId,
          title,
          body,
          audience,
          created_by: actorEmpId,
        })
        .select("id")
        .single()
      if (error || !ann) {
        next(new Error(`POST /announcements: ${error?.message}`))
        return
      }
      const announcementId = ann.id as string

      const { data: version, error: verErr } = await supabaseAdmin
        .from("announcement_versions")
        .insert({
          tenant_id: tenantId,
          announcement_id: announcementId,
          version_no: 1,
          title,
          body,
          audience,
          change_type: "initial",
          change_note: parsed.data.changeNote ?? null,
          effective_from: parsed.data.effectiveFrom ?? null,
          requires_signature: parsed.data.requiresSignature ?? false,
          is_adverse_change: parsed.data.isAdverseChange ?? false,
          content_hash: contentHashOf(title, body, audience),
          created_by_emp_id: actorEmpId,
        })
        .select("id, version_no")
        .single()
      if (verErr || !version) {
        next(new Error(`POST /announcements (version): ${verErr?.message}`))
        return
      }

      await supabaseAdmin
        .from("announcements")
        .update({ current_version_id: version.id })
        .eq("tenant_id", tenantId)
        .eq("id", announcementId)

      await writeAuditLog({
        tenantId,
        tableName: "announcements",
        recordId: announcementId,
        action: "INSERT",
        newRow: { title, body, audience, versionNo: 1 },
        actorEmpId,
        context: "POST /announcements",
      })

      res.status(201).json({
        id: announcementId,
        versionId: version.id,
        versionNo: version.version_no,
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PATCH /announcements/:id — **發新版**，不再就地覆寫（模組二第 2 條）。
 *
 * 舊版的 effective_to 補上、新版 version_no + 1，本表的快取欄位同步更新，
 * 既有列表查詢維持不變。省略內容三欄即代表條款未改（跨年度進版）。
 */
announcementsRouter.patch(
  "/announcements/:id",
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
      const ann = await loadAnnouncement(tenantId, id)
      if (!ann) {
        res.status(404).json({ error: "not_found" })
        return
      }
      const actorEmpId = await resolveEmpId(tenantId, req.auth?.userId)

      const { data: latest, error: latestErr } = await supabaseAdmin
        .from("announcement_versions")
        .select("id, version_no, requires_signature, is_adverse_change")
        .eq("tenant_id", tenantId)
        .eq("announcement_id", id)
        .order("version_no", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (latestErr) {
        next(new Error(`PATCH /announcements/${id} (latest): ${latestErr.message}`))
        return
      }

      const title = parsed.data.title ?? (ann.title as string)
      const body = parsed.data.body ?? (ann.body as string)
      const audience = parsed.data.audience ?? (ann.audience as string)
      const nextNo = (latest?.version_no ?? 0) + 1
      const effectiveFrom = parsed.data.effectiveFrom ?? null

      const { data: version, error: verErr } = await supabaseAdmin
        .from("announcement_versions")
        .insert({
          tenant_id: tenantId,
          announcement_id: id,
          version_no: nextNo,
          title,
          body,
          audience,
          change_type: parsed.data.changeType ?? "amendment",
          change_note: parsed.data.changeNote ?? null,
          effective_from: effectiveFrom,
          // 未指定時沿用前一版：這兩個旗標是文件的性質，不會因為改一行字就消失。
          requires_signature:
            parsed.data.requiresSignature ?? (latest?.requires_signature ?? false),
          is_adverse_change: parsed.data.isAdverseChange ?? false,
          content_hash: contentHashOf(title, body, audience),
          created_by_emp_id: actorEmpId,
        })
        .select("id, version_no")
        .single()
      if (verErr || !version) {
        next(new Error(`PATCH /announcements/${id} (version): ${verErr?.message}`))
        return
      }

      // 舊版收尾：新版生效日即舊版失效日（未給則以今天計）。
      if (latest?.id) {
        await supabaseAdmin
          .from("announcement_versions")
          .update({ effective_to: effectiveFrom ?? new Date().toISOString().slice(0, 10) })
          .eq("tenant_id", tenantId)
          .eq("id", latest.id)
      }

      const { error: cacheErr } = await supabaseAdmin
        .from("announcements")
        .update({
          title,
          body,
          audience,
          current_version_id: version.id,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
      if (cacheErr) {
        next(new Error(`PATCH /announcements/${id}: ${cacheErr.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "announcements",
        recordId: id,
        action: "UPDATE",
        oldRow: { title: ann.title, body: ann.body, audience: ann.audience },
        newRow: { title, body, audience, versionNo: nextNo },
        actorEmpId,
        context: "PATCH /announcements/:id",
      })

      res.status(200).json({ id, versionId: version.id, versionNo: version.version_no })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * DELETE /announcements/:id — HR admin 註銷一則公告（**軟刪除**）。
 *
 * 公告與規章是勞資爭議的證據（施行細則 §37 的揭示／發給義務、以及爭議時
 * 「當時公告的是哪一版」的舉證），客戶亦明文要求保留 5~7 年追溯期。
 * 因此不做實體刪除：寫入 deleted_at / deleted_by_emp_id / delete_reason，
 * 列表與 PATCH 以 `deleted_at IS NULL` 過濾。`reason` 必填。
 * 版本鏈與簽收紀錄一律保留。
 * DB 層另有 sql/0018 的 no_hard_delete trigger 兜底。
 */
announcementsRouter.delete(
  "/announcements/:id",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const id = req.params.id as string

    const parsed = deleteAnnouncementSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "reason_required", details: parsed.error.flatten() })
      return
    }

    try {
      const actorEmpId = await resolveEmpId(tenantId, req.auth?.userId)

      const { data, error } = await supabaseAdmin
        .from("announcements")
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by_emp_id: actorEmpId,
          delete_reason: parsed.data.reason,
        })
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle()

      if (error) {
        next(new Error(`DELETE /announcements/${id}: ${error.message}`))
        return
      }
      if (!data) {
        // 不存在、跨租戶、或已註銷 —— 一律 404，不洩漏哪一種。
        res.status(404).json({ error: "not_found" })
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "announcements",
        recordId: id,
        action: "UPDATE",
        newRow: { deleted: true, reason: parsed.data.reason },
        actorEmpId,
        context: "DELETE /announcements/:id (soft)",
      })

      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /announcement-versions/:vid/sheets — 上傳該版的紙本簽名單掃描檔（HR）。
 *
 * **加一份新的（sheet_no + 1），不是覆蓋舊的。** 客戶原文寫「更新掃描檔」，
 * 照字面覆蓋會失去「某時點誰已簽」的時間切片，且紙本若毀損即無從還原。
 * 本端點不動 announcement_versions——補簽不是內容進版。
 */
announcementsRouter.post(
  "/announcement-versions/:vid/sheets",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const vid = req.params.vid as string
    const parsed = sheetUploadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const version = await loadVersion(tenantId, vid)
      if (!version) {
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
      if (bytes.length === 0 || bytes.length > MAX_SHEET_BYTES) {
        res.status(413).json({ error: "file_too_large", maxBytes: MAX_SHEET_BYTES })
        return
      }

      const { count, error: countErr } = await supabaseAdmin
        .from("announcement_signature_sheets")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("version_id", vid)
      if (countErr) {
        next(new Error(`POST sheets (count): ${countErr.message}`))
        return
      }
      const sheetNo = (count ?? 0) + 1

      // Storage key 必須 ASCII-safe；真實（可能是中文的）檔名存在 DB 列。
      const ext = (parsed.data.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
      const path = `${tenantId}/${vid}/${crypto.randomUUID()}${ext}`
      const { error: upErr } = await supabaseAdmin.storage
        .from(SHEET_BUCKET)
        .upload(path, bytes, { contentType: parsed.data.contentType })
      if (upErr) {
        next(new Error(`POST sheets (upload): ${upErr.message}`))
        return
      }

      const actorEmpId = await resolveEmpId(tenantId, req.auth?.userId)
      const { data: row, error: insErr } = await supabaseAdmin
        .from("announcement_signature_sheets")
        .insert({
          tenant_id: tenantId,
          version_id: vid,
          sheet_no: sheetNo,
          file_name: parsed.data.fileName,
          storage_path: path,
          size_bytes: bytes.length,
          content_type: parsed.data.contentType,
          content_hash: crypto.createHash("sha256").update(bytes).digest("hex"),
          note: parsed.data.note ?? null,
          uploaded_by_emp_id: actorEmpId,
        })
        .select("id, sheet_no")
        .single()
      if (insErr || !row) {
        // 索引寫入失敗就別留下孤兒 blob。
        await supabaseAdmin.storage.from(SHEET_BUCKET).remove([path])
        next(new Error(`POST sheets (insert): ${insErr?.message}`))
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "announcement_signature_sheets",
        recordId: row.id as string,
        action: "INSERT",
        newRow: { versionId: vid, sheetNo: row.sheet_no, fileName: parsed.data.fileName },
        actorEmpId,
        context: "POST /announcement-versions/:vid/sheets",
      })

      res.status(201).json({ id: row.id, sheetNo: row.sheet_no, sizeBytes: bytes.length })
    } catch (err) {
      next(err)
    }
  },
)

/** GET /announcement-versions/:vid/sheets — 該版所有掃描檔（含短效期 signed URL）。 */
announcementsRouter.get(
  "/announcement-versions/:vid/sheets",
  requireAuth,
  requireTenant,
  requireHrAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const vid = req.params.vid as string
    try {
      const { data, error } = await supabaseAdmin
        .from("announcement_signature_sheets")
        .select("id, sheet_no, file_name, storage_path, size_bytes, content_type, content_hash, note, uploaded_at")
        .eq("tenant_id", tenantId)
        .eq("version_id", vid)
        .order("sheet_no", { ascending: true })
      if (error) {
        next(new Error(`GET sheets: ${error.message}`))
        return
      }
      const sheets = await Promise.all(
        (data ?? []).map(async (r) => {
          const { data: signed } = await supabaseAdmin.storage
            .from(SHEET_BUCKET)
            .createSignedUrl(r.storage_path as string, 3600)
          return {
            id: r.id,
            sheetNo: r.sheet_no,
            fileName: r.file_name,
            sizeBytes: r.size_bytes,
            contentType: r.content_type,
            contentHash: r.content_hash,
            note: r.note,
            uploadedAt: r.uploaded_at,
            url: signed?.signedUrl ?? null,
          }
        }),
      )
      res.status(200).json({ sheets })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * POST /announcement-versions/:vid/acknowledge — 登錄簽收。
 *
 * 兩種用法：
 *   • 員工自己呼叫（body 不帶 employeeId）→ 只寫 `viewed_at`。
 *     這是**被動查閱紀錄**，不是客戶排斥的「線上勾選同意」；
 *     它證明「已發給且可取得」，滿足施行細則 §37 的法定義務。
 *   • HR 呼叫並帶 employeeId → 登錄**紙本簽署**，寫 `signed_at`
 *     （必須人工輸入實際簽署日：傳閱單頂上是公告日期，新人數月後在後續
 *     欄位補簽，那張紙不記錄他何時簽）。
 *
 * `kind` 決定這個簽名的法律性質，預設 'consent_to_change'；新人到職應帶
 * 'accept_on_hire'（由 onboarding 完成時自動建立）。
 */
announcementsRouter.post(
  "/announcement-versions/:vid/acknowledge",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const vid = req.params.vid as string
    const parsed = acknowledgeSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    try {
      const selfEmpId = await resolveEmpId(tenantId, req.auth?.userId)
      if (!selfEmpId) {
        res.status(403).json({ error: "not_an_employee" })
        return
      }

      // 代他人登錄＝紙本簽署，僅 HR 可為之。
      const targetEmpId = parsed.data.employeeId ?? selfEmpId
      if (targetEmpId !== selfEmpId) {
        const { data: me, error: meErr } = await supabaseAdmin
          .from("employees")
          .select("role")
          .eq("tenant_id", tenantId)
          .eq("id", selfEmpId)
          .maybeSingle()
        if (meErr) {
          next(new Error(`POST acknowledge (role): ${meErr.message}`))
          return
        }
        if (!["hr_admin", "platform_admin"].includes((me?.role as string) ?? "")) {
          res.status(403).json({ error: "hr_admin_required" })
          return
        }
      }

      const version = await loadVersion(tenantId, vid)
      if (!version) {
        res.status(404).json({ error: "not_found" })
        return
      }

      const isPaperSignature = parsed.data.employeeId !== undefined
      const now = new Date().toISOString()

      const { data: existing, error: exErr } = await supabaseAdmin
        .from("announcement_acknowledgements")
        .select("id, viewed_at, signed_at")
        .eq("tenant_id", tenantId)
        .eq("version_id", vid)
        .eq("employee_id", targetEmpId)
        .maybeSingle()
      if (exErr) {
        next(new Error(`POST acknowledge (load): ${exErr.message}`))
        return
      }

      const row: Record<string, unknown> = {
        tenant_id: tenantId,
        version_id: vid,
        employee_id: targetEmpId,
        kind: parsed.data.kind ?? "consent_to_change",
      }
      if (isPaperSignature) {
        row.signed_at = parsed.data.signedAt ?? now
        if (parsed.data.signatureSheetId) row.signature_sheet_id = parsed.data.signatureSheetId
        if (parsed.data.note) row.note = parsed.data.note
        // 已有的查閱時間不因登錄紙本簽署而被清掉。
        if (existing?.viewed_at) row.viewed_at = existing.viewed_at
      } else {
        // **只記第一次查閱。** 「已發給且可取得」的證據是初次送達的時點，
        // 用最近一次覆蓋會把那個時點洗掉。員工端每次開首頁都會呼叫本端點，
        // 若不保留首次時間，viewed_at 會永遠是「剛剛」而失去舉證價值。
        row.viewed_at = existing?.viewed_at ?? now
        if (existing?.signed_at) row.signed_at = existing.signed_at
      }

      const { data, error } = await supabaseAdmin
        .from("announcement_acknowledgements")
        .upsert(row, { onConflict: "tenant_id,version_id,employee_id" })
        .select("id, employee_id, kind, viewed_at, signed_at")
        .single()
      if (error || !data) {
        next(new Error(`POST acknowledge: ${error?.message}`))
        return
      }

      if (isPaperSignature) {
        await writeAuditLog({
          tenantId,
          tableName: "announcement_acknowledgements",
          recordId: data.id as string,
          action: "UPDATE",
          newRow: { versionId: vid, employeeId: targetEmpId, signedAt: row.signed_at },
          actorEmpId: selfEmpId,
          context: "POST /announcement-versions/:vid/acknowledge (paper)",
        })
      }

      res.status(200).json({ acknowledgement: data })
    } catch (err) {
      next(err)
    }
  },
)
