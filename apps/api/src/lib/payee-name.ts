/**
 * 收款戶名／廠商名稱的比對 key 與不可見字元檢查（2026-11-17 第五輪，R3；第八輪拆成 exact 硬擋／similar 需說明兩級）。
 * 放款單（services/disbursements.ts）、廠商名冊（routes/vendors.ts）、副委託整批 PUT（routes/subcontracts.ts）共用。
 */

/** 會讓兩個「看起來一樣」的名稱比對不同的不可見字元：預設可忽略字元、組合符號、點字空白與韓文填充字。 */
const INVISIBLE_CLASS = "\\p{Default_Ignorable_Code_Point}\\p{M}\\u2800\\u3164\\u115F\\u1160\\uFFA0"
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CLASS}]`, "u")
const STRIP_RE = new RegExp(`[\\s\\p{Cf}${INVISIBLE_CLASS}]`, "gu")

/**
 * 名稱含不可見字元（先 NFC 組字，可組合的重音字母不算）→ true。
 * 呼叫端回 400 invalid_payee_name／invalid_vendor_name「名稱含有不可見字元，請重新輸入」。
 */
export function hasInvisibleNameChars(name: string | null | undefined): boolean {
  if (name == null) return false
  return INVISIBLE_RE.test(String(name).normalize("NFC"))
}

export const INVISIBLE_NAME_MESSAGE = "名稱含有不可見字元，請重新輸入"

const SUFFIXES_WITH_PUNCT = [
  "股份有限公司", "有限公司", "(股)", "(株)", "株式会社", "企業社", "工作室", "公司",
  "co.,ltd.", "co.,ltd", "co.ltd.", "co.ltd", "ltd.", "ltd", "limited.", "limited",
  "corporation.", "corporation", "company.", "company", "inc.", "inc", "corp.", "corp", "co.",
  // 第七輪 M1：結尾「行」「社」「號」（測試甲工程行 ≈ 測試甲工程有限公司 → 都是「測試甲工程」）；去後為空則不去。
  "行", "社", "號",
]
const SUFFIXES_BARE = [
  "股份有限公司", "有限公司", "株式会社", "企業社", "工作室", "公司",
  "coltd", "colimited", "ltd", "limited", "corporation", "company", "inc", "corp",
  "行", "社", "號",
]
/** 第六輪（2026-11-17 F2）：開頭也去這些（NFKC 後 ㈱ 已變成 (株)）。 */
const PREFIXES = ["股份有限公司", "有限公司", "(股)", "(株)", "株式会社", "企業社", "工作室"]
const PUNCT_OR_SYMBOL_RE = /[\p{P}\p{S}]/gu
const TRAILING_PUNCT_RE = /[\p{P}\p{S}]$/u
/** 第七輪 M1：去掉 ltd／limited 之後緊接的 co（「Co Ltd」「Co., Limited」）；單獨結尾的 co（Costco）不去。 */
const CO_BEFORE_LTD_RE = /co[.,]*$/u
/** 結尾括號段（NFKC 後全形括號已是半形）：「測試甲有限公司(台中)」。 */
const TRAILING_PAREN_RE = /\([^()]*\)$/u
/** 結尾「-xxx」「/xxx」段（分隔符後最多 6 字）：「測試甲-台中」「測試甲有限公司/王小明」。 */
const TRAILING_SEP_SEGMENT_RE = /[-\u2010-\u2015\u2212/][^-\u2010-\u2015\u2212/]{1,6}$/u
const BRANCH = "分公司"
/** 分公司名稱前面的公司型態字（切在它後面，前面的再交給後綴規則去）。 */
const BRANCH_BOUNDARIES = ["公司", "行", "社", "號", ")"]

const HAN_RE = /\p{Script=Han}/gu
const OTHER_ALNUM_RE = /[\p{L}\p{N}]/gu
/**
 * 第八輪（2026-11-17）相似比對下限：去後綴或去段之後，剩下的（不計標點符號）至少要有 2 個中文字或 3 個拉丁字母／數字，
 * 否則不採用那次去除（保留去除前的 key）。避免「e-Life」「e-Home」去段後都剩「e」、「7-ELEVEN」「7-11」都剩「7」而互撞。
 */
function meetsFloor(key: string): boolean {
  const han = (key.match(HAN_RE) ?? []).length
  if (han >= 2) return true
  const other = (key.match(OTHER_ALNUM_RE) ?? []).length - han
  return other >= 3
}

/**
 * 第七輪 M1：結尾「…分公司」（分公司前最多 6 字為分公司名）。
 * 那 6 字內有公司型態字（公司／行／社／號／")"）→ 切在最後一個之後（「測試甲有限公司台北分公司」→「測試甲有限公司」）；
 * 沒有 → 視前 2 字為地名一起去（「測試甲台北分公司」→「測試甲」），剩不到 1 字就只去「分公司」。
 */
function stripBranch(key: string): string | null {
  if (!key.endsWith(BRANCH)) return null
  const before = [...key.slice(0, -BRANCH.length)]
  if (before.length === 0) return null
  const windowStart = Math.max(0, before.length - 6)
  const windowText = before.slice(windowStart).join("")
  let cut = -1
  for (const b of BRANCH_BOUNDARIES) {
    const at = windowText.lastIndexOf(b)
    if (at >= 0) cut = Math.max(cut, at + b.length)
  }
  if (cut >= 0) {
    // windowText 以 UTF-16 index 切；before 前段原樣接回。
    return before.slice(0, windowStart).join("") + windowText.slice(0, cut)
  }
  return before.length > 2 ? before.slice(0, -2).join("") : before.join("")
}

function stripSuffixes(input: string, suffixes: readonly string[], dropTrailingPunct: boolean, segments: boolean): string {
  let key = input
  for (let changed = true; changed; ) {
    changed = false
    const branch = segments ? stripBranch(key) : null
    if (branch !== null && branch !== key && branch.length > 0 && meetsFloor(branch)) {
      key = branch
      changed = true
      continue
    }
    if (dropTrailingPunct && segments) {
      for (const re of [TRAILING_PAREN_RE, TRAILING_SEP_SEGMENT_RE]) {
        const m = key.match(re)
        if (m && m.index !== undefined && m.index > 0 && meetsFloor(key.slice(0, m.index))) {
          key = key.slice(0, m.index)
          changed = true
          break
        }
      }
      if (changed) continue
    }
    for (const suf of suffixes) {
      if (key.endsWith(suf) && key.length > suf.length && meetsFloor(key.slice(0, -suf.length))) {
        key = key.slice(0, -suf.length)
        if (/^(?:ltd|limited)\.?$/u.test(suf) || suf === "colimited" || suf === "coltd") {
          const co = key.match(CO_BEFORE_LTD_RE)
          if (co && co.index !== undefined && co.index > 0 && meetsFloor(key.slice(0, co.index))) key = key.slice(0, co.index)
        }
        changed = true
        break
      }
    }
    // 後綴後面多打的標點（「測試甲工程行(股).」）：「)」本身是 (股) 的一部分，不在這裡去。
    if (!changed && dropTrailingPunct && key.length > 1 && TRAILING_PUNCT_RE.test(key) && !key.endsWith(")")) {
      key = key.slice(0, -1)
      changed = true
    }
  }
  return key
}

function stripPrefixes(input: string): string {
  let key = input
  for (let changed = true; changed; ) {
    changed = false
    for (const pre of PREFIXES) {
      if (key.startsWith(pre) && key.length > pre.length && meetsFloor(key.slice(pre.length))) {
        key = key.slice(pre.length)
        changed = true
        break
      }
    }
  }
  return key
}

function nameKey(name: string | null | undefined, segments: boolean): string {
  const cleaned = String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/臺/g, "台")
    .replace(STRIP_RE, "")
  let key = stripPrefixes(cleaned)
  key = stripSuffixes(key, SUFFIXES_WITH_PUNCT, true, segments)
  key = stripPrefixes(key)
  const bare = stripSuffixes(key.replace(PUNCT_OR_SYMBOL_RE, ""), SUFFIXES_BARE, false, segments)
  return bare || key || cleaned
}

/**
 * 戶名比對 key：NFKC（全形英數→半形、（股）／㈱→(股)／(株)）→ 小寫 → 臺→台 → 去掉空白、格式字元、不可見字元
 * → 去掉開頭的公司型態字（股份有限公司、有限公司、(股)、(株)、株式会社、企業社、工作室，可疊加）
 * → 去掉結尾「…分公司」、結尾括號段、結尾「-xxx」「/xxx」段（第七輪 M1）
 * → 去掉常見公司後綴（上列＋公司、行、社、號、Co.,Ltd、Ltd、Limited、Inc、Corp、Corporation、Company…，可疊加；
 *   去 Ltd／Limited 後再去緊接的 Co）
 * → 去掉所有標點與符號（\p{P}、\p{S}）→ 再去一次無標點後綴。去完變空字串就退回前一階段的值。
 * 不做簡繁轉換（只有臺／台這一組）。
 */
export function payeeNameKey(name: string | null | undefined): string {
  return nameKey(name, true)
}

/**
 * 第七輪：比對用的所有 key——payeeNameKey（去分公司／括號段／-xxx／/xxx）＋不去這些段的 key（標點直接拿掉）。
 * 兩種都比：「測試甲-台中」≈「測試甲」，同時「測試甲-工程行」≈「測試甲工程行」（不能因為多去一段反而漏擋）。
 * 第八輪：每次去後綴／去段都有下限（剩不到 2 個中文字或 3 個拉丁字母／數字就不去），且這組 key 只用於「相似」（需說明），
 * 硬擋只看 exactNameKey。
 */
export function payeeNameKeys(name: string | null | undefined): string[] {
  if (!(name ?? "").trim()) return []
  return [...new Set([nameKey(name, true), nameKey(name, false)])]
}

const CYRILLIC_GREEK_RE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u

/**
 * 第七輪（原第六輪 F2 只擋拉丁混用）：名稱只要出現西里爾或希臘字母（例：整串西里爾「АВС」看起來像拉丁「ABC」）→ true。
 * 呼叫端回 400 invalid_payee_name／invalid_vendor_name／invalid_subcontract_vendor_name（看起來一樣、比對 key 卻不同，可用來冒用名冊廠商）。
 */
export function hasConfusableScripts(name: string | null | undefined): boolean {
  if (name == null) return false
  return CYRILLIC_GREEK_RE.test(String(name).normalize("NFKC"))
}

export const CONFUSABLE_SCRIPT_NAME_MESSAGE = "名稱含有西里爾或希臘字母，請改用中文或英文字母重新輸入"

/** 名稱不合法的訊息（不可見字元優先）；合法回 null。放款單戶名、名冊名稱／帳戶戶名、副委託名稱共用。 */
export function invalidNameMessage(name: string | null | undefined): string | null {
  if (hasInvisibleNameChars(name)) return INVISIBLE_NAME_MESSAGE
  if (hasConfusableScripts(name)) return CONFUSABLE_SCRIPT_NAME_MESSAGE
  return null
}

/** 第九輪 L-1：exact key 保留的標點（\p{P} 裡仍有辨識意義的 & @ # % *）；\p{S}（+、$、=…）本來就保留。 */
const EXACT_DROP_PUNCT_RE = /(?![&@#%*])\p{P}/gu

/**
 * 第八輪（2026-11-17）「幾乎完全相同」比對 key（硬擋用）：NFKC → 小寫 → 去掉所有空白、格式／不可見字元與標點 → 臺→台。
 * 第九輪 L-1：只去空白與標點，保留符號（\p{S}：+、$、=…）及 & @ # % *——「A&B」與「AB」、「C+」與「C」不再算完全相同
 *（去符號後相同的改由 similarNameKeys 判為相近）。
 * 不去任何公司後綴、不去分公司／括號／-xxx 段。「測試甲 工程行」「ＴＥＳＴ甲工程行」「測試甲工程行。」「臺北甲」＝「台北甲」皆相同；
 * 「測試甲工程行」與「測試甲工程有限公司」不同（那是 similarNameKeys 的事）。空名稱回 ""。
 */
export function exactNameKey(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/臺/g, "台")
    .replace(STRIP_RE, "")
    .replace(EXACT_DROP_PUNCT_RE, "")
}

/** 第九輪 L-1：exact key 再去掉所有符號（第八輪的 exact）。只用於相近級別。 */
function strippedNameKey(name: string | null | undefined): string {
  return exactNameKey(name).replace(PUNCT_OR_SYMBOL_RE, "")
}

/**
 * 第八輪「相似」比對 key（需確認＋原因＋嚴格稽核，不硬擋）：payeeNameKeys（去公司後綴、分公司、括號段、-xxx 段，
 * 有 2 中文字／3 拉丁字元下限）再加上 exactNameKey 與去符號後的 key（第九輪 L-1）。空名稱回 []。
 */
export function similarNameKeys(name: string | null | undefined): string[] {
  const exact = exactNameKey(name)
  if (!exact) return []
  const stripped = strippedNameKey(name)
  return [...new Set([exact, ...(stripped ? [stripped] : []), ...payeeNameKeys(name)])]
}

/**
 * 第九輪 H-1「包含」判斷的長度下限：key（去掉結尾公司型態字後）至少 3 個中文字或 5 個拉丁字母／數字才拿來做子字串比對
 *（「台灣」「工程」「e-Life」「7-11」「有限公司」「工程有限公司」這類短詞／純後綴不觸發）。
 */
export function meetsContainFloor(key: string): boolean {
  // 先去掉結尾的公司型態字再數（「有限公司」「工程有限公司」本身不算有辨識度的名稱）。
  let core = key.replace(PUNCT_OR_SYMBOL_RE, "")
  for (let changed = true; changed; ) {
    changed = false
    for (const suf of SUFFIXES_BARE) {
      if (core.endsWith(suf)) {
        core = core.slice(0, -suf.length)
        changed = true
        break
      }
    }
  }
  const han = (core.match(HAN_RE) ?? []).length
  if (han >= 3) return true
  const other = (core.match(OTHER_ALNUM_RE) ?? []).length - han
  return other >= 5
}

/** 名冊廠商（比對用的欄位）。 */
export type RosterKeyVendor = { id: string; name: string | null; short_name?: string | null; account_holder?: string | null }

/**
 * 一家名冊廠商的比對 key：
 * - exact（硬擋）：第九輪 H-2 起只有「名稱」的 exactNameKey（簡稱、帳戶戶名不再硬擋，只列相近）；
 * - similar（需說明）：名稱／簡稱（≥3 字）／帳戶戶名（等於名稱 key 或 ≥3 字）的 similarNameKeys（含 exact）；
 * - full（第九輪 H-1「包含」的被包含方）：名稱、簡稱、帳戶戶名各自的 exactNameKey 與去符號 key。
 */
export type RosterKeySets = { exact: string[]; similar: string[]; full: string[] }

/**
 * 一家名冊廠商「視為同名／相近」的比對 key（放款「其他」收款、副委託 must_bind_vendor、名冊重名、複製專案共用）。
 * 第八輪拆兩級；第九輪 H-2：exact 只看名稱。
 */
export function rosterVendorKeys(v: Omit<RosterKeyVendor, "id"> & { id?: string }): RosterKeySets {
  const exact = new Set<string>()
  const similar = new Set<string>()
  const full = new Set<string>()
  const nameExact = exactNameKey(v.name)
  const nameSimilar = similarNameKeys(v.name)
  if (nameExact) exact.add(nameExact)
  for (const k of nameSimilar) similar.add(k)
  for (const k of similarNameKeys(v.short_name)) if (keyLength(k) >= 3) similar.add(k)
  for (const k of similarNameKeys(v.account_holder)) if (nameSimilar.includes(k) || keyLength(k) >= 3) similar.add(k)
  for (const k of exact) similar.add(k)
  for (const field of [v.name, v.short_name, v.account_holder]) {
    for (const k of [exactNameKey(field), strippedNameKey(field)]) if (k) full.add(k)
  }
  return { exact: [...exact], similar: [...similar], full: [...full] }
}

/**
 * 第九輪 H-1「包含」：a 的 similar key（過長度下限）是 b 的 full key 的子字串，或反過來 → true。
 * 例：名冊「測試己有限公司」的「測試己」出現在「(台中)測試己有限公司」裡；新名稱「陳大文」出現在名冊「陳大文水電行」裡。
 */
function containsEither(a: Pick<RosterKeySets, "similar" | "full">, b: Pick<RosterKeySets, "similar" | "full">): boolean {
  const inside = (keys: readonly string[], hay: readonly string[]) =>
    keys.some((k) => meetsContainFloor(k) && hay.some((h) => h !== k && h.includes(k)))
  return inside(a.similar, b.full) || inside(b.similar, a.full)
}

/** 新名稱（放款戶名、副委託名稱）比對用的 key 組（exact＝名稱 exact；full＝exact 與去符號 key）。 */
function nameKeySets(name: string | null | undefined): RosterKeySets {
  const exact = exactNameKey(name)
  if (!exact) return { exact: [], similar: [], full: [] }
  const stripped = strippedNameKey(name)
  return { exact: [exact], similar: similarNameKeys(name), full: [...new Set([exact, ...(stripped ? [stripped] : [])])] }
}

/** 名冊 → 兩級 key 索引（key → 撞到的廠商，同一家只列一次）；entries 供「包含」判斷逐家比。 */
export type RosterKeyIndex<T> = { exact: Map<string, T[]>; similar: Map<string, T[]>; entries: Array<{ vendor: T; keys: RosterKeySets }> }

export function buildRosterKeyIndex<T extends RosterKeyVendor>(vendors: readonly T[]): RosterKeyIndex<T> {
  const index: RosterKeyIndex<T> = { exact: new Map(), similar: new Map(), entries: [] }
  const add = (map: Map<string, T[]>, key: string, v: T) => {
    const list = map.get(key) ?? []
    if (!list.includes(v)) list.push(v)
    map.set(key, list)
  }
  for (const v of vendors) {
    const keys = rosterVendorKeys(v)
    for (const key of keys.exact) add(index.exact, key, v)
    for (const key of keys.similar) add(index.similar, key, v)
    index.entries.push({ vendor: v, keys })
  }
  return index
}

/** 名稱撞到的名冊廠商：exact＝名稱幾乎完全相同（硬擋）；similar＝相近但不是 exact（需說明），已排除 exact 裡的廠商。 */
export type RosterKeyMatch<T> = { exact: T[]; similar: T[] }

/**
 * 第九輪 H-1：similar 另加「包含」——名冊廠商的 similar key（≥3 中文字或 ≥5 拉丁字元／數字）出現在新名稱的 exact key 裡，
 * 或新名稱的 similar key（同下限）出現在名冊廠商名稱／簡稱／戶名的 exact key 裡 → 相近。寧可多報相近，不硬擋。
 */
export function rosterKeyMatches<T>(index: RosterKeyIndex<T>, name: string | null | undefined): RosterKeyMatch<T> {
  const exact: T[] = []
  const similar: T[] = []
  const mine = nameKeySets(name)
  if (mine.exact.length === 0) return { exact, similar }
  for (const v of index.exact.get(mine.exact[0]!) ?? []) if (!exact.includes(v)) exact.push(v)
  for (const key of mine.similar) {
    for (const v of index.similar.get(key) ?? []) if (!exact.includes(v) && !similar.includes(v)) similar.push(v)
  }
  for (const { vendor, keys } of index.entries) {
    if (exact.includes(vendor) || similar.includes(vendor)) continue
    if (containsEither(mine, keys)) similar.push(vendor)
  }
  return { exact, similar }
}

/**
 * 兩組 key 集合比對（名冊新增／修改用）：exact 有交集 → "exact"；similar 有交集或「包含」→ "similar"；否則 null。
 * mine 可以只放「這次新增的 key」（自己舊資料沒有的），避免既有撞名卡住無辜方；名稱 exact 有變時呼叫端放整組（第九輪 A）。
 */
export function compareRosterKeySets(mine: RosterKeySets, other: RosterKeySets): "exact" | "similar" | null {
  const otherExact = new Set(other.exact)
  if (mine.exact.some((k) => otherExact.has(k))) return "exact"
  const otherSimilar = new Set(other.similar)
  if (mine.similar.some((k) => otherSimilar.has(k))) return "similar"
  if (containsEither(mine, other)) return "similar"
  return null
}

/** key 的字數（以 code point 計）。 */
export function keyLength(key: string): number {
  return [...key].length
}
