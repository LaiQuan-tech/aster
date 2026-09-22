import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { supabaseAdmin } from "../lib/supabase.js"
import {
  columnLabel,
  diffProfile,
  editableColumns,
  loadFormParameters,
} from "../services/profile-fields.js"
import { enqueue } from "../services/notify.js"

export const employeeProfileRouter = Router()

const dateRe = /^\d{4}-\d{2}-\d{2}$/
const NIL = "00000000-0000-0000-0000-000000000000"
const DOCUMENT_BUCKET = "employee-documents"
const MAX_FILE_BYTES = 3 * 1024 * 1024
const PROFILE_SELECT =
  "id, first_name, last_name, english_name, nationality, id_type, id_number, id_expiry, id_type2, id_number2, id_expiry2, id_type3, id_number3, id_expiry3, entry_date, birthday, gender, marital_status, photo_file_name, photo_storage_path, photo_size_bytes, photo_content_type, phone, phone_mobile2, phone_landline, registered_address, address, company_email, personal_email, line_user_id, emergency_contact, emergency_relationship, emergency_phone, note, updated_at"
const PROFILE_SELECT_BASE =
  "id, english_name, nationality, id_type, id_number, id_expiry, id_type2, id_number2, id_expiry2, id_type3, id_number3, id_expiry3, entry_date, birthday, gender, marital_status, phone, phone_mobile2, phone_landline, registered_address, address, company_email, personal_email, emergency_contact, emergency_relationship, emergency_phone, note, updated_at"
const EDUCATION_SELECT =
  "id, school, is_highest, major_category, major, degree, study_type, study_status, region, start_date, end_date, proof_file_name, proof_storage_path, proof_size_bytes, proof_content_type"
const EDUCATION_SELECT_BASE =
  "id, school, is_highest, major_category, major, degree, study_type, study_status, region, start_date, end_date"
const CERTIFICATION_SELECT =
  "id, name, issuer, issued_date, expiry_date, attachment_file_name, attachment_storage_path, attachment_size_bytes, attachment_content_type"
const CERTIFICATION_SELECT_BASE = "id, name, issuer, issued_date, expiry_date"

const uploadSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1),
})

/**
 * Resolve the caller's own employee (id + role) in this tenant, then decide
 * whether they may act on `empId`: allowed when they ARE that employee, or when
 * they are HR/platform admin. Returns null (and the caller should 403) otherwise.
 */
async function authorize(
  tenantId: string,
  userId: string,
  empId: string,
): Promise<{ isHr: boolean; selfId: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(`profile authorize: ${error.message}`)
  if (!data) return null
  const isHr = ["hr_admin", "platform_admin"].includes(data.role as string)
  if (!isHr && data.id !== empId) return null
  return { isHr, selfId: data.id as string }
}

const profileSchema = z.object({
  // 基本資料
  firstName: z.string().trim().nullish(),
  lastName: z.string().trim().nullish(),
  englishName: z.string().trim().nullish(),
  nationality: z.string().trim().nullish(),
  idType: z.string().trim().nullish(),
  idNumber: z.string().trim().nullish(),
  idExpiry: z.string().regex(dateRe).nullish(),
  idType2: z.string().trim().nullish(),
  idNumber2: z.string().trim().nullish(),
  idExpiry2: z.string().regex(dateRe).nullish(),
  idType3: z.string().trim().nullish(),
  idNumber3: z.string().trim().nullish(),
  idExpiry3: z.string().regex(dateRe).nullish(),
  entryDate: z.string().regex(dateRe).nullish(),
  birthday: z.string().regex(dateRe).nullish(),
  gender: z.string().trim().nullish(),
  maritalStatus: z.string().trim().nullish(),
  // 通訊資料
  phone: z.string().trim().nullish(),
  phoneMobile2: z.string().trim().nullish(),
  phoneLandline: z.string().trim().nullish(),
  registeredAddress: z.string().trim().nullish(),
  address: z.string().trim().nullish(),
  companyEmail: z.string().trim().nullish(),
  personalEmail: z.string().trim().nullish(),
  lineUserId: z.string().trim().nullish(),
  emergencyContact: z.string().trim().nullish(),
  emergencyRelationship: z.string().trim().nullish(),
  emergencyPhone: z.string().trim().nullish(),
  note: z.string().trim().nullish(),
})

const educationSchema = z.object({
  school: z.string().trim().min(1),
  isHighest: z.boolean().optional(),
  majorCategory: z.string().trim().nullish(),
  major: z.string().trim().nullish(),
  degree: z.string().trim().nullish(),
  studyType: z.string().trim().nullish(),
  studyStatus: z.string().trim().nullish(),
  region: z.string().trim().nullish(),
  startDate: z.string().regex(dateRe).nullish(),
  endDate: z.string().regex(dateRe).nullish(),
})

const certificationSchema = z.object({
  name: z.string().trim().min(1),
  issuer: z.string().trim().nullish(),
  issuedDate: z.string().regex(dateRe).nullish(),
  expiryDate: z.string().regex(dateRe).nullish(),
})

const workHistorySchema = z.object({
  company: z.string().trim().min(1),
  title: z.string().trim().nullish(),
  startDate: z.string().regex(dateRe).nullish(),
  endDate: z.string().regex(dateRe).nullish(),
  description: z.string().trim().nullish(),
})

// Whole days of tenure from hire_date to today (>= 0), or null when unknown.
function seniorityDays(hireDate: string | null): number | null {
  if (!hireDate) return null
  const ms = Date.now() - new Date(hireDate).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.floor(ms / 86_400_000)
}

// Tenure in years to 1 decimal (年資 style, e.g. 1.3), or null.
function seniorityYears(hireDate: string | null): number | null {
  const days = seniorityDays(hireDate)
  if (days == null) return null
  return Math.round((days / 365) * 10) / 10
}

async function signedUrl(storagePath: string | null): Promise<string | null> {
  if (!storagePath) return null
  const { data } = await supabaseAdmin.storage
    .from(DOCUMENT_BUCKET)
    .createSignedUrl(storagePath, 3600)
  return data?.signedUrl ?? null
}

function decodeUpload(input: z.infer<typeof uploadSchema>): Buffer | null {
  try {
    const bytes = Buffer.from(input.dataBase64, "base64")
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return null
    return bytes
  } catch {
    return null
  }
}

async function uploadDocument(
  tenantId: string,
  employeeId: string,
  folder: string,
  input: z.infer<typeof uploadSchema>,
): Promise<{ fileName: string; storagePath: string; sizeBytes: number; contentType: string } | null> {
  const bytes = decodeUpload(input)
  if (!bytes) return null
  const ext = (input.fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0]
  const storagePath = `${tenantId}/${employeeId}/${folder}/${crypto.randomUUID()}${ext}`
  const { error } = await supabaseAdmin.storage
    .from(DOCUMENT_BUCKET)
    .upload(storagePath, bytes, { contentType: input.contentType })
  if (error) throw new Error(`employee document upload: ${error.message}`)
  return {
    fileName: input.fileName,
    storagePath,
    sizeBytes: bytes.length,
    contentType: input.contentType,
  }
}

/**
 * GET /employees/:empId/profile — the aggregate My Data view (基本/通訊/學歷證照/
 * 工作經歷/年資). Self-or-HR only; tenant-scoped. Returns null `profile` when the
 * 1:1 row does not exist yet.
 */
employeeProfileRouter.get(
  "/employees/:empId/profile",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const empId = req.params.empId as string
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    try {
      const auth = await authorize(tenantId, userId, empId)
      if (!auth) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      const [basic, profile, educations, certifications, workHistory, jobHistory] =
        await Promise.all([
        supabaseAdmin
          .from("employees")
          .select("id, name, emp_no, dept_id, employment_type, hire_date, role, status")
          .eq("tenant_id", tenantId)
          .eq("id", empId)
          .maybeSingle(),
        supabaseAdmin
          .from("employee_profiles")
          .select(PROFILE_SELECT)
          .eq("tenant_id", tenantId)
          .eq("employee_id", empId)
          .maybeSingle(),
        supabaseAdmin
          .from("employee_educations")
          .select(EDUCATION_SELECT)
          .eq("tenant_id", tenantId)
          .eq("employee_id", empId)
          .order("start_date", { ascending: false }),
        supabaseAdmin
          .from("employee_certifications")
          .select(CERTIFICATION_SELECT)
          .eq("tenant_id", tenantId)
          .eq("employee_id", empId)
          .order("issued_date", { ascending: false }),
        supabaseAdmin
          .from("employee_work_history")
          .select("id, company, title, start_date, end_date, description")
          .eq("tenant_id", tenantId)
          .eq("employee_id", empId)
          .order("start_date", { ascending: false }),
        supabaseAdmin
          .from("employee_job_history")
          .select("id, effective_date, action, dept_id, dept_name, grade, title")
          .eq("tenant_id", tenantId)
          .eq("employee_id", empId)
          .order("effective_date", { ascending: false }),
      ])

      if (!basic.data) {
        res.status(404).json({ error: "not_found" })
        return
      }

      let profileData = profile.data as Record<string, unknown> | null
      let educationRows = (educations.data ?? []) as Array<Record<string, unknown>>
      let certificationRows = (certifications.data ?? []) as Array<Record<string, unknown>>
      // If production receives the app before migration 0021 has run, keep the
      // legacy My Data page usable by retrying without the new document columns.
      if (profile.error) {
        const fallback = await supabaseAdmin
          .from("employee_profiles")
          .select(PROFILE_SELECT_BASE)
          .eq("tenant_id", tenantId)
          .eq("employee_id", empId)
          .maybeSingle()
        profileData = (fallback.data as Record<string, unknown> | null) ?? null
      }
      if (educations.error) {
        const fallback = await supabaseAdmin
          .from("employee_educations")
          .select(EDUCATION_SELECT_BASE)
          .eq("tenant_id", tenantId)
          .eq("employee_id", empId)
          .order("start_date", { ascending: false })
        educationRows = (fallback.data ?? []) as Array<Record<string, unknown>>
      }
      if (certifications.error) {
        const fallback = await supabaseAdmin
          .from("employee_certifications")
          .select(CERTIFICATION_SELECT_BASE)
          .eq("tenant_id", tenantId)
          .eq("employee_id", empId)
          .order("issued_date", { ascending: false })
        certificationRows = (fallback.data ?? []) as Array<Record<string, unknown>>
      }

      const hireDate = (basic.data.hire_date as string | null) ?? null
      // 單位年資: years since the latest dept-changing entry (or hire) — the most
      // recent job-history row with a dept is when the current unit began.
      const unitStart =
        (jobHistory.data ?? []).find((j) => j.dept_id || j.dept_name)?.effective_date ?? hireDate
      // 職等年資: years since the latest grade-bearing job-history entry.
      const gradeStart =
        (jobHistory.data ?? []).find((j) => typeof j.grade === "string" && j.grade.trim().length > 0)
          ?.effective_date ?? null
      res.status(200).json({
        basic: basic.data,
        profile: profileData
          ? {
              ...profileData,
              photo_url: await signedUrl((profileData.photo_storage_path as string | null) ?? null),
            }
          : null,
        educations: await Promise.all(
          educationRows.map(async (row) => ({
            ...row,
            proof_url: await signedUrl((row.proof_storage_path as string | null) ?? null),
          })),
        ),
        certifications: await Promise.all(
          certificationRows.map(async (row) => ({
            ...row,
            attachment_url: await signedUrl((row.attachment_storage_path as string | null) ?? null),
          })),
        ),
        workHistory: workHistory.data ?? [],
        jobHistory: jobHistory.data ?? [],
        seniorityDays: seniorityDays(hireDate),
        seniority: {
          internalYears: seniorityYears(hireDate),
          gradeYears: seniorityYears((gradeStart as string | null) ?? null),
          unitYears: seniorityYears((unitStart as string | null) ?? null),
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * 員工自改資料的審核路徑（W6）。
 *
 * `features.formParameters.myDataRequiresApproval` 存在設定裡卻一次都沒被讀過
 * （計畫 §1b W6）。開啟後，**非 HR** 對自己 profile 的異動不再直接落庫：
 *   1. 只比對**真的有變**的欄位（送了但沒改的欄不算，前端整個分頁送出很正常）；
 *   2. 有變的欄不在 `editableFields` 白名單內 → 403 `field_not_editable`；
 *   3. 其餘存成一列 pending 的 `employee_profile_change_requests` 並通知 HR → 202。
 * HR 自己改（含代員工改）不受影響：審核的是「員工自填」，不是 HR 的維護動作。
 */
async function submitProfileChangeRequest(opts: {
  tenantId: string
  empId: string
  requestedByEmpId: string
  next: Record<string, unknown>
}): Promise<
  | { kind: "forbidden"; fields: string[] }
  | { kind: "no_changes" }
  | { kind: "queued"; changeRequestId: string; fields: string[] }
> {
  const { tenantId, empId, next } = opts

  const { data: current } = await supabaseAdmin
    .from("employee_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("employee_id", empId)
    .maybeSingle()

  const changes = diffProfile((current as Record<string, unknown> | null) ?? {}, next)
  const changed = Object.keys(changes)
  if (changed.length === 0) return { kind: "no_changes" }

  const { editableFields } = await loadFormParameters(tenantId)
  const allowed = editableColumns(editableFields)
  const blocked = changed.filter((col) => !allowed.has(col))
  if (blocked.length > 0) return { kind: "forbidden", fields: blocked }

  const { data: row, error } = await supabaseAdmin
    .from("employee_profile_change_requests")
    .insert({
      tenant_id: tenantId,
      employee_id: empId,
      requested_by_emp_id: opts.requestedByEmpId,
      changes,
      status: "pending",
    })
    .select("id")
    .single()
  if (error || !row) throw new Error(`submit profile change request: ${error?.message}`)

  const { data: hr } = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .in("role", ["hr_admin", "platform_admin"])
  const { data: who } = await supabaseAdmin
    .from("employees")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("id", empId)
    .maybeSingle()

  await enqueue({
    tenantId,
    employeeIds: (hr ?? []).map((e) => e.id as string),
    type: "profile_change_request",
    title: `${(who?.name as string) ?? "員工"} 送出資料異動待審`,
    body: `異動欄位：${changed.map(columnLabel).join("、")}`,
    payload: { changeRequestId: row.id, employeeId: empId, fields: changed },
  })

  return { kind: "queued", changeRequestId: row.id as string, fields: changed }
}

// PUT /employees/:empId/profile — upsert the 1:1 contact profile (self-or-HR).
employeeProfileRouter.put(
  "/employees/:empId/profile",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const empId = req.params.empId as string
    if (!userId) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    const parsed = profileSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const auth = await authorize(tenantId, userId, empId)
      if (!auth) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const d = parsed.data
      // Partial semantics: a key absent from the body (undefined) is left
      // untouched; an explicit null clears the column. Prevents a tab that only
      // edits 通訊資料 from wiping the 基本資料 fields (and vice versa).
      const FIELD_TO_COL: Record<string, string> = {
        firstName: "first_name",
        lastName: "last_name",
        englishName: "english_name",
        nationality: "nationality",
        idType: "id_type",
        idNumber: "id_number",
        idExpiry: "id_expiry",
        idType2: "id_type2",
        idNumber2: "id_number2",
        idExpiry2: "id_expiry2",
        idType3: "id_type3",
        idNumber3: "id_number3",
        idExpiry3: "id_expiry3",
        entryDate: "entry_date",
        birthday: "birthday",
        gender: "gender",
        maritalStatus: "marital_status",
        phone: "phone",
        phoneMobile2: "phone_mobile2",
        phoneLandline: "phone_landline",
        registeredAddress: "registered_address",
        address: "address",
        companyEmail: "company_email",
        personalEmail: "personal_email",
        lineUserId: "line_user_id",
        emergencyContact: "emergency_contact",
        emergencyRelationship: "emergency_relationship",
        emergencyPhone: "emergency_phone",
        note: "note",
      }
      const patch: Record<string, unknown> = {}
      for (const [field, col] of Object.entries(FIELD_TO_COL)) {
        const v = (d as Record<string, unknown>)[field]
        if (v !== undefined) patch[col] = v
      }

      // W6：非 HR＋租戶開了審核 → 轉成待審單，profile 本身不動。
      if (!auth.isHr && (await loadFormParameters(tenantId)).myDataRequiresApproval) {
        const outcome = await submitProfileChangeRequest({
          tenantId,
          empId,
          requestedByEmpId: auth.selfId,
          next: patch,
        })
        if (outcome.kind === "forbidden") {
          res.status(403).json({
            error: "field_not_editable",
            fields: outcome.fields,
            message: `這些欄位需由 HR 修改：${outcome.fields.map(columnLabel).join("、")}`,
          })
          return
        }
        if (outcome.kind === "no_changes") {
          res.status(200).json({ id: null, changed: 0 })
          return
        }
        res.status(202).json({ changeRequestId: outcome.changeRequestId, fields: outcome.fields })
        return
      }

      const row: Record<string, unknown> = {
        ...patch,
        tenant_id: tenantId,
        employee_id: empId,
        updated_at: new Date().toISOString(),
      }
      let { data, error } = await supabaseAdmin
        .from("employee_profiles")
        .upsert(row, { onConflict: "tenant_id,employee_id" })
        .select("id")
        .single()
      if (error && ("first_name" in row || "last_name" in row)) {
        delete row.first_name
        delete row.last_name
        const retry = await supabaseAdmin
          .from("employee_profiles")
          .upsert(row, { onConflict: "tenant_id,employee_id" })
          .select("id")
          .single()
        data = retry.data
        error = retry.error
      }
      if (error || !data) {
        next(new Error(`PUT /employees/${empId}/profile: ${error?.message}`))
        return
      }
      res.status(200).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)

employeeProfileRouter.post(
  "/employees/:empId/profile/photo",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId ?? NIL
    const empId = req.params.empId as string
    const parsed = uploadSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const auth = await authorize(tenantId, userId, empId)
      if (!auth) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const uploaded = await uploadDocument(tenantId, empId, "profile-photo", parsed.data)
      if (!uploaded) {
        res.status(413).json({ error: "file_too_large", maxBytes: MAX_FILE_BYTES })
        return
      }
      const { data: current } = await supabaseAdmin
        .from("employee_profiles")
        .select("photo_storage_path")
        .eq("tenant_id", tenantId)
        .eq("employee_id", empId)
        .maybeSingle()
      const { data, error } = await supabaseAdmin
        .from("employee_profiles")
        .upsert(
          {
            tenant_id: tenantId,
            employee_id: empId,
            photo_file_name: uploaded.fileName,
            photo_storage_path: uploaded.storagePath,
            photo_size_bytes: uploaded.sizeBytes,
            photo_content_type: uploaded.contentType,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,employee_id" },
        )
        .select("id")
        .single()
      if (error || !data) {
        await supabaseAdmin.storage.from(DOCUMENT_BUCKET).remove([uploaded.storagePath])
        next(new Error(`POST /employees/${empId}/profile/photo: ${error?.message}`))
        return
      }
      const oldPath = (current?.photo_storage_path as string | null) ?? null
      if (oldPath) await supabaseAdmin.storage.from(DOCUMENT_BUCKET).remove([oldPath])
      res.status(201).json({ id: data.id, photoUrl: await signedUrl(uploaded.storagePath) })
    } catch (err) {
      next(err)
    }
  },
)

employeeProfileRouter.delete(
  "/employees/:empId/profile/photo",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId ?? NIL
    const empId = req.params.empId as string
    try {
      const auth = await authorize(tenantId, userId, empId)
      if (!auth) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const { data: current } = await supabaseAdmin
        .from("employee_profiles")
        .select("photo_storage_path")
        .eq("tenant_id", tenantId)
        .eq("employee_id", empId)
        .maybeSingle()
      const oldPath = (current?.photo_storage_path as string | null) ?? null
      const { error } = await supabaseAdmin
        .from("employee_profiles")
        .update({
          photo_file_name: null,
          photo_storage_path: null,
          photo_size_bytes: null,
          photo_content_type: null,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("employee_id", empId)
      if (error) {
        next(new Error(`DELETE /employees/${empId}/profile/photo: ${error.message}`))
        return
      }
      if (oldPath) await supabaseAdmin.storage.from(DOCUMENT_BUCKET).remove([oldPath])
      res.status(200).json({ id: empId })
    } catch (err) {
      next(err)
    }
  },
)

// Generic factory for the three list-type sub-resources (educations /
// certifications / work-history): POST creates a row for :empId, DELETE removes
// a row by its own id. Both self-or-HR and tenant-scoped.
function listResource<S extends z.ZodTypeAny>(
  segment: string,
  table: string,
  schema: S,
  toRow: (d: z.infer<S>) => Record<string, unknown>,
  storageColumn?: string,
) {
  employeeProfileRouter.post(
    `/employees/:empId/${segment}`,
    requireAuth,
    requireTenant,
    async (req: Request, res: Response, next: NextFunction) => {
      const tenantId = res.locals.tenantId as string
      const userId = req.auth?.userId ?? NIL
      const empId = req.params.empId as string
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
        return
      }
      try {
        const auth = await authorize(tenantId, userId, empId)
        if (!auth) {
          res.status(403).json({ error: "forbidden" })
          return
        }
        const { data, error } = await supabaseAdmin
          .from(table)
          .insert({ tenant_id: tenantId, employee_id: empId, ...toRow(parsed.data) })
          .select("id")
          .single()
        if (error || !data) {
          next(new Error(`POST /employees/${empId}/${segment}: ${error?.message}`))
          return
        }
        res.status(201).json({ id: data.id })
      } catch (err) {
        next(err)
      }
    },
  )

  employeeProfileRouter.delete(
    `/${segment}/:id`,
    requireAuth,
    requireTenant,
    async (req: Request, res: Response, next: NextFunction) => {
      const tenantId = res.locals.tenantId as string
      const userId = req.auth?.userId ?? NIL
      const id = req.params.id
      try {
        // Load the row to learn its employee_id, then authorize against it.
        const { data: row, error: rowErr } = await supabaseAdmin
          .from(table)
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .maybeSingle()
        if (rowErr) {
          next(new Error(`DELETE /${segment}/${id} (load): ${rowErr.message}`))
          return
        }
        if (!row) {
          res.status(404).json({ error: "not_found" })
          return
        }
        const auth = await authorize(tenantId, userId, (row as unknown as Record<string, unknown>).employee_id as string)
        if (!auth) {
          res.status(403).json({ error: "forbidden" })
          return
        }
        const { error: delErr } = await supabaseAdmin
          .from(table)
          .delete()
          .eq("tenant_id", tenantId)
          .eq("id", id)
        if (delErr) {
          next(new Error(`DELETE /${segment}/${id}: ${delErr.message}`))
          return
        }
        const oldPath = storageColumn ? (((row as unknown as Record<string, unknown>)[storageColumn] as string | null) ?? null) : null
        if (oldPath) await supabaseAdmin.storage.from(DOCUMENT_BUCKET).remove([oldPath])
        res.status(200).json({ id })
      } catch (err) {
        next(err)
      }
    },
  )
}

function resourceAttachment(segment: string, table: string, columns: {
  fileName: string
  storagePath: string
  sizeBytes: string
  contentType: string
  urlKey: string
}) {
  employeeProfileRouter.post(
    `/${segment}/:id/attachment`,
    requireAuth,
    requireTenant,
    async (req: Request, res: Response, next: NextFunction) => {
      const tenantId = res.locals.tenantId as string
      const userId = req.auth?.userId ?? NIL
      const id = req.params.id
      const parsed = uploadSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
        return
      }
      try {
        const { data: row, error: rowErr } = await supabaseAdmin
          .from(table)
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .maybeSingle()
        if (rowErr) {
          next(new Error(`POST /${segment}/${id}/attachment (load): ${rowErr.message}`))
          return
        }
        if (!row) {
          res.status(404).json({ error: "not_found" })
          return
        }
        const employeeId = (row as unknown as Record<string, unknown>).employee_id as string
        const auth = await authorize(tenantId, userId, employeeId)
        if (!auth) {
          res.status(403).json({ error: "forbidden" })
          return
        }
        const uploaded = await uploadDocument(tenantId, employeeId, `${segment}/${id}`, parsed.data)
        if (!uploaded) {
          res.status(413).json({ error: "file_too_large", maxBytes: MAX_FILE_BYTES })
          return
        }
        const { error } = await supabaseAdmin
          .from(table)
          .update({
            [columns.fileName]: uploaded.fileName,
            [columns.storagePath]: uploaded.storagePath,
            [columns.sizeBytes]: uploaded.sizeBytes,
            [columns.contentType]: uploaded.contentType,
          })
          .eq("tenant_id", tenantId)
          .eq("id", id)
        if (error) {
          await supabaseAdmin.storage.from(DOCUMENT_BUCKET).remove([uploaded.storagePath])
          next(new Error(`POST /${segment}/${id}/attachment: ${error.message}`))
          return
        }
        const oldPath = ((row as unknown as Record<string, unknown>)[columns.storagePath] as string | null) ?? null
        if (oldPath) await supabaseAdmin.storage.from(DOCUMENT_BUCKET).remove([oldPath])
        res.status(201).json({ id, [columns.urlKey]: await signedUrl(uploaded.storagePath) })
      } catch (err) {
        next(err)
      }
    },
  )

  employeeProfileRouter.delete(
    `/${segment}/:id/attachment`,
    requireAuth,
    requireTenant,
    async (req: Request, res: Response, next: NextFunction) => {
      const tenantId = res.locals.tenantId as string
      const userId = req.auth?.userId ?? NIL
      const id = req.params.id
      try {
        const { data: row, error: rowErr } = await supabaseAdmin
          .from(table)
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("id", id)
          .maybeSingle()
        if (rowErr) {
          next(new Error(`DELETE /${segment}/${id}/attachment (load): ${rowErr.message}`))
          return
        }
        if (!row) {
          res.status(404).json({ error: "not_found" })
          return
        }
        const auth = await authorize(tenantId, userId, (row as unknown as Record<string, unknown>).employee_id as string)
        if (!auth) {
          res.status(403).json({ error: "forbidden" })
          return
        }
        const { error } = await supabaseAdmin
          .from(table)
          .update({
            [columns.fileName]: null,
            [columns.storagePath]: null,
            [columns.sizeBytes]: null,
            [columns.contentType]: null,
          })
          .eq("tenant_id", tenantId)
          .eq("id", id)
        if (error) {
          next(new Error(`DELETE /${segment}/${id}/attachment: ${error.message}`))
          return
        }
        const oldPath = ((row as unknown as Record<string, unknown>)[columns.storagePath] as string | null) ?? null
        if (oldPath) await supabaseAdmin.storage.from(DOCUMENT_BUCKET).remove([oldPath])
        res.status(200).json({ id })
      } catch (err) {
        next(err)
      }
    },
  )
}

listResource("educations", "employee_educations", educationSchema, (d) => ({
  school: d.school,
  is_highest: d.isHighest ?? false,
  major_category: d.majorCategory ?? null,
  major: d.major ?? null,
  degree: d.degree ?? null,
  study_type: d.studyType ?? null,
  study_status: d.studyStatus ?? null,
  region: d.region ?? null,
  start_date: d.startDate ?? null,
  end_date: d.endDate ?? null,
}), "proof_storage_path")

listResource("certifications", "employee_certifications", certificationSchema, (d) => ({
  name: d.name,
  issuer: d.issuer ?? null,
  issued_date: d.issuedDate ?? null,
  expiry_date: d.expiryDate ?? null,
}), "attachment_storage_path")

listResource("work-history", "employee_work_history", workHistorySchema, (d) => ({
  company: d.company,
  title: d.title ?? null,
  start_date: d.startDate ?? null,
  end_date: d.endDate ?? null,
  description: d.description ?? null,
}))

resourceAttachment("educations", "employee_educations", {
  fileName: "proof_file_name",
  storagePath: "proof_storage_path",
  sizeBytes: "proof_size_bytes",
  contentType: "proof_content_type",
  urlKey: "proofUrl",
})

resourceAttachment("certifications", "employee_certifications", {
  fileName: "attachment_file_name",
  storagePath: "attachment_storage_path",
  sizeBytes: "attachment_size_bytes",
  contentType: "attachment_content_type",
  urlKey: "attachmentUrl",
})

/**
 * POST /employees/:empId/job-history — HR records a 職務經歷 entry (新進/晉升/
 * 調部門/資料調整…). HR-only (unlike the self-editable lists above): employees
 * read their history via the profile aggregate but cannot rewrite it.
 */
const jobHistorySchema = z.object({
  effectiveDate: z.string().regex(dateRe),
  action: z.string().trim().min(1),
  deptId: z.string().uuid().nullish(),
  deptName: z.string().trim().nullish(),
  grade: z.string().trim().nullish(),
  title: z.string().trim().nullish(),
})

employeeProfileRouter.post(
  "/employees/:empId/job-history",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId ?? NIL
    const empId = req.params.empId as string
    const parsed = jobHistorySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const auth = await authorize(tenantId, userId, empId)
      if (!auth || !auth.isHr) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      const d = parsed.data
      const { data, error } = await supabaseAdmin
        .from("employee_job_history")
        .insert({
          tenant_id: tenantId,
          employee_id: empId,
          effective_date: d.effectiveDate,
          action: d.action,
          dept_id: d.deptId ?? null,
          dept_name: d.deptName ?? null,
          grade: d.grade ?? null,
          title: d.title ?? null,
        })
        .select("id")
        .single()
      if (error || !data) {
        next(new Error(`POST /employees/${empId}/job-history: ${error?.message}`))
        return
      }
      res.status(201).json({ id: data.id })
    } catch (err) {
      next(err)
    }
  },
)
