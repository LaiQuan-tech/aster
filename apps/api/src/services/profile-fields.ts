/**
 * 員工資料「區塊 → 欄位」對照（W6）。
 *
 * 租戶設定 `features.formParameters.editableFields` 存的是**區塊 key**
 * （basic／contact／bank／education／certification／workHistory），不是欄位名——
 * key 的清單要與後台設定頁 `apps/web/src/app/admin/module-settings/page.tsx`
 * 的 `FIELD_OPTIONS` 一致（新增區塊兩邊一起改；2026-10 新增 bank）。本檔把區塊攤成
 * `employee_profiles` 的欄位清單，供 `PUT /employees/:empId/profile` 判斷
 * 「員工自己可不可以改這一欄」。
 *
 * 只涵蓋 1:1 的 `employee_profiles`：education／certification／workHistory 是
 * 各自的子表端點（本輪不納管），列在 SECTION_LABEL 只為了讓設定頁的 key 有
 * 完整對照、也讓未來擴充時不必再回頭改 key 命名。
 *
 * bank（匯款帳號）獨立成一個區塊而不併進 basic／contact：租戶若只開放
 * 「基本資料／通訊資料」給員工自改，匯款帳號仍須由 HR 維護（或另外勾選本區塊）；
 * 沒設過 editableFields 的租戶維持「全部可改」的既有語意（審核開啟時；匯款帳號在
 * 審核**關閉**的直接寫入路徑上例外——要 editableFields 明確勾 bank 才放行，見 `bankSelfEditable`）。
 *
 * 對照表與 diff 都是純函式（可直接單元測試）；檔案末端另有唯一一處 IO：
 * 讀租戶 `features.formParameters`，讓審核判斷與附件上限只有一份讀法。
 */
import { supabaseAdmin } from "../lib/supabase.js"

/** 設定頁 FIELD_OPTIONS 的 value（順序一致）。 */
export const PROFILE_SECTIONS = [
  "basic",
  "contact",
  "bank",
  "education",
  "certification",
  "workHistory",
] as const

export type ProfileSection = (typeof PROFILE_SECTIONS)[number]

export const SECTION_LABEL: Record<ProfileSection, string> = {
  basic: "基本資料",
  contact: "通訊資料",
  bank: "匯款帳號",
  education: "學歷",
  certification: "證照",
  workHistory: "工作經歷",
}

/**
 * 區塊 → `employee_profiles` 欄位（DB 欄名）。
 * 各區塊合起來＝`routes/employee-profile.ts` 的 `PROFILE_FIELD_TO_COL` 值域，
 * 少一欄就會讓那一欄永遠擋在白名單外，改動兩邊要同步
 * （__tests__/profile-fields.test.ts 會檢查兩邊一致）。
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
  // 匯款（薪轉）帳號，欄位命名比照 vendors（packages/db 0056）。
  bank: ["bank_code", "bank_name", "bank_account", "account_holder"],
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
  bank_code: "銀行代碼",
  bank_name: "銀行名稱",
  bank_account: "匯款帳號",
  account_holder: "戶名",
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

/**
 * 非 HR 能不能「直接」自改匯款帳號（bank 區塊）——審核**關閉**時 `PUT /employees/:empId/profile`
 * 的唯一一道閘（審核開啟時走 `editableColumns` 的白名單＋送審，不經這裡）。
 *
 * 與 `editableColumns` 刻意不同：那邊「沒設過（undefined）＝全部可改」，但匯款帳號預設由 HR 維護
 * （改了就能把薪轉款項導到別的帳戶），所以這裡必須 `editableFields` **明確**列了 `bank` 才算可自改；
 * 沒設過、空陣列、只勾別的區塊一律不可。key 的正規化（trim、大小寫敏感、只認區塊 key）與
 * `editableColumns` 相同。
 */
export function bankSelfEditable(sections: readonly string[] | undefined | null): boolean {
  return !!sections && sections.some((raw) => raw.trim() === "bank")
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
  /** 可自行修改的區塊；undefined＝沒設過＝全部可改（匯款帳號例外：見 `bankSelfEditable`）。 */
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
