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
  "co.,ltd.", "co.,ltd", "co.ltd.", "co.ltd", "ltd.", "ltd", "inc.", "inc", "corp.", "corp", "co.",
]
const SUFFIXES_BARE = ["股份有限公司", "有限公司", "株式会社", "企業社", "工作室", "公司", "coltd", "ltd", "inc", "corp"]
/** 第六輪（2026-11-17 F2）：開頭也去這些（NFKC 後 ㈱ 已變成 (株)）。 */
const PREFIXES = ["股份有限公司", "有限公司", "(股)", "(株)", "株式会社", "企業社", "工作室"]
const PUNCT_OR_SYMBOL_RE = /[\p{P}\p{S}]/gu
const TRAILING_PUNCT_RE = /[\p{P}\p{S}]$/u

function stripSuffixes(input: string, suffixes: readonly string[], dropTrailingPunct: boolean): string {
  let key = input
  for (let changed = true; changed; ) {
    changed = false
    for (const suf of suffixes) {
      if (key.endsWith(suf) && key.length > suf.length) {
        key = key.slice(0, -suf.length)
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

/**
 * 戶名比對 key：NFKC（全形英數→半形、（股）／㈱→(股)／(株)）→ 小寫 → 臺→台 → 去掉空白、格式字元、不可見字元
 * → 去掉開頭的公司型態字（股份有限公司、有限公司、(股)、(株)、株式会社、企業社、工作室，可疊加）
 * → 去掉常見公司後綴（上列＋公司、Co.,Ltd、Ltd、Inc、Corp…，可疊加）
 * → 去掉所有標點與符號（\p{P}、\p{S}）→ 再去一次無標點後綴。去完變空字串就退回前一階段的值。「行號」等不去。
 * 不做簡繁轉換（只有臺／台這一組）。
 */
export function payeeNameKey(name: string | null | undefined): string {
  const cleaned = String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/臺/g, "台")
    .replace(STRIP_RE, "")
  let key = stripPrefixes(cleaned)
  key = stripSuffixes(key, SUFFIXES_WITH_PUNCT, true)
  key = stripPrefixes(key)
  const bare = stripSuffixes(key.replace(PUNCT_OR_SYMBOL_RE, ""), SUFFIXES_BARE, false)
  return bare || key || cleaned
}

const LATIN_RE = /\p{Script=Latin}/u
const CYRILLIC_GREEK_RE = /[\p{Script=Cyrillic}\p{Script=Greek}]/u

/**
 * 第六輪（F2）：名稱同時含拉丁字母與西里爾或希臘字母（例：拉丁 "ABC" 混西里爾 "А"）→ true。
 * 呼叫端回 400 invalid_payee_name／invalid_vendor_name（看起來一樣、比對 key 卻不同，可用來冒用名冊廠商）。
 */
export function hasMixedConfusableScripts(name: string | null | undefined): boolean {
  if (name == null) return false
  const s = String(name).normalize("NFKC")
  return LATIN_RE.test(s) && CYRILLIC_GREEK_RE.test(s)
}

export const MIXED_SCRIPT_NAME_MESSAGE = "名稱混用拉丁字母與西里爾／希臘字母，請重新輸入"

/** 名稱不合法的訊息（不可見字元優先）；合法回 null。放款單戶名、名冊名稱／帳戶戶名共用。 */
export function invalidNameMessage(name: string | null | undefined): string | null {
  if (hasInvisibleNameChars(name)) return INVISIBLE_NAME_MESSAGE
  if (hasMixedConfusableScripts(name)) return MIXED_SCRIPT_NAME_MESSAGE
  return null
}

/** 名冊廠商（比對用的欄位）。 */
export type RosterKeyVendor = { id: string; name: string | null; short_name?: string | null; account_holder?: string | null }

/**
 * 一家名冊廠商「視為同一家」的比對 key 集合（第六輪統一：放款「其他」收款冒用檢查、副委託 must_bind_vendor 共用）：
 * 名稱 key；簡稱 key（≥3 字）；帳戶戶名 key（等於名稱 key，或 ≥3 字）。
 */
export function rosterVendorKeys(v: RosterKeyVendor): string[] {
  const keyOf = (n: string | null | undefined) => ((n ?? "").trim() !== "" ? payeeNameKey(n) : "")
  const out = new Set<string>()
  const nameKey = keyOf(v.name)
  if (nameKey) out.add(nameKey)
  const shortKey = keyOf(v.short_name)
  if (shortKey && keyLength(shortKey) >= 3) out.add(shortKey)
  const holderKey = keyOf(v.account_holder)
  if (holderKey && (holderKey === nameKey || keyLength(holderKey) >= 3)) out.add(holderKey)
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
  if (!(name ?? "").trim()) return []
  return index.get(payeeNameKey(name)) ?? []
}

/** key 的字數（以 code point 計）。 */
export function keyLength(key: string): number {
  return [...key].length
}
