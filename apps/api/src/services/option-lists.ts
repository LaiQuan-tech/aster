import { supabaseAdmin } from "../lib/supabase.js"
import { FINANCE_ROLES } from "../middleware/scope.js"
import { catalogCode } from "./catalog-code.js"

/**
 * 全站共用的「選項清單」機制（2026-10-10 業主要求：客戶分類要能讓管理員自己新增，之後廠商分類、
 * 學歷類別、職務異動類型、節慶獎金節日…都用同一套）。
 *
 * ── 資料 ──────────────────────────────────────────────────────────────────
 * 表 `option_items`（packages/db sql/0048）：(tenant_id, list_key, code) 唯一、(tenant_id, list_key, label) 唯一。
 * 業務資料列上存的是 **code**（穩定，改名不影響舊資料），畫面顯示 **label**。
 *
 * ── 規則 ──────────────────────────────────────────────────────────────────
 *   • 新增、改名、調整順序、停用都在 `PUT /option-lists/:key`（整批 upsert）；**PUT 不刪除**。
 *   • 停用＝新單據的下拉不再出現，舊資料照常顯示原名稱；寫入時只擋「新選或改選到」停用／不存在的選項，
 *     沿用原值不擋（`checkOptionPick`），否則舊資料連備註都改不了。
 *   • 沒被任何資料用過的選項才可以刪（`DELETE /option-lists/:key/:code`）；「用過」＝登記表 `usage`
 *     指到的欄位裡有任何一列存著這個 code，**所有列都算**（含已軟刪、已封存、已作廢的列）。
 *   • 租戶的某個清單**一列都沒有**時，第一次讀取會補種登記表的 `defaults`（ON CONFLICT DO NOTHING，
 *     可並發安全）。
 *
 * ── 要掛一個新清單 ─────────────────────────────────────────────────────────
 *   1. 在下方 `OPTION_LISTS` 加一筆 `OptionListDef`（key／title／description／defaults／usage／manageRoles）。
 *   2. 寫入該欄位的路由，新選值前呼叫 `checkOptionPick(tenantId, def, picked, stored)`，
 *      回 "unknown"／"inactive" 時回 400（clients 路由是範例）。
 *   3. 畫面端用 `useOptionList(key)`（apps/web/src/lib/option-lists-api.ts）取選項；後台
 *      「設定 → 選項清單」頁會自動出現這個清單，不用改。
 */

/** 預設項目：code 一經發佈就不能改（業務資料存的是它）。 */
export type OptionListDefault = { code: string; label: string; sortOrder: number }

/**
 * 「使用」來源：這個資料表的這個欄位存著清單的 code。計數涵蓋該租戶**所有列**（不分 deleted_at 等狀態）。
 * 資料表要有 `id`（主鍵）與 `tenant_id` 欄位。
 */
export type OptionUsageSource = { table: string; column: string }

export type OptionListDef = {
  /** option_items.list_key；也是 URL 的 `:key`。 */
  key: string
  /** 後台「選項清單」頁的卡片標題。 */
  title: string
  /** 卡片說明（一兩句：這份清單用在哪裡、規則）。 */
  description: string
  /** 租戶這份清單沒有任何列時補種的預設項目。 */
  defaults: readonly OptionListDefault[]
  /** 判斷「用過」的欄位；空陣列＝沒有任何資料會引用（永遠可刪）。 */
  usage: readonly OptionUsageSource[]
  /** 可以新增／改名／排序／停用／刪除的角色（employees.role）；讀取不限（登入即可）。 */
  manageRoles: readonly string[]
}

export const CLIENT_CATEGORY_LIST_KEY = "client_category"

export const OPTION_LISTS: readonly OptionListDef[] = [
  {
    key: CLIENT_CATEGORY_LIST_KEY,
    title: "客戶分類",
    description:
      "客戶名冊「分類」欄位的選項（客戶名冊的篩選與表單、建案時快速新增客戶都用這份）。用過的分類只能停用，沒有任何客戶用過的才可以刪除。",
    defaults: [
      { code: "architect", label: "建築師", sortOrder: 10 },
      { code: "engineer", label: "技師", sortOrder: 20 },
      { code: "owner", label: "業主", sortOrder: 30 },
      { code: "gov", label: "政府機關", sortOrder: 40 },
      { code: "other", label: "其他", sortOrder: 50 },
    ],
    usage: [{ table: "clients", column: "category" }],
    // 比照客戶名冊的寫入權限（routes/clients.ts：POST／PATCH 是 requireFinance）。
    manageRoles: FINANCE_ROLES,
  },
]

const LIST_BY_KEY: ReadonlyMap<string, OptionListDef> = new Map(OPTION_LISTS.map((def) => [def.key, def]))

/** 登記表查詢；沒登記的 key 回 undefined（路由回 404）。 */
export function findOptionList(key: string): OptionListDef | undefined {
  return LIST_BY_KEY.get(key)
}

export function canManageOptionList(role: string | null | undefined, def: OptionListDef): boolean {
  return !!role && def.manageRoles.includes(role)
}

/** 選項名稱最長 40 字（與 PUT 的驗證一致）。 */
export const OPTION_LABEL_MAX = 40
/** 單一清單最多幾項（PUT 超過回 400 too_many_items；也確保一次 select 不會撞 PostgREST 的 1000 列上限）。 */
export const OPTION_LIST_MAX_ITEMS = 200

/* ──────────────────────────────────────────────────────────────────
 * 讀取（含補種）
 * ────────────────────────────────────────────────────────────────── */

export type OptionItemRow = { id: string; code: string; label: string; sort_order: number; is_active: boolean }

export type OptionItem = { code: string; label: string; sortOrder: number; isActive: boolean }

const ITEM_COLS = "id, code, label, sort_order, is_active"

export function serializeOptionItem(row: OptionItemRow): OptionItem {
  return { code: row.code, label: row.label, sortOrder: row.sort_order, isActive: row.is_active !== false }
}

async function selectItems(tenantId: string, listKey: string): Promise<OptionItemRow[]> {
  const { data, error } = await supabaseAdmin
    .from("option_items")
    .select(ITEM_COLS)
    .eq("tenant_id", tenantId)
    .eq("list_key", listKey)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .order("code", { ascending: true })
  if (error) throw new Error(`option_items select (${listKey}): ${error.message}`)
  return (data ?? []) as OptionItemRow[]
}

/**
 * 該租戶這份清單的全部項目（含停用的），依 sort_order → created_at → code 排序。
 * 一列都沒有就補種 `def.defaults`（`upsert … ignoreDuplicates` ＝ ON CONFLICT DO NOTHING：兩個請求同時
 * 第一次讀取也只會種一份），然後重讀。已經有任何一列時**不會**再補種——管理員刪掉的預設項目不會自己長回來。
 */
export async function loadOptionItems(tenantId: string, def: OptionListDef): Promise<OptionItemRow[]> {
  const rows = await selectItems(tenantId, def.key)
  if (rows.length > 0 || def.defaults.length === 0) return rows
  const seed = def.defaults.map((item) => ({
    tenant_id: tenantId,
    list_key: def.key,
    code: item.code,
    label: item.label,
    sort_order: item.sortOrder,
    is_active: true,
  }))
  const { error } = await supabaseAdmin
    .from("option_items")
    .upsert(seed, { onConflict: "tenant_id,list_key,code", ignoreDuplicates: true })
  // 23505：另一個請求剛好同時種了（名稱唯一索引不是仲裁索引，競態下可能走到這裡）——有人種好就好，重讀即可。
  if (error && error.code !== "23505") throw new Error(`option_items seed (${def.key}): ${error.message}`)
  return selectItems(tenantId, def.key)
}

/** 單一項目（不補種）；沒有回 null。刪除前讀它來留稽核舊值。 */
export async function loadOptionItem(tenantId: string, listKey: string, code: string): Promise<OptionItemRow | null> {
  const { data, error } = await supabaseAdmin
    .from("option_items")
    .select(ITEM_COLS)
    .eq("tenant_id", tenantId)
    .eq("list_key", listKey)
    .eq("code", code)
    .maybeSingle()
  if (error) throw new Error(`option_items load (${listKey}/${code}): ${error.message}`)
  return (data as OptionItemRow | null) ?? null
}

/* ──────────────────────────────────────────────────────────────────
 * 使用量
 * ────────────────────────────────────────────────────────────────── */

/**
 * PostgREST max-rows＝1000，單次 select 超過會被「靜默」截斷（不是 error）。一頁一頁撈到不滿頁為止——
 * 不分頁的話，使用量大的選項會把別的選項的列擠出第一頁，被誤判成「沒被用過」而允許刪除。
 */
const USAGE_PAGE_SIZE = 1000
/** `.in()` 的 URL 有長度上限，code 分批帶。 */
const USAGE_CODE_CHUNK = 100

/**
 * 每個 code 被引用的筆數（所有列都算，不分 deleted_at）。`codes` 以外的值不會出現在結果裡；
 * 沒被引用的 code 回 0。同一列的兩個欄位指到同一個 code 只算一筆。
 *
 * 查詢出錯一律往上丟（不退成 0）：這個數字決定「能不能刪」，查不到就不能讓人刪。
 */
export async function loadOptionUsage(
  tenantId: string,
  def: OptionListDef,
  codes: readonly string[],
): Promise<Record<string, number>> {
  const wanted = [...new Set(codes)]
  const rowKeysByCode = new Map<string, Set<string>>(wanted.map((code) => [code, new Set<string>()]))
  if (wanted.length > 0) {
    await Promise.all(
      def.usage.map(async (source) => {
        for (let i = 0; i < wanted.length; i += USAGE_CODE_CHUNK) {
          const chunk = wanted.slice(i, i + USAGE_CODE_CHUNK)
          for (let from = 0; ; from += USAGE_PAGE_SIZE) {
            const { data, error } = await supabaseAdmin
              .from(source.table)
              .select(`id, ${source.column}`)
              .eq("tenant_id", tenantId)
              .in(source.column, chunk)
              // 跨頁 .range() 要有穩定排序才保證不重不漏。
              .order("id", { ascending: true })
              .range(from, from + USAGE_PAGE_SIZE - 1)
            if (error) throw new Error(`loadOptionUsage (${def.key}: ${source.table}.${source.column}): ${error.message}`)
            const rows = (data ?? []) as unknown as Array<Record<string, string>>
            for (const row of rows) rowKeysByCode.get(row[source.column] as string)?.add(`${source.table}:${row.id}`)
            if (rows.length < USAGE_PAGE_SIZE) break
          }
        }
      }),
    )
  }
  return Object.fromEntries(wanted.map((code) => [code, rowKeysByCode.get(code)?.size ?? 0]))
}

/* ──────────────────────────────────────────────────────────────────
 * 寫入時驗證：新選或改選的值必須是啟用的選項
 * ────────────────────────────────────────────────────────────────── */

export type OptionPickVerdict = "ok" | "unknown" | "inactive"

/**
 * 這次寫入要存的選項值能不能存。
 *   • 沒選（null／undefined／空字串）→ ok。
 *   • 與資料列上已存的值相同（沿用）→ ok，**即使它已停用或已被刪**——舊資料不該因此改不了別的欄位。
 *   • 新選或改選：必須是這份清單裡**啟用**的 code；停用的回 "inactive"、不存在的回 "unknown"。
 * 只有真的需要比對時才讀清單（沿用或沒選不查 DB）。
 */
export async function checkOptionPick(
  tenantId: string,
  def: OptionListDef,
  picked: string | null | undefined,
  stored?: string | null,
): Promise<OptionPickVerdict> {
  if (!picked) return "ok"
  if (picked === (stored ?? null)) return "ok"
  const hit = (await loadOptionItems(tenantId, def)).find((row) => row.code === picked)
  if (!hit) return "unknown"
  return hit.is_active !== false ? "ok" : "inactive"
}

/* ──────────────────────────────────────────────────────────────────
 * 整批存檔（PUT）的規劃：純函式，不碰 DB
 * ────────────────────────────────────────────────────────────────── */

/**
 * 名稱比對用的正規化：與 catalogCode 同一套（trim、NFKC、轉小寫）。
 * 「ABC」「abc」「ＡＢＣ」視為同一個名稱——人眼看起來就是重複。
 */
export function optionLabelKey(label: string): string {
  return label.trim().normalize("NFKC").toLocaleLowerCase("en-US")
}

/**
 * 新項目的 code：沿用 catalogCode（名稱的穩定雜湊，管理員不必自己取英文代碼）。
 * 撞到已存在的 code 時（例如把「室內設計」改名後，又新增一個叫「室內設計」的項目，雜湊會一樣）
 * 改雜湊「名稱#2」「名稱#3」…，直到不重複。`taken` 要包含同一批已配出去的 code。
 */
export function allocateOptionCode(label: string, taken: ReadonlySet<string>): string {
  const first = catalogCode(label)
  if (!taken.has(first)) return first
  for (let n = 2; ; n += 1) {
    const candidate = catalogCode(`${label}#${n}`)
    if (!taken.has(candidate)) return candidate
  }
}

export type OptionPutItem = { code?: string; label: string; sortOrder?: number; isActive?: boolean }
export type OptionExisting = Pick<OptionItemRow, "code" | "label" | "sort_order" | "is_active">

export type OptionUpdatePatch = { label?: string; sort_order?: number; is_active?: boolean }
export type OptionUpdateStep = { code: string; patch: OptionUpdatePatch }
export type OptionInsertRow = { code: string; label: string; sort_order: number; is_active: boolean }

export type OptionPutPlan =
  | { ok: true; updates: OptionUpdateStep[]; inserts: OptionInsertRow[] }
  | { ok: false; error: "not_found"; code: string }
  | { ok: false; error: "duplicate_item"; code: string }
  | { ok: false; error: "label_taken"; label: string }
  | { ok: false; error: "too_many_items" }

/**
 * 暫名：互換名稱時先把其中一筆挪到這個暫名，騰出它原本的名稱。不能含 NUL（Postgres text 不收），
 * 用一個一般輸入打不出來的符號開頭，並確認清單裡沒有人叫這個名字。
 */
function temporaryLabel(code: string, held: ReadonlyMap<string, string>): string {
  let label = `⟲${code}`
  while (held.has(label)) label += "′"
  return label
}

/**
 * 把「改名」排成不會在中途撞到名稱唯一索引的順序。DB 的唯一索引是逐列即時檢查的：
 * 甲→乙、乙→丙（或甲乙互換）若照 payload 順序寫，第一筆就會撞到還沒改名的那一筆。
 * 作法：目標名稱目前沒人佔著（或就是自己佔著）的先寫；全部卡住（環）時，把其中一筆先改成暫名騰位。
 * 沒有改名的更新（只改順序／停用）不受影響，順序不拘。
 */
function orderUpdates(existing: readonly OptionExisting[], changes: readonly OptionUpdateStep[]): OptionUpdateStep[] {
  const holder = new Map<string, string>() // 名稱 → 目前佔著它的 code
  const current = new Map<string, string>() // code → 目前存的名稱
  for (const row of existing) {
    holder.set(row.label, row.code)
    current.set(row.code, row.label)
  }
  const out: OptionUpdateStep[] = []
  const apply = (step: OptionUpdateStep) => {
    if (step.patch.label !== undefined) {
      const old = current.get(step.code)
      if (old !== undefined && holder.get(old) === step.code) holder.delete(old)
      holder.set(step.patch.label, step.code)
      current.set(step.code, step.patch.label)
    }
    out.push(step)
  }
  const pending = [...changes]
  // 每筆最多被挪去暫名一次、再各寫一次，所以 3 倍足夠；萬一邏輯有漏洞也不會無窮迴圈（退回 payload 順序照寫）。
  let budget = changes.length * 3 + 3
  while (pending.length > 0) {
    if (budget-- <= 0) {
      for (const step of pending.splice(0)) apply(step)
      break
    }
    const index = pending.findIndex(({ code, patch }) => {
      if (patch.label === undefined) return true
      const owner = holder.get(patch.label)
      return owner === undefined || owner === code
    })
    if (index >= 0) {
      apply(pending.splice(index, 1)[0] as OptionUpdateStep)
      continue
    }
    // 全部卡在環裡：第一筆先挪去暫名（它的真正更新仍留在 pending，下一輪就走得通）。
    const stuck = pending[0] as OptionUpdateStep
    apply({ code: stuck.code, patch: { label: temporaryLabel(stuck.code, holder) } })
  }
  return out
}

/**
 * 整批 payload ＋ 現況 → 要寫哪些更新與新增（或第一個錯誤）。不碰 DB，所以寫入前就能擋掉：
 *   • 帶了不存在的 code → not_found；同一個 code 出現兩次 → duplicate_item；
 *   • 套用後名稱重複（正規化後比，見 `optionLabelKey`；只比對「payload 有動到的項目」跟其他項目）→ label_taken；
 *   • 套用後超過 OPTION_LIST_MAX_ITEMS 項 → too_many_items。
 * 更新只列出真的有變的欄位；沒變的項目不產生寫入。新項目沒給 sortOrder 就排在最後（每項加 10）、預設啟用。
 */
export function planOptionPut(existing: readonly OptionExisting[], items: readonly OptionPutItem[]): OptionPutPlan {
  const byCode = new Map(existing.map((row) => [row.code, row]))

  const seen = new Set<string>()
  for (const item of items) {
    if (item.code === undefined) continue
    if (!byCode.has(item.code)) return { ok: false, error: "not_found", code: item.code }
    if (seen.has(item.code)) return { ok: false, error: "duplicate_item", code: item.code }
    seen.add(item.code)
  }

  const created = items.filter((item) => item.code === undefined)
  if (existing.length + created.length > OPTION_LIST_MAX_ITEMS) return { ok: false, error: "too_many_items" }

  // 名稱重複：payload 沒提到的項目維持原名；payload 的項目依序佔名稱，後來的撞到就是重複。
  const owners = new Set<string>()
  for (const row of existing) if (!seen.has(row.code)) owners.add(optionLabelKey(row.label))
  for (const item of items) {
    const key = optionLabelKey(item.label)
    if (owners.has(key)) return { ok: false, error: "label_taken", label: item.label }
    owners.add(key)
  }

  const changes: OptionUpdateStep[] = []
  for (const item of items) {
    if (item.code === undefined) continue
    const row = byCode.get(item.code) as OptionExisting
    const patch: OptionUpdatePatch = {}
    if (item.label !== row.label) patch.label = item.label
    if (item.sortOrder !== undefined && item.sortOrder !== row.sort_order) patch.sort_order = item.sortOrder
    if (item.isActive !== undefined && item.isActive !== row.is_active) patch.is_active = item.isActive
    if (Object.keys(patch).length > 0) changes.push({ code: item.code, patch })
  }

  const takenCodes = new Set(existing.map((row) => row.code))
  let tail = Math.max(0, ...existing.map((row) => row.sort_order), ...items.map((item) => item.sortOrder ?? 0))
  const inserts: OptionInsertRow[] = []
  for (const item of created) {
    const code = allocateOptionCode(item.label, takenCodes)
    takenCodes.add(code)
    tail += 10
    inserts.push({ code, label: item.label, sort_order: item.sortOrder ?? tail, is_active: item.isActive ?? true })
  }

  return { ok: true, updates: orderUpdates(existing, changes), inserts }
}
