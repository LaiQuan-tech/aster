/**
 * 收款戶名／廠商名稱的比對 key 與不可見字元檢查（2026-11-17 第五輪，R3）。
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
    if (branch !== null && branch !== key && branch.length > 0) {
      key = branch
      changed = true
      continue
    }
    if (dropTrailingPunct && segments) {
      for (const re of [TRAILING_PAREN_RE, TRAILING_SEP_SEGMENT_RE]) {
        const m = key.match(re)
        if (m && m.index !== undefined && m.index > 0) {
          key = key.slice(0, m.index)
          changed = true
          break
        }
      }
      if (changed) continue
    }
    for (const suf of suffixes) {
      if (key.endsWith(suf) && key.length > suf.length) {
        key = key.slice(0, -suf.length)
        if (/^(?:ltd|limited)\.?$/u.test(suf) || suf === "colimited" || suf === "coltd") {
          const co = key.match(CO_BEFORE_LTD_RE)
          if (co && co.index !== undefined && co.index > 0) key = key.slice(0, co.index)
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
      if (key.startsWith(pre) && key.length > pre.length) {
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

/** 名冊廠商（比對用的欄位）。 */
export type RosterKeyVendor = { id: string; name: string | null; short_name?: string | null; account_holder?: string | null }

/**
 * 一家名冊廠商「視為同一家」的比對 key 集合（第六輪統一：放款「其他」收款冒用檢查、副委託 must_bind_vendor 共用）：
 * 名稱 key；簡稱 key（≥3 字）；帳戶戶名 key（等於名稱 key，或 ≥3 字）。第七輪起每個欄位都取 payeeNameKeys 的所有變體。
 */
export function rosterVendorKeys(v: RosterKeyVendor): string[] {
  const out = new Set<string>()
  const nameKeys = payeeNameKeys(v.name)
  for (const k of nameKeys) out.add(k)
  for (const k of payeeNameKeys(v.short_name)) if (keyLength(k) >= 3) out.add(k)
  for (const k of payeeNameKeys(v.account_holder)) if (nameKeys.includes(k) || keyLength(k) >= 3) out.add(k)
  return [...out]
}

/** 名冊 → key 索引（key → 撞到的廠商，同一家只列一次）。 */
export function buildRosterKeyIndex<T extends RosterKeyVendor>(vendors: readonly T[]): Map<string, T[]> {
  const index = new Map<string, T[]>()
  for (const v of vendors) {
    for (const key of rosterVendorKeys(v)) {
      const list = index.get(key) ?? []
      if (!list.includes(v)) list.push(v)
      index.set(key, list)
    }
  }
  return index
}

/** 這個名稱撞到的名冊廠商（沒撞到＝空陣列）。 */
export function rosterKeyMatches<T>(index: Map<string, T[]>, name: string | null | undefined): T[] {
  const out: T[] = []
  for (const key of payeeNameKeys(name)) for (const v of index.get(key) ?? []) if (!out.includes(v)) out.push(v)
  return out
}

/** key 的字數（以 code point 計）。 */
export function keyLength(key: string): number {
  return [...key].length
}
