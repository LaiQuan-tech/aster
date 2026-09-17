"use client";

import type { ReactNode } from "react";
import type { EssTabKey } from "@/lib/ess-tabs";

/**
 * 相容 shim（2026-09 ESS 簡化後）。
 *
 * 登入守門與分頁 gate 都移到 app/ess/layout.tsx → EssShell（依 routeForPath(pathname)
 * 判斷，一律 optimistic）。這裡直接回傳 children，只為了讓還沒遷移的頁面維持可編譯；
 * `tab`／`optimistic` 照收不用。所有頁面遷移完（WP7 grep 清零）即可刪除本檔。
 */
export function EssTabGate({
  children,
}: {
  tab: EssTabKey;
  optimistic?: boolean;
  children: ReactNode;
}) {
  return <>{children}</>;
}
