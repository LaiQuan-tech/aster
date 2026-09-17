"use client";

/**
 * 相容 shim（2026-09 ESS 簡化後）。
 *
 * 頂部列／分頁列已移到 app/ess/layout.tsx → EssShell；分頁常數搬到 lib/ess-tabs.ts，
 * 共用狀態搬到 lib/ess-state.ts。這個檔案只為了讓還沒遷移的 ESS 頁面（仍然
 * `<EssHeader … />`、`invalidateEssHeaderState()`）維持可編譯：
 *   - `ESS_TABS`／`INTERN_DEFAULT_ESS_TABS`／`EssTabKey` 原地重新匯出。
 *   - `invalidateEssHeaderState` ＝ `invalidateEssState`。
 *   - `EssHeader` 什麼都不畫（shell 已經畫了），props 照收不用。
 * 所有頁面遷移完（WP7 grep 清零）即可刪除本檔。新程式請直接 import 上述兩個 lib。
 */
import { invalidateEssState } from "@/lib/ess-state";
import type { EssTabKey } from "@/lib/ess-tabs";

export { ESS_TABS, INTERN_DEFAULT_ESS_TABS, type EssTab, type EssTabKey } from "@/lib/ess-tabs";

export const invalidateEssHeaderState = invalidateEssState;

export function EssHeader(_props: {
  appName?: string;
  primaryColor?: string;
  active?: EssTabKey;
  isAdmin?: boolean;
}) {
  return null;
}
