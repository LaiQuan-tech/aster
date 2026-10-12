/**
 * ESS 手機頂部列標題（純函式，不碰 React；有單元測試）。
 *
 * 標題預設來自路由表（lib/ess-tabs.ts 的 routeForPath，只看 pathname）；少數頁面要依頁內狀態換標題
 * （2026-10-12：/ess/requests 依申請種類顯示「補卡申請」「加班申請」…，以前一律「請假申請」），
 * 就由頁面透過 components/ess-page-title.tsx 的 `useEssPageTitle` 設一個覆寫值。
 *
 * 覆寫值綁著設定它的 pathname：換頁那一瞬間，上一頁的覆寫就算還沒清掉也不會顯示在新頁。
 * 路由表的標題（ess-tabs.ts 的 label）本身不動——它同時是後台「員工端功能開放」的勾選名稱。
 */

export interface EssTitleOverride {
  /** 設定覆寫的頁面路徑（usePathname）。 */
  path: string;
  title: string;
}

/**
 * 頂部列要顯示的標題：同一路徑的頁面覆寫 → 路由表標題 → 租戶 appName。
 * `isAppName`＝顯示的是 appName（首頁／未知路徑；EssShell 用品牌色）。
 */
export function resolveEssHeaderTitle(input: {
  pathname: string;
  override: EssTitleOverride | null | undefined;
  routeTitle: string;
  appName: string;
}): { title: string; isAppName: boolean } {
  const override = input.override;
  const overrideTitle = override && override.path === input.pathname ? override.title.trim() : "";
  if (overrideTitle) return { title: overrideTitle, isAppName: false };
  if (input.routeTitle) return { title: input.routeTitle, isAppName: false };
  return { title: input.appName, isAppName: true };
}
