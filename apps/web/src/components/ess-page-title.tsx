"use client";

/**
 * 頁面覆寫 ESS 手機頂部列標題（2026-10-12）。
 *
 * EssShell 持有覆寫值、用 `EssPageTitleContext` 把設定函式交給底下的頁面；頁面呼叫
 * `useEssPageTitle(title)`：掛載與 title 改變時設定、卸載時清掉（回到路由表的標題）。
 * 顯示規則（綁 pathname、空白退回路由表）在 lib/ess-page-title.ts 的 resolveEssHeaderTitle。
 *
 * 不在 EssShell 用 useSearchParams 推標題：那要在 layout 包 Suspense；改由頁面依自己的 state 設定。
 */
import { createContext, useContext, useEffect, useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import type { EssTitleOverride } from "@/lib/ess-page-title";

/** EssShell 提供的設定函式；不在 EssShell 底下（例如單獨渲染）時是 null，hook 什麼都不做。 */
export const EssPageTitleContext = createContext<((next: EssTitleOverride | null) => void) | null>(null);

// 瀏覽器用 useLayoutEffect：標題在畫面畫出來之前就換好（深連結 ?kind=fix_punch 不會先閃一下「請假申請」）；
// 伺服器端沒有 layout effect，退回 useEffect（伺服器上本來就不執行）。
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 設定本頁的頂部列標題；null／空字串＝用路由表的標題。覆寫綁著當下的 pathname，換頁不會帶到下一頁。
 */
export function useEssPageTitle(title: string | null | undefined): void {
  const setOverride = useContext(EssPageTitleContext);
  const pathname = usePathname() ?? "/ess";
  useIsomorphicLayoutEffect(() => {
    if (!setOverride) return;
    const text = title?.trim() ?? "";
    setOverride(text ? { path: pathname, title: text } : null);
    return () => setOverride(null);
  }, [setOverride, pathname, title]);
}
