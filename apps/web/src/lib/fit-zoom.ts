/**
 * 後台 Excel 版面報表（出勤統計表、薪資明細表、獎金分潤總表、年度總表）的「符合寬度」縮放計算。
 *
 * 規則：表比容器窄 → 不縮放（zoom 1）；比容器寬 → 等比縮到容器寬；但縮完的等效字級小於
 * MIN_READABLE_PX（9px）時停在最小可讀倍率，改讓使用者左右捲動（clamped＝true，畫面要提示）。
 * 純函式，元件在 components/FitToWidth.tsx。
 */

export type FitMode = "fit" | "actual";

/** 縮放後最小可讀字級（px）。 */
export const MIN_READABLE_PX = 9;

/** 記住「符合寬度／實際大小」的 localStorage key（各報表共用一個選擇）。 */
export const FIT_MODE_STORAGE_KEY = "aster.admin.reportFitMode";

export function parseFitMode(value: string | null | undefined): FitMode {
  return value === "actual" ? "actual" : "fit";
}

/** 字級 baseFontPx 的內容最小可以縮到多少倍仍有 minPx。 */
export function minZoomFor(baseFontPx: number, minPx: number = MIN_READABLE_PX): number {
  if (!(baseFontPx > 0)) return 1;
  return Math.min(1, minPx / baseFontPx);
}

/** pt → px（96dpi）。 */
export function ptToPx(pt: number): number {
  return (pt * 96) / 72;
}

/** 格線裡最常見的字級（pt）；空就回 fallback。用來決定最小可讀倍率，避免少數小字註腳讓整張表不能縮。 */
export function dominantFontPt(sizes: ReadonlyArray<number | null | undefined>, fallback = 12): number {
  const counts = new Map<number, number>();
  for (const s of sizes) {
    const v = s ?? fallback;
    if (!(v > 0)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [size, n] of counts) {
    if (n > bestCount || (n === bestCount && size < best)) {
      best = size;
      bestCount = n;
    }
  }
  return best;
}

export type FitResult = {
  /** 套用的倍率（≤ 1）。 */
  zoom: number;
  /** 實際大小時內容比容器寬（需要縮放或捲動）。 */
  overflow: boolean;
  /** 已縮到最小可讀倍率仍放不下，需水平捲動。 */
  clamped: boolean;
};

export function fitZoom(containerPx: number, naturalPx: number, minZoom: number): FitResult {
  if (!(containerPx > 0) || !(naturalPx > 0) || naturalPx <= containerPx) {
    return { zoom: 1, overflow: false, clamped: false };
  }
  // 無條件捨去到千分位，避免四捨五入後多出 1px 又出現捲軸。
  const raw = Math.floor((containerPx / naturalPx) * 1000) / 1000;
  const floor = Math.min(1, Math.max(0.1, minZoom));
  if (raw >= floor) return { zoom: raw, overflow: true, clamped: false };
  return { zoom: floor, overflow: true, clamped: true };
}

export type ContentMeasure = {
  /** 容器 scrollWidth（已套用 zoom 的畫面座標）。 */
  scrollWidth: number;
  /** 容器 clientWidth。 */
  clientWidth: number;
  /** 表格本身的畫面寬（getBoundingClientRect，已套用 zoom）。 */
  tableWidth: number;
  /** 量測當下套用的 zoom。 */
  zoom: number;
};

/**
 * 依量測結果換算內容實際寬（未縮放 px），同一張表只增不減（prev＝這張表上次量到的值，換表時由元件歸零）。
 *
 * 有溢出（scrollWidth > clientWidth）才量得到「文字溢出到表格右邊」的真實寬度；縮到放得下之後沒溢出，只能量到
 * 表格本身。若此時改用表格寬，會放大回去 → 文字又溢出 → 再縮……無限循環（2026-11-09 出勤統計表「一直閃」），
 * 所以取兩者與上次值的最大值。內容寬不隨容器或縮放改變，只增不減是安全的。
 */
export function nextContentPx(prev: number, m: ContentMeasure): number {
  const z = m.zoom > 0 ? m.zoom : 1;
  const natural = m.scrollWidth > m.clientWidth + 1 ? Math.max(m.scrollWidth, m.tableWidth) : m.tableWidth;
  return Math.max(prev > 0 ? prev : 0, Math.ceil(natural / z));
}
