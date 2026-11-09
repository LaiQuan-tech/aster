/**
 * 金額千分位的共用工具（2026-11-09 業主：「網站上所有金額數字都要有千分位逗號」）。
 *
 * - `formatMoney`：畫面顯示用（表格、卡片、合計、列印版）。只改「顯示」，不改 API／xlsx（xlsx 由 Excel 數字格式負責）。
 * - `sanitizeMoneyInput`：輸入框打字／貼上時把「1,234,567」「１２３」「NT$ 300」這類字串收斂成純數字字串。
 * - `stripMoneyCommas`：驗證前去掉逗號（輸入框拿到的值若含逗號，`Number()` 會變 NaN）。
 */

export interface FormatMoneyOptions {
  /** null／undefined／空字串／非數字時顯示的字（預設「—」）。 */
  empty?: string;
  /** 小數位上限（預設 0＝四捨五入到整數）。 */
  maximumFractionDigits?: number;
  /** 小數位下限（預設 0）。 */
  minimumFractionDigits?: number;
}

/** 金額 → 「1,428,571」。字串（PostgreSQL numeric 常回字串）也吃，含逗號亦可。 */
export function formatMoney(value: number | string | null | undefined, options: FormatMoneyOptions = {}): string {
  const { empty = "—", maximumFractionDigits = 0, minimumFractionDigits = 0 } = options;
  if (value === null || value === undefined) return empty;
  const n = typeof value === "number" ? value : Number(stripMoneyCommas(value).trim());
  if (typeof value === "string" && value.trim() === "") return empty;
  if (!Number.isFinite(n)) return empty;
  // 到元時沿用各頁原本的 Math.round（.5 往正無限大進位：-0.5 → 0、2.5 → 3），與既有畫面一致。
  const rounded = maximumFractionDigits === 0 ? Math.round(n) : n;
  const text = rounded.toLocaleString("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: Math.min(minimumFractionDigits, maximumFractionDigits),
  });
  // 四捨五入後的「-0」顯示成「0」。
  return text === "-0" ? "0" : text;
}

/** 去掉千分位逗號（含全形逗號）與空白；其餘原樣保留，交給原本的驗證判斷。 */
export function stripMoneyCommas(value: string): string {
  return value.replace(/[,，\s]/g, "");
}

export interface SanitizeMoneyOptions {
  allowNegative?: boolean;
  allowDecimal?: boolean;
}

/**
 * 打字／貼上的字串 → 純數字字串（不含逗號）。
 * 全形數字轉半形；非數字字元丟掉；負號只留開頭一個（allowNegative）；小數點只留第一個（allowDecimal）。
 */
export function sanitizeMoneyInput(raw: string, options: SanitizeMoneyOptions = {}): string {
  const { allowNegative = false, allowDecimal = false } = options;
  const halfWidth = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, ".")
    .replace(/[－—–]/g, "-");
  const trimmed = halfWidth.trim();
  const negative = allowNegative && trimmed.startsWith("-");
  let out = "";
  let seenDot = false;
  for (const c of trimmed) {
    if (c >= "0" && c <= "9") out += c;
    else if (c === "." && allowDecimal && !seenDot) {
      seenDot = true;
      out += c;
    }
  }
  return negative ? `-${out}` : out;
}

/**
 * 輸入框「未聚焦」時的顯示：純數字字串加千分位，保留使用者打的小數位數與負號。
 * 不是合法數字（例如舊資料殘留的怪字）就原樣顯示，不吃掉內容。
 */
export function groupMoneyDigits(raw: string): string {
  const m = /^(-?)(\d*)(\.\d*)?$/.exec(raw);
  if (!m) return raw;
  const [, sign, intPart, frac = ""] = m;
  if (intPart === "" && frac === "") return raw;
  const grouped = intPart.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped || (frac ? "0" : "")}${frac}`;
}
