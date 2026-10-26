"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Segmented } from "@/components/ess-ui";
import {
  FIT_MODE_STORAGE_KEY,
  fitZoom,
  minZoomFor,
  parseFitMode,
  type FitMode,
  type FitResult,
} from "@/lib/fit-zoom";

/**
 * 後台 Excel 版面報表的「符合寬度／實際大小」切換。
 *
 * - `useFitMode()`：記住的選擇（localStorage，讀寫都包 try/catch；同頁多張表用自訂事件同步）。預設符合寬度。
 * - `useFitZoom()`：量容器寬（ResizeObserver），算出 zoom（lib/fit-zoom.ts）。
 * - `FitModeBar`：表比容器寬時才出現的切換列＋提示（不列印）。
 * - `FitToWidth`：不知道內容寬度的表（HTML table 自然寬）用這個包起來，量內容實際寬度後套 CSS zoom。
 *
 * 縮放用 CSS zoom（會影響版面，容器高度自動跟著縮），列印時一律還原（globals.css `.fit-zoom-inner`，
 * StatementTable 另有自己的 A4 列印縮放），下載 Excel 與縮放無關。
 */

const FIT_MODE_EVENT = "aster:report-fit-mode";

function readFitMode(): FitMode {
  try {
    return parseFitMode(window.localStorage.getItem(FIT_MODE_STORAGE_KEY));
  } catch {
    return "fit";
  }
}

export function useFitMode(): [FitMode, (mode: FitMode) => void] {
  const [mode, setModeState] = useState<FitMode>("fit");

  useEffect(() => {
    setModeState(readFitMode());
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<FitMode>).detail;
      setModeState(parseFitMode(next));
    };
    window.addEventListener(FIT_MODE_EVENT, onChange);
    return () => window.removeEventListener(FIT_MODE_EVENT, onChange);
  }, []);

  const setMode = useCallback((next: FitMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(FIT_MODE_STORAGE_KEY, next);
    } catch {
      /* 私密視窗／封鎖儲存：只影響這次 */
    }
    window.dispatchEvent(new CustomEvent<FitMode>(FIT_MODE_EVENT, { detail: next }));
  }, []);

  return [mode, setMode];
}

/** 量元素的可用寬度（clientWidth），寬度變動時更新。回傳 callback ref，元素晚掛上（條件渲染）也量得到。 */
export function useContainerWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** 已知內容寬度（px）時的縮放結果：符合寬度模式才縮，實際大小一律 1。 */
export function resolveFit(mode: FitMode, containerPx: number, naturalPx: number, baseFontPx: number): FitResult {
  const fit = fitZoom(containerPx, naturalPx, minZoomFor(baseFontPx));
  return mode === "fit" ? fit : { zoom: 1, overflow: fit.overflow, clamped: false };
}

export function FitModeBar({
  mode,
  onChange,
  result,
  className,
}: {
  mode: FitMode;
  onChange: (mode: FitMode) => void;
  result: FitResult;
  className?: string;
}) {
  if (!result.overflow) return null;
  const hint =
    mode === "actual"
      ? "實際大小：表比畫面寬，可左右捲動查看。"
      : result.clamped
        ? `已縮到最小可讀字級（${Math.round(result.zoom * 100)}%），仍比畫面寬，可左右捲動查看。`
        : `已縮放至 ${Math.round(result.zoom * 100)}% 以符合畫面寬度。`;
  return (
    <div className={`no-print flex flex-wrap items-center justify-end gap-2 print:hidden ${className ?? ""}`}>
      <p className={`text-xs ${result.clamped || mode === "actual" ? "text-amber-700" : "text-gray-500"}`} aria-live="polite">
        {hint}
      </p>
      <div className="w-48 shrink-0">
        <Segmented<FitMode>
          size="sm"
          compact
          aria-label="報表顯示大小"
          value={mode}
          onChange={onChange}
          options={[
            { value: "fit", label: "符合寬度" },
            { value: "actual", label: "實際大小" },
          ]}
        />
      </div>
    </div>
  );
}

/**
 * 把自然寬度的報表（例如年度總表的 HTML table）縮到容器寬。
 * baseFontPx：表內主要字級（決定最小可讀倍率）。
 */
export function FitToWidth({
  children,
  baseFontPx = 12,
  className,
}: {
  children: ReactNode;
  baseFontPx?: number;
  className?: string;
}) {
  const [mode, setMode] = useFitMode();
  const [outerRef, containerPx] = useContainerWidth<HTMLDivElement>();
  const innerRef = useRef<HTMLDivElement>(null);
  const [naturalPx, setNaturalPx] = useState(0);
  const zoomRef = useRef(1);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    // 內容的自然寬＝目前畫出來的寬 ÷ 目前倍率（CSS zoom 下 getBoundingClientRect 是縮放後的大小）。
    const update = () => {
      const w = el.getBoundingClientRect().width / (zoomRef.current || 1);
      if (w > 0) setNaturalPx(Math.round(w));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const result = resolveFit(mode, containerPx, naturalPx, baseFontPx);
  zoomRef.current = result.zoom;

  return (
    <div className={className}>
      <FitModeBar mode={mode} onChange={setMode} result={result} className="mb-2" />
      <div ref={outerRef} className="overflow-x-auto pb-2">
        <div ref={innerRef} className="fit-zoom-inner" style={{ width: "max-content", zoom: result.zoom === 1 ? undefined : result.zoom }}>
          {children}
        </div>
      </div>
    </div>
  );
}
