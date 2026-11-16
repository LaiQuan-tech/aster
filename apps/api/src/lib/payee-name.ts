/**
 * 收款戶名／廠商名稱的比對 key 與不可見字元檢查（2026-11-17 第五輪，R3；第八輪拆成 exact 硬擋／similar 需說明兩級）。
 * 放款單（services/disbursements.ts）、廠商名冊（routes/vendors.ts）、副委託整批 PUT（routes/subcontracts.ts）共用。
 */

import { TW_COUNTIES, TW_TOWNSHIPS } from "./tw-places.js"

/** 會讓兩個「看起來一樣」的名稱比對不同的不可見字元：預設可忽略字元、組合符號、點字空白與韓文填充字。 */
const INVISIBLE_CLASS = "\\p{Default_Ignorable_Code_Point}\\p{M}\\u2800\\u3164\\u115F\\u1160\\uFFA0"
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CLASS}]`, "u")
const STRIP_RE = new RegExp(`[\\s\\p{Cf}${INVISIBLE_CLASS}]`, "gu")

/**
 * 第十輪（2026-11-17）：比對 key 先去掉的附加字（不影響辨識、卻會讓比對 key 不同）；收尾輪起只用於相近級別，exact 不去：
 * 注音符號（U+3100–312F、U+31A0–31BF）、聲調符號（ˉˊˇˋ˙）、「丶」「々」、日文長音「ー」（半形ｰ NFKC 後也是ー）；
 * ™ ℠ ℡ 這類 NFKC 會變成字母（tm／sm／tel）的符號在 NFKC 之前先去掉。
 */
const ANNOTATION_STRIP_RE = /[\u3100-\u312F\u31A0-\u31BF\u02C9\u02CA\u02C7\u02CB\u02D9\u4E36\u3005\u30FC\uFF70\u2122\u2120\u2121]/gu

/** 收尾輪：exact key 不去 ™ ℠ ℡，但也不讓 NFKC 把它們變成字母（「ACME™」≠「ACMETM」）——NFKC 前換成私用區字元保留。 */
const TRADEMARK_RE = /[\u2122\u2120\u2121]/gu
const TRADEMARK_KEEP: Record<string, string> = { "\u2122": "\uE122", "\u2120": "\uE120", "\u2121": "\uE121" }

/**
 * 最後收尾輪：獨立附加符號（˙ ¨ ¯ ´ ¸ ˘ ˚ ˛ ˜ ˝ ゛ ゜、希臘／阿拉伯獨立附加符號…）NFKC 會拆成「空白＋組合符號」，
 * 再被去不可見字元時整個消失（「測試˙行」＝「測試行」）。exact key 在 NFKC 前換成私用區佔位字元保留；相近級別照常去除。
 * 清單程式化產生：BMP 每個字元，本身不是 \p{M}、NFKC 結果卻含 \p{M}（約 130 個）；佔位字元 U+E200 起依序編號。
 */
const SPACING_MARK_KEEP: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (let cp = 0; cp < 0x10000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const ch = String.fromCharCode(cp)
    if (/\p{M}/u.test(ch) || !/\p{M}/u.test(ch.normalize("NFKC"))) continue
    map.set(ch, String.fromCharCode(0xe200 + map.size))
  }
  return map
})()

/**
 * 私用區字元（\p{Co}）：輸入一律拒收（invalidNameMessage）；已存在的舊資料在 exact key 前面加跳脫字元 U+F8FF，
 * 不會與上面的佔位字元（™ → U+E122…、獨立附加符號 → U+E200…）撞在一起；相近級別直接去掉。
 */
const PRIVATE_USE_RE = /\p{Co}/gu
const PRIVATE_USE_CHAR_RE = /^\p{Co}$/u
const PRIVATE_USE_ESCAPE = "\uF8FF"

/** exact key 的 NFKC 前處理：私用區字元加跳脫、™ ℠ ℡ 與獨立附加符號換成佔位字元。 */
function protectForExact(s: string): string {
  let out = ""
  for (const ch of s) {
    if (PRIVATE_USE_CHAR_RE.test(ch)) out += PRIVATE_USE_ESCAPE + ch
    else out += TRADEMARK_KEEP[ch] ?? SPACING_MARK_KEEP.get(ch) ?? ch
  }
  return out
}

/**
 * 前處理（尚未去空白／不可見字元，供詞邊界判斷）：NFKC → 小寫 → 臺→台。
 * annotations＝true（相近級別）：NFKC 前後各去一次附加字（注音、聲調、丶、々、ー、™…）；
 * annotations＝false（exact 級別）：附加字一律保留（收尾輪：「ㄅㄆㄇ工作室」≠「ㄉㄊㄋ工作室」、「佐々木」≠「佐木」）。
 */
function normalizeRaw(name: string | null | undefined, annotations: boolean): string {
  let s = String(name ?? "")
  s = annotations ? s.replace(PRIVATE_USE_RE, "").replace(ANNOTATION_STRIP_RE, "") : protectForExact(s)
  s = s.normalize("NFKC").toLowerCase().replace(/臺/g, "台")
  return annotations ? s.replace(ANNOTATION_STRIP_RE, "") : s
}

/**
 * 收尾輪：去附加字後為空、或剩不到原本（不去附加字）長度的一半 → 退回不去附加字的版本
 *（全注音名稱「ㄅㄆㄇ」不會被去成空字串或一兩個字而與別家相撞）。
 */
function prepared(name: string | null | undefined, annotations: boolean): string {
  const raw = normalizeRaw(name, false)
  if (!annotations) return raw
  const stripped = normalizeRaw(name, true)
  const rawLen = [...raw.replace(STRIP_RE, "")].length
  const strippedLen = [...stripped.replace(STRIP_RE, "")].length
  if (strippedLen === 0 || strippedLen * 2 < rawLen) return raw
  return stripped
}

/** 所有比對 key 的共同前處理：prepared → 去空白／格式／不可見字元。annotations 預設 true（相近級別）。 */
function baseNormalize(name: string | null | undefined, annotations = true): string {
  return prepared(name, annotations).replace(STRIP_RE, "")
}

/**
 * 名稱含不可見字元（先 NFC 組字，可組合的重音字母不算）→ true。
 * 呼叫端回 400 invalid_payee_name／invalid_vendor_name「名稱含有不可見字元，請重新輸入」。
 */
export function hasInvisibleNameChars(name: string | null | undefined): boolean {
  if (name == null) return false
  return INVISIBLE_RE.test(String(name).normalize("NFC"))
}

export const INVISIBLE_NAME_MESSAGE = "名稱含有不可見字元，請重新輸入"

/** 最後收尾輪：名稱含私用區字元（\p{Co}，各字型顯示不一、可冒充佔位字元）→ true。 */
export function hasPrivateUseChars(name: string | null | undefined): boolean {
  if (name == null) return false
  return /\p{Co}/u.test(String(name))
}

export const PRIVATE_USE_NAME_MESSAGE = "名稱含有無法辨識的特殊字元（私用區字元），請重新輸入"

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
  const cleaned = baseNormalize(name)
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
  if (hasPrivateUseChars(name)) return PRIVATE_USE_NAME_MESSAGE
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
 * 收尾輪：不去注音／聲調／丶／々／ー（只在相近級別去），™ ℠ ℡ 原樣保留（不經 NFKC 變成字母）——附加字不同就不是完全相同。
 */
export function exactNameKey(name: string | null | undefined): string {
  return baseNormalize(name, false).replace(EXACT_DROP_PUNCT_RE, "")
}

/** 收尾輪：exact key 的規則但去掉附加字（注音、聲調…）。只用於相近級別。 */
function annotatedExactKey(name: string | null | undefined): string {
  return baseNormalize(name, true).replace(EXACT_DROP_PUNCT_RE, "")
}

/** 第九輪 L-1：去附加字的 exact key 再去掉所有符號（第八輪的 exact）。只用於相近級別。 */
function strippedNameKey(name: string | null | undefined): string {
  return annotatedExactKey(name).replace(PUNCT_OR_SYMBOL_RE, "")
}

/**
 * 第八輪「相似」比對 key（需確認＋原因＋嚴格稽核，不硬擋）：payeeNameKeys（去公司後綴、分公司、括號段、-xxx 段，
 * 有 2 中文字／3 拉丁字元下限）再加上 exactNameKey、去附加字的 exact key 與去符號後的 key（第九輪 L-1）。空名稱回 []。
 */
export function similarNameKeys(name: string | null | undefined): string[] {
  const exact = exactNameKey(name)
  if (!exact) return []
  const annotated = annotatedExactKey(name)
  const stripped = strippedNameKey(name)
  return [...new Set([exact, ...(annotated ? [annotated] : []), ...(stripped ? [stripped] : []), ...payeeNameKeys(name)])]
}

/**
 * 收尾輪（英文詞邊界）：比對 key ＋「每個字元前面原本有沒有被去掉的分隔字元（空白、標點…）」。
 * 拉丁字母／數字的包含判斷要求詞邊界：「abc」在「babcock」裡（前後緊接字母）不算，在「abc design」「abc-taiwan」裡算。
 */
export type KeyHay = { key: string; sep: boolean[] }
const STRIP_CHAR_RE = new RegExp(`^[\\s\\p{Cf}${INVISIBLE_CLASS}]$`, "u")
const EXACT_DROP_CHAR_RE = /^(?![&@#%*])\p{P}$/u
const PUNCT_OR_SYMBOL_CHAR_RE = /^[\p{P}\p{S}]$/u
const PAREN_DROP_CHAR_RE = /^[^\p{L}\p{N}()]$/u
const LATIN_OR_DIGIT_RE = /[\p{Script=Latin}\p{Nd}]/u

function buildHay(prep: string, drop: RegExp): KeyHay {
  let key = ""
  const sep: boolean[] = []
  let pending = false
  for (const ch of prep) {
    if (STRIP_CHAR_RE.test(ch) || drop.test(ch)) {
      pending = true
      continue
    }
    key += ch
    sep.push(pending)
    for (let i = 1; i < ch.length; i++) sep.push(false)
    pending = false
  }
  return { key, sep }
}

/** 沒有分隔資訊時的保守版本（視為沒有任何分隔＝拉丁字母相連處不算詞邊界）。 */
function plainHay(key: string): KeyHay {
  return { key, sep: new Array<boolean>(key.length).fill(false) }
}

/** needle 出現在 hay 的 [start, end) 是否符合詞邊界（只有兩側都是拉丁字母／數字且中間沒有分隔字元才算不符）。 */
function atWordBoundary(hay: KeyHay, start: number, end: number): boolean {
  const k = hay.key
  if (start > 0 && !hay.sep[start] && LATIN_OR_DIGIT_RE.test(k[start]!) && LATIN_OR_DIGIT_RE.test(k[start - 1]!)) return false
  if (end < k.length && !hay.sep[end] && LATIN_OR_DIGIT_RE.test(k[end - 1]!) && LATIN_OR_DIGIT_RE.test(k[end]!)) return latinTailBoundary(hay, end)
  return true
}

/**
 * 最後收尾輪：拉丁核心後面緊接拉丁字母／數字時，下列情況仍算詞邊界——
 * - 英文複數：接 s／es 後就是結尾、分隔字元或非英數字（「ABC Designs Limited」含「ABC Design」、「Deltas Inc」含「Delta」）；
 * - 黏寫的英文附加詞（英文產業詞／地名表中 ≥4 字母者：taiwan、design、group、tech…）：「ABCTaiwan」「LGtaiwan」；
 * - 數字＋廠：「3M2廠」。
 * 「Babcock」「13M」「3MX」「HPE」仍不算。
 */
function latinTailBoundary(hay: KeyHay, end: number): boolean {
  const k = hay.key
  if (/\p{Script=Latin}/u.test(k[end - 1]!)) {
    for (const plural of ["es", "s"]) {
      if (!k.startsWith(plural, end)) continue
      const j = end + plural.length
      if (j >= k.length || hay.sep[j] || !LATIN_OR_DIGIT_RE.test(k[j]!)) return true
    }
  }
  if (GLUE_LATIN_WORDS.some((w) => k.startsWith(w, end))) return true
  return /^[0-9]+廠/u.test(k.slice(end))
}

/** needle 在 hay 裡每個符合詞邊界的出現位置（UTF-16 index）。 */
function occurrences(hay: KeyHay, needle: string): number[] {
  const out: number[] = []
  if (!needle) return out
  for (let i = hay.key.indexOf(needle); i >= 0; i = hay.key.indexOf(needle, i + 1)) {
    if (atWordBoundary(hay, i, i + needle.length)) out.push(i)
  }
  return out
}

/** 一個名稱的 full key（exact、去附加字 exact、去符號）連同分隔資訊。 */
function fullHays(name: string | null | undefined): KeyHay[] {
  if (!exactNameKey(name)) return []
  const out = [buildHay(prepared(name, false), EXACT_DROP_CHAR_RE), buildHay(prepared(name, true), EXACT_DROP_CHAR_RE), buildHay(prepared(name, true), PUNCT_OR_SYMBOL_CHAR_RE)]
  const seen = new Set<string>()
  return out.filter((h) => h.key && !seen.has(h.key) && (seen.add(h.key), true))
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
 * - full（第九輪 H-1「包含」的被包含方）：名稱、簡稱、帳戶戶名各自的 exactNameKey、去附加字 exact key 與去符號 key。
 */
export type RosterKeySets = {
  exact: string[]
  similar: string[]
  full: string[]
  /** 收尾輪：full 各 key 的分隔資訊（英文詞邊界用；只採用 key 仍在 full 裡的）。省略＝視為沒有分隔。 */
  fullHay?: KeyHay[]
  /**
   * 第十輪「名稱包含」（只看「名稱」欄位，不含簡稱／戶名）：名稱的 exact、去附加字 exact 與去符號 key（insideExact 的被包含方／包含方）。
   * 省略＝不參與（例：名冊只改簡稱、名稱沒變）。
   */
  name?: string[]
  /** 收尾輪：name 各 key 的分隔資訊（詞邊界用）。 */
  nameHay?: KeyHay[]
  /** 第十輪：名稱保留括號的比對字串（只留字母、數字、括號），連同分隔資訊；供「核心＋地名／分公司／括號段」判斷。 */
  nameParen?: KeyHay | null
  /**
   * 收尾輪 F1／F2：名冊名稱與簡稱去公司型態字（再去結尾產業詞）後的核心，含 2 字核心／2 字簡稱（≥2 中文字或 ≥2 英數字）。
   * 新名稱＝核心、或核心前後只多地名／分公司字／公司型態字／括號段／產業詞 → 相近。
   */
  patterns?: string[]
  /** 收尾輪 F4：名稱以行／社／號結尾且去後綴後只剩 2 字 → 該後綴字（「行銷」「社區」「號碼」這類常見詞不算包含）。 */
  f4Suffix?: string | null
}

/**
 * 一家名冊廠商「視為同名／相近」的比對 key（放款「其他」收款、副委託 must_bind_vendor、名冊重名、複製專案共用）。
 * 第八輪拆兩級；第九輪 H-2：exact 只看名稱。
 */
export function rosterVendorKeys(v: Omit<RosterKeyVendor, "id"> & { id?: string }): RosterKeySets {
  const exact = new Set<string>()
  const similar = new Set<string>()
  const nameExact = exactNameKey(v.name)
  const nameSimilar = similarNameKeys(v.name)
  if (nameExact) exact.add(nameExact)
  for (const k of nameSimilar) similar.add(k)
  for (const k of similarNameKeys(v.short_name)) if (keyLength(k) >= 3) similar.add(k)
  for (const k of similarNameKeys(v.account_holder)) if (nameSimilar.includes(k) || keyLength(k) >= 3) similar.add(k)
  for (const k of exact) similar.add(k)
  const fullHay = dedupeHays([v.name, v.short_name, v.account_holder].flatMap((f) => fullHays(f)))
  const patterns = [...new Set([...corePatterns(v.name), ...corePatterns(v.short_name)])]
  return { exact: [...exact], similar: [...similar], full: fullHay.map((h) => h.key), fullHay, ...nameContainKeys(v.name), patterns }
}

function dedupeHays(hays: KeyHay[]): KeyHay[] {
  const seen = new Set<string>()
  return hays.filter((h) => h.key && !seen.has(h.key) && (seen.add(h.key), true))
}

/** 去掉結尾公司型態字（可疊加；去完變空就停）後的核心（輸入為已去標點符號的 key）。 */
function stripCoreSuffixes(key: string): string {
  let core = key
  for (let changed = true; changed; ) {
    changed = false
    for (const suf of SUFFIXES_BARE) {
      if (core.endsWith(suf) && core.length > suf.length) {
        core = core.slice(0, -suf.length)
        changed = true
        break
      }
    }
  }
  return core
}

/** 收尾輪 F3：產業／組織常見詞（「名冊名稱＋這些字」視為同一家的變體）。 */
const INDUSTRY_HAN_WORDS = [
  "國際", "實業", "集團", "科技", "企業", "電腦", "電子", "工業", "貿易", "建設", "營造", "工程", "設計", "顧問", "開發", "控股",
  // 最後收尾輪：營建工種與常見服務業詞（「材料」刻意不加）
  "水電", "機電", "空調", "冷氣", "消防", "室內裝修", "裝修", "裝潢", "土木", "土木包工業", "包工業", "油漆", "木作", "鐵工", "鋁窗",
  "環保", "清潔", "資訊", "數位", "通訊", "印刷", "廣告", "系統", "維修", "服務中心",
]
const INDUSTRY_LATIN_WORDS = [
  "international", "intl", "group", "technology", "technologies", "tech", "design", "designs", "engineering", "consulting", "consultants",
  "trading", "industrial", "industries", "industry", "holdings", "holding", "electronics", "electronic", "computers", "computer",
  "enterprises", "enterprise", "construction", "development", "developments",
]
const INDUSTRY_HAN_DESC = [...INDUSTRY_HAN_WORDS].sort((a, b) => b.length - a.length)

/** 核心／簡稱的下限：至少 2 字，且 ≥2 個中文字或 ≥2 個拉丁字母／數字。 */
function meetsPatternFloor(p: string): boolean {
  if ([...p].length < 2) return false
  const han = (p.match(HAN_RE) ?? []).length
  if (han >= 2) return true
  return (p.match(OTHER_ALNUM_RE) ?? []).length - han >= 2
}

/**
 * 收尾輪 F1／F2：一個欄位（名稱或簡稱）的核心：去符號 key 與 payeeNameKeys（去分公司／括號段…）各自去結尾公司型態字，
 * 再逐次去結尾產業詞（「全聯實業股份有限公司」→「全聯實業」→「全聯」）；每一階段過下限的都收。
 */
function corePatterns(field: string | null | undefined): string[] {
  if (!exactNameKey(field)) return []
  const out = new Set<string>()
  const bases = [strippedNameKey(field), ...payeeNameKeys(field).map((k) => k.replace(PUNCT_OR_SYMBOL_RE, ""))]
  for (const b of bases) {
    if (!b) continue
    let c = stripCoreSuffixes(b)
    if (meetsPatternFloor(c)) out.add(c)
    for (let changed = true; changed; ) {
      changed = false
      for (const w of INDUSTRY_HAN_DESC) {
        if (!c.endsWith(w)) continue
        const rest = stripCoreSuffixes(c.slice(0, -w.length))
        if (rest !== c && meetsPatternFloor(rest)) {
          c = rest
          out.add(c)
          changed = true
          break
        }
      }
    }
  }
  // 最後收尾輪：前後兩端的地名／分公司字／公司型態字／中英文產業詞反覆剝除（所有剝法都試），每個過下限的中間結果都收
  //（「台中宏碁股份有限公司」→「台中宏碁」→「宏碁」、「Acer Taiwan Inc.」→「acertaiwan」→「acer」）。
  const hays = [buildHay(prepared(field, true), PUNCT_OR_SYMBOL_CHAR_RE), ...bases.filter(Boolean).map(plainHay)]
  for (const h of hays) for (const p of peelExtras(h)) out.add(p)
  return [...out]
}

/** 剝除時的狀態上限（防病態輸入）。 */
const PEEL_MAX_STATES = 200

/**
 * hay.key 前後反覆剝掉允許的附加字（EXTRA_TOKENS），回傳每個剝出、且過 meetsPatternFloor 的中間結果（不含原字串）。
 * 拉丁附加詞要詞邊界：開頭的拉丁詞後面不可緊接英數字（除非原本有分隔）；結尾的拉丁詞前面緊接英數字時，
 * 只有 ≥4 字母的黏寫英文附加詞（taiwan、design…）可剝。
 */
function peelExtras(hay: KeyHay): string[] {
  const k = hay.key
  const glued = (i: number) => i > 0 && i < k.length && !hay.sep[i] && LATIN_OR_DIGIT_RE.test(k[i - 1]!) && LATIN_OR_DIGIT_RE.test(k[i]!)
  const out = new Set<string>()
  const seen = new Set<string>([`0:${k.length}`])
  const queue: Array<[number, number]> = [[0, k.length]]
  while (queue.length > 0 && seen.size < PEEL_MAX_STATES) {
    const [start, end] = queue.shift()!
    const s = k.slice(start, end)
    const push = (a: number, b: number) => {
      const id = `${a}:${b}`
      if (b <= a || seen.has(id)) return
      const rest = k.slice(a, b)
      if (!meetsPatternFloor(rest)) return
      seen.add(id)
      // 剩下的整段都是地名／型態字／產業詞（「台灣」「工程」）→ 不是核心，不收（仍可繼續剝）
      if (!isOnlyAllowedExtras(rest, PEEL_TOKENS_BY_FIRST)) out.add(rest)
      queue.push([a, b])
    }
    for (const t of PEEL_TOKENS) {
      if (t.length >= s.length) continue
      if (s.startsWith(t) && !glued(start + t.length)) push(start + t.length, end)
      if (s.endsWith(t) && (!glued(end - t.length) || GLUE_LATIN_WORDS.includes(t))) push(start, end - t.length)
    }
  }
  return [...out]
}

/** 第十輪：名稱欄位的「名稱包含」比對資料。空名稱回空。 */
function nameContainKeys(name: string | null | undefined): Pick<RosterKeySets, "name" | "nameHay" | "nameParen" | "f4Suffix"> {
  const exact = exactNameKey(name)
  if (!exact) return { name: [], nameHay: [], nameParen: null, f4Suffix: null }
  const hays = fullHays(name)
  const stripped = strippedNameKey(name)
  const last = [...stripped].pop() ?? ""
  const f4Suffix = F4_SUFFIXES.includes(last) && [...stripCoreSuffixes(stripped)].length === 2 ? last : null
  return {
    name: hays.map((h) => h.key),
    nameHay: hays,
    nameParen: buildHay(prepared(name, true), PAREN_DROP_CHAR_RE),
    f4Suffix,
  }
}

/**
 * 第十輪 insideExact 的下限：名冊名稱的 exact key 至少 3 字元（code point），且去公司型態字後仍有 ≥2 個中文字或 ≥2 個英數字。
 *（「大同行」「全聯社」「永豐行」「IBM」「HP Inc」「金德行」過；「宏碁」「3M」只有 2 字元，改走核心＋附加字規則。）
 */
function meetsInsideExactFloor(key: string): boolean {
  if ([...key].length < 3) return false
  const core = stripCoreSuffixes(key.replace(PUNCT_OR_SYMBOL_RE, ""))
  const han = (core.match(HAN_RE) ?? []).length
  if (han >= 2) return true
  return (core.match(OTHER_ALNUM_RE) ?? []).length - han >= 2
}

/** 收尾輪 F4：名冊名稱以這些字結尾、去後綴後 2 字時，新名稱裡「後綴＋下一字」若是這些常見詞就不算包含。 */
const F4_SUFFIXES = ["行", "社", "號"]
const F4_WORDS = ["行銷", "行政", "行動", "社區", "社會", "號誌", "號碼"]

/** 台灣常見縣市／區名與英文地名（核心＋地名規則用；臺已正規化為台）。鄉鎮市區全表在 lib/tw-places.ts。 */
const PLACE_NAMES = [
  "台灣", "中華民國", "台北", "新北", "桃園", "台中", "台南", "高雄", "基隆", "新竹", "苗栗", "彰化", "南投", "雲林", "嘉義", "屏東",
  "宜蘭", "花蓮", "台東", "澎湖", "金門", "連江", "馬祖",
  "北北基", "大台北", "北部", "中部", "南部", "東部", "北區", "中區", "南區", "東區", "西區",
  "taiwan", "taipei", "newtaipei", "taoyuan", "taichung", "tainan", "kaohsiung", "hsinchu", "keelung", "tw", "roc",
]
/** 分公司／營業據點字。 */
const BRANCH_WORDS = [
  "分公司", "總公司", "營業所", "營業處", "辦事處", "服務處", "分處", "門市部", "門市", "分店", "總店", "店", "工廠", "廠", "分行", "總行",
  "branch", "office", "store", "shop", "factory",
]
/** 公司型態字（含後綴表、開頭表去標點後的字）。 */
const COMPANY_TYPE_WORDS = [...new Set([...SUFFIXES_BARE, "股份有限公司", "有限公司", "公司", "股", "株", "株式会社", "企業社", "企業", "工作室", "行", "社", "號", "co", "coltd", "colimited", "ltd", "limited", "inc", "corp", "corporation", "company"])]
/** 地名後可接的「市／縣／區／鄉／鎮」。 */
const PLACE_TAILS = ["市", "縣", "區", "鄉", "鎮"]
/** 「第二廠」「二廠」「3廠」。 */
const FACTORY_RE = /^第?[0-9〇零一二三四五六七八九十百]+廠/u
/** 允許的附加字（依第一個字元分桶、長的先試）。 */
const EXTRA_TOKENS: ReadonlySet<string> = (() => {
  const set = new Set<string>([...BRANCH_WORDS, ...COMPANY_TYPE_WORDS, ...INDUSTRY_HAN_WORDS, ...INDUSTRY_LATIN_WORDS])
  for (const p of PLACE_NAMES) {
    set.add(p)
    if (/\p{Script=Han}/u.test(p)) for (const t of PLACE_TAILS) set.add(p + t)
  }
  for (const c of TW_COUNTIES) set.add(c)
  for (const t of TW_TOWNSHIPS) {
    set.add(t)
    const base = [...t].slice(0, -1).join("")
    if ([...base].length >= 2) set.add(base)
  }
  return set
})()
/**
 * 剝除用（長的先試）：EXTRA_TOKENS 去掉鄉鎮市區的「去區／鄉／鎮／市」2 字簡稱（大同、中山、信義、永和…常是公司名本身，
 * 不從名冊名稱剝掉；完整的「大同區」「板橋區」照剝）。
 */
const TOWNSHIP_BASES: ReadonlySet<string> = new Set(
  TW_TOWNSHIPS.map((t) => [...t].slice(0, -1).join("")).filter((b) => [...b].length >= 2 && !TW_COUNTIES.includes(b) && !PLACE_NAMES.includes(b)),
)
const PEEL_TOKENS = [...EXTRA_TOKENS].filter((t) => !TOWNSHIP_BASES.has(t)).sort((a, b) => b.length - a.length)
const PEEL_TOKENS_BY_FIRST: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>()
  for (const t of PEEL_TOKENS) {
    const first = [...t][0]!
    map.set(first, [...(map.get(first) ?? []), t])
  }
  return map
})()
/** 最後收尾輪：可黏在拉丁核心後面的英文附加詞（英文產業詞＋英文地名，≥4 字母；tw／roc／co／inc 這類短詞不算）。 */
const GLUE_LATIN_WORDS = [...new Set([...INDUSTRY_LATIN_WORDS, ...PLACE_NAMES.filter((p) => /^[a-z]+$/u.test(p))])]
  .filter((w) => w.length >= 4)
  .sort((a, b) => b.length - a.length)
const EXTRA_TOKENS_BY_FIRST: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>()
  for (const t of EXTRA_TOKENS) {
    const first = [...t][0]!
    const list = map.get(first) ?? []
    list.push(t)
    map.set(first, list)
  }
  for (const list of map.values()) list.sort((a, b) => b.length - a.length)
  return map
})()

/**
 * 剩餘部分是否只由允許的附加字組成（空字串也算）：地名（含全台 368 鄉鎮市區）、分公司／營業所等、公司型態字、
 * 產業詞（國際、實業、工程、設計…、第N廠）、括號段。
 */
function isOnlyAllowedExtras(rest: string, tokensByFirst: Map<string, string[]> = EXTRA_TOKENS_BY_FIRST): boolean {
  const memo = new Map<number, boolean>()
  const ok = (i: number): boolean => {
    if (i === rest.length) return true
    const cached = memo.get(i)
    if (cached !== undefined) return cached
    let result = false
    if (rest[i] === "(") {
      const close = rest.indexOf(")", i + 1)
      if (close > i && !rest.slice(i + 1, close).includes("(")) result = ok(close + 1)
    }
    if (!result) {
      const factory = rest.slice(i).match(FACTORY_RE)
      if (factory) result = ok(i + factory[0].length)
    }
    if (!result) {
      const cp = rest.codePointAt(i)!
      for (const t of tokensByFirst.get(String.fromCodePoint(cp)) ?? []) {
        if (rest.startsWith(t, i) && ok(i + t.length)) {
          result = true
          break
        }
      }
    }
    memo.set(i, result)
    return result
  }
  return ok(0)
}

/**
 * 「名冊名稱被新名稱包含」（roster＝名冊廠商、mine＝新名稱）：
 * - insideExact（第十輪）：名冊名稱的 key 過 meetsInsideExactFloor，且整串出現在新名稱的 key 裡（拉丁／數字要詞邊界；
 *   F4：名冊「大同行」不因「大同行銷」相近）；
 * - 核心＋附加字（收尾輪 F1／F2）：名冊名稱／簡稱的核心（含 2 字）在新名稱（保留括號）的某個出現位置，前後兩段都只含
 *   地名／分公司字／公司型態字／括號段／產業詞（含兩段皆空＝新名稱就是核心）：「宏碁」對「台中宏碁股份有限公司」、
 *   「3M」對「(台中)3M有限公司」、名冊「全聯實業股份有限公司」（簡稱全聯）對「全聯」「全聯社」「全聯 台中」。
 */
export function rosterNameInside(
  roster: Pick<RosterKeySets, "name" | "patterns" | "f4Suffix">,
  mine: Pick<RosterKeySets, "name" | "nameHay" | "nameParen">,
): boolean {
  const hays = mine.nameHay && mine.nameHay.length > 0 ? mine.nameHay : (mine.name ?? []).map(plainHay)
  const f4 = roster.f4Suffix ?? null
  for (const k of roster.name ?? []) {
    if (!meetsInsideExactFloor(k)) continue
    for (const h of hays) {
      for (const i of occurrences(h, k)) {
        const end = i + k.length
        if (f4 && k.endsWith(f4) && F4_WORDS.includes(f4 + (h.key[end] ?? ""))) continue
        return true
      }
    }
  }
  const paren = mine.nameParen
  if (paren?.key) {
    for (const p of roster.patterns ?? []) {
      for (const i of occurrences(paren, p)) {
        const after = paren.key.slice(i + p.length)
        if (F4_WORDS.some((w) => after.startsWith(w))) continue
        if (isOnlyAllowedExtras(paren.key.slice(0, i)) && isOnlyAllowedExtras(after)) return true
      }
    }
  }
  return false
}

/** key 組的 full key 連同分隔資訊（只取 key 仍在 full 裡的；沒有分隔資訊的 key 視為沒有分隔）。 */
function haysOf(x: Pick<RosterKeySets, "full" | "fullHay">): KeyHay[] {
  const byKey = new Map((x.fullHay ?? []).map((h) => [h.key, h]))
  return x.full.map((k) => byKey.get(k) ?? plainHay(k))
}

/**
 * 第九輪 H-1「包含」：a 的 similar key（過長度下限）是 b 的 full key 的子字串（拉丁／數字要詞邊界），或反過來 → true。
 * 例：名冊「測試己有限公司」的「測試己」出現在「(台中)測試己有限公司」裡；新名稱「陳大文」出現在名冊「陳大文水電行」裡。
 */
function containsEither(a: Pick<RosterKeySets, "similar" | "full" | "fullHay">, b: Pick<RosterKeySets, "similar" | "full" | "fullHay">): boolean {
  const inside = (keys: readonly string[], hays: readonly KeyHay[]) =>
    keys.some((k) => meetsContainFloor(k) && hays.some((h) => h.key !== k && occurrences(h, k).length > 0))
  return inside(a.similar, haysOf(b)) || inside(b.similar, haysOf(a))
}

/** 新名稱（放款戶名、副委託名稱）比對用的 key 組（exact＝名稱 exact；full＝exact、去附加字 exact 與去符號 key）。 */
function nameKeySets(name: string | null | undefined): RosterKeySets {
  const exact = exactNameKey(name)
  if (!exact) return { exact: [], similar: [], full: [] }
  const fullHay = fullHays(name)
  return { exact: [exact], similar: similarNameKeys(name), full: fullHay.map((h) => h.key), fullHay, ...nameContainKeys(name) }
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
 * 第九輪 H-1：similar 另加「包含」——名冊廠商的 similar key（≥3 中文字或 ≥5 拉丁字元／數字）出現在新名稱的 key 裡，
 * 或新名稱的 similar key（同下限）出現在名冊廠商名稱／簡稱／戶名的 key 裡 → 相近；第十輪／收尾輪另加 rosterNameInside。
 * 寧可多報相近，不硬擋。
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
    if (containsEither(mine, keys) || rosterNameInside(keys, mine)) similar.push(vendor)
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
  // 第十輪：名冊兩家互比（新增／改名的一方 mine 與既有 other），任一方名稱被另一方名稱包含 → 相近（收尾輪：含核心／簡稱＋附加字）。
  if (rosterNameInside(other, mine) || rosterNameInside(mine, other)) return "similar"
  return null
}

/** key 的字數（以 code point 計）。 */
export function keyLength(key: string): number {
  return [...key].length
}
