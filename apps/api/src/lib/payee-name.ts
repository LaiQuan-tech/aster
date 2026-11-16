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

const SUFFIXES_WITH_PUNCT = ["股份有限公司", "有限公司", "(股)", "公司", "co.,ltd.", "co.,ltd", "co.ltd.", "co.ltd", "ltd.", "ltd", "inc.", "inc", "corp.", "corp", "co."]
const SUFFIXES_BARE = ["股份有限公司", "有限公司", "公司", "coltd", "ltd", "inc", "corp"]
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

/**
 * 戶名比對 key：NFKC（全形英數→半形、（股）→(股)）→ 小寫 → 去掉空白、格式字元、不可見字元
 * → 去掉開頭的 (股) → 去掉常見公司後綴（股份有限公司、有限公司、(股)、公司、Co.,Ltd、Ltd、Inc、Corp…，可疊加）
 * → 去掉所有標點與符號（\p{P}、\p{S}）→ 再去一次無標點後綴。去完變空字串就退回前一階段的值。「行號」等不去。
 */
export function payeeNameKey(name: string | null | undefined): string {
  const cleaned = String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(STRIP_RE, "")
  let key = cleaned
  while (key.startsWith("(股)") && key.length > 3) key = key.slice(3)
  key = stripSuffixes(key, SUFFIXES_WITH_PUNCT, true)
  const bare = stripSuffixes(key.replace(PUNCT_OR_SYMBOL_RE, ""), SUFFIXES_BARE, false)
  return bare || key || cleaned
}

/** key 的字數（以 code point 計）。 */
export function keyLength(key: string): number {
  return [...key].length
}
