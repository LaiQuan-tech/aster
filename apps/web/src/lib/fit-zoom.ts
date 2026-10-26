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
