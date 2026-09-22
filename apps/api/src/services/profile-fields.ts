/**
 * 員工資料「區塊 → 欄位」對照（W6）。
 *
 * 租戶設定 `features.formParameters.editableFields` 存的是**區塊 key**
 * （basic／contact／education／certification／workHistory），不是欄位名——
 * key 的權威定義在後台設定頁 `apps/web/src/app/admin/module-settings/page.tsx`
 * 的 `FIELD_OPTIONS`（該頁屬 WP4，只讀不改）。本檔把區塊攤成
 * `employee_profiles` 的欄位清單，供 `PUT /employees/:empId/profile` 判斷
 * 「員工自己可不可以改這一欄」。
 *
 * 只涵蓋 1:1 的 `employee_profiles`：education／certification／workHistory 是
 * 各自的子表端點（本輪不納管），列在 SECTION_LABEL 只為了讓設定頁的 key 有
 * 完整對照、也讓未來擴充時不必再回頭改 key 命名。
 *
 * 對照表與 diff 都是純函式（可直接單元測試）；檔案末端另有唯一一處 IO：
 * 讀租戶 `features.formParameters`，讓審核判斷與附件上限只有一份讀法。
 */
import { supabaseAdmin } from "../lib/supabase.js"

/** 設定頁 FIELD_OPTIONS 的 value（順序一致）。 */
export const PROFILE_SECTIONS = [
  "basic",
  "contact",
  "education",
  "certification",
  "workHistory",
] as const

export type ProfileSection = (typeof PROFILE_SECTIONS)[number]

export const SECTION_LABEL: Record<ProfileSection, string> = {
  basic: "基本資料",
  contact: "通訊資料",
  education: "學歷",
  certification: "證照",
  workHistory: "工作經歷",
}

/**
 * 區塊 → `employee_profiles` 欄位（DB 欄名）。
 * 兩份清單合起來＝`routes/employee-profile.ts` 的 `FIELD_TO_COL` 值域，
 * 少一欄就會讓那一欄永遠擋在白名單外，改動兩邊要同步。
 */
export const SECTION_COLUMNS: Record<ProfileSection, readonly string[]> = {
  basic: [
    "first_name",
    "last_name",
    "english_name",
    "nationality",
    "id_type",
    "id_number",
    "id_expiry",
    "id_type2",
    "id_number2",
    "id_expiry2",
    "id_type3",
    "id_number3",
    "id_expiry3",
    "entry_date",
    "birthday",
    "gender",
    "marital_status",
  ],
  contact: [
    "phone",
    "phone_mobile2",
    "phone_landline",
    "registered_address",
    "address",
    "company_email",
    "personal_email",
    "line_user_id",
    "emergency_contact",
    "emergency_relationship",
    "emergency_phone",
    "note",
  ],
  // 子表端點，不在 employee_profiles。
  education: [],
  certification: [],
  workHistory: [],
}

/** 欄位中文標籤（審核單 UI 用；沒列到就回欄名本身）。 */
export const COLUMN_LABEL: Record<string, string> = {
  first_name: "名",
  last_name: "姓",
  english_name: "英文名",
  nationality: "國籍",
  id_type: "證件類別",
  id_number: "證件號碼",
  id_expiry: "證件到期日",
  id_type2: "證件類別 2",
  id_number2: "證件號碼 2",
  id_expiry2: "證件到期日 2",
  id_type3: "證件類別 3",
  id_number3: "證件號碼 3",
  id_expiry3: "證件到期日 3",
  entry_date: "入境日",
  birthday: "生日",
  gender: "性別",
  marital_status: "婚姻狀況",
  phone: "手機",
  phone_mobile2: "手機 2",
  phone_landline: "市話",
  registered_address: "戶籍地址",
  address: "通訊地址",
  company_email: "公司信箱",
  personal_email: "個人信箱",
  line_user_id: "LINE ID",
  emergency_contact: "緊急聯絡人",
  emergency_relationship: "緊急聯絡人關係",
  emergency_phone: "緊急聯絡電話",
  note: "備註",
}

export function columnLabel(col: string): string {
  return COLUMN_LABEL[col] ?? col
}

/** 這個欄位屬於哪個區塊（都不屬於→null）。 */
export function sectionOfColumn(col: string): ProfileSection | null {
  for (const section of PROFILE_SECTIONS) {
    if (SECTION_COLUMNS[section].includes(col)) return section
  }
  return null
}

/**
 * 設定的區塊清單攤成可改欄位集合。
 *
 * `sections` 為 undefined（租戶沒設過）→ 視為**全部可改**，維持開審核前的行為：
 * 「要審核」與「哪些能改」是兩個獨立設定，只開前者不該把所有欄位都鎖死。
 * 設成空陣列才是「一欄都不能自己改」（HR 明示的選擇）。
 */
export function editableColumns(sections: readonly string[] | undefined | null): Set<string> {
  if (sections === undefined || sections === null) {
    return new Set(PROFILE_SECTIONS.flatMap((s) => [...SECTION_COLUMNS[s]]))
  }
  const out = new Set<string>()
  for (const raw of sections) {
    const key = raw.trim() as ProfileSection
    if ((PROFILE_SECTIONS as readonly string[]).includes(key)) {
      for (const col of SECTION_COLUMNS[key]) out.add(col)
    }
  }
  return out
}

/** `{ col: { from, to } }` 的一筆變更。 */
export interface FieldChange {
  from: unknown
  to: unknown
}
export type ProfileChanges = Record<string, FieldChange>

/** 兩個值視為「沒變」：null／undefined／空字串一律當空值比較。 */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === null || v === "" ? null : v)
  return norm(a) === norm(b)
}

/**
 * 只收**真的有變**的欄位，算出 `{ col: { from, to } }`。
 *
 * `next` 的 key 是 DB 欄名，只含呼叫端有帶的欄（undefined 代表沒帶、不動）。
 * `current` 是現行 profile 列（沒有列就傳 `{}`）。
 */
export function diffProfile(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): ProfileChanges {
  const changes: ProfileChanges = {}
  for (const [col, to] of Object.entries(next)) {
    if (to === undefined) continue
    const from = current[col] ?? null
    if (sameValue(from, to)) continue
    changes[col] = { from: from ?? null, to: to ?? null }
  }
  return changes
}

/* ─────────────────────────────────────────────────────────────────────────
 * 以下是唯一的 IO：讀租戶的 `features.formParameters`。
 * 放這裡是因為「這組設定代表什麼」的知識全在本檔，兩個呼叫端
 * （routes/employee-profile.ts 的審核判斷、routes/attachments.ts 的附件上限）
 * 才不會各自抄一份讀法。上面的函式仍是純的，可獨立單元測試。
 * ──────────────────────────────────────────────────────────────────────── */

const DEFAULT_ATTACHMENT_BYTES = 3 * 1024 * 1024

export interface FormParameters {
  /** 員工自己改 My Data 要不要 HR 審核（預設 false＝直接寫入，維持既有行為）。 */
  myDataRequiresApproval: boolean
  /** 可自行修改的區塊；undefined＝沒設過＝全部可改。 */
  editableFields: string[] | undefined
  /** 假單附件上限 KB；undefined＝用預設 3 MB。 */
  attachmentLimitKb: number | undefined
}

export async function loadFormParameters(tenantId: string): Promise<FormParameters> {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("features")
    .eq("id", tenantId)
    .maybeSingle()
  if (error) throw new Error(`loadFormParameters: ${error.message}`)
  const raw = ((data?.features as Record<string, unknown> | null) ?? {}).formParameters
  const fp = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const editable = Array.isArray(fp.editableFields)
    ? (fp.editableFields as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined
  const limit = typeof fp.attachmentLimitKb === "number" && fp.attachmentLimitKb > 0
    ? fp.attachmentLimitKb
    : undefined
  return {
    myDataRequiresApproval: fp.myDataRequiresApproval === true,
    editableFields: editable,
    attachmentLimitKb: limit,
  }
}

/**
 * 假單附件大小上限（bytes）。租戶沒設就是 3 MB（與改動前的硬編值相同）。
 * 設定值讀不到（DB 掛了／欄位還沒套）時一律退回預設，不讓上傳整條路壞掉。
 */
export async function attachmentLimitBytes(tenantId: string): Promise<number> {
  try {
    const { attachmentLimitKb } = await loadFormParameters(tenantId)
    if (!attachmentLimitKb) return DEFAULT_ATTACHMENT_BYTES
    return Math.min(Math.max(Math.floor(attachmentLimitKb), 1), 50_000) * 1024
  } catch {
    return DEFAULT_ATTACHMENT_BYTES
  }
}
