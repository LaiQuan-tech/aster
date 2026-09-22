/**
 * ESS 分頁／路由的單一來源（純函式，不碰 React；全部有單元測試）。
 *
 * 2026-09 簡化版資訊架構：手機底部分頁列只放「打卡・請假・（簽核）・通知・更多」，
 * 其餘分頁收進 /ess/more 的分組清單；桌機同一組項目改成頂部水平導覽。
 * 這個檔案負責：
 *   - `ESS_TABS`：所有分頁的 key／標籤／路徑（key 是穩定的公開字串，後台
 *     tenants.features.essTabs 用它限縮各身分類別可見的分頁，**不要改名**）。
 *   - `visibleTabs()`：依 GET /me 的 essTabs 過濾。
 *   - `bottomTabs()`／`moreGroups()`：底部分頁列與「更多」頁的內容。
 *   - `routeForPath()`／`parentPathFor()`：layout 依 pathname 決定標題、寬度、
 *     gate 與返回鍵目標。
 */
export type EssTabKey =
  | "home"
  | "schedule"
  | "punches"
  | "sheet"
  | "balances"
  | "requests"
  | "approvals"
  | "projects"
  | "bonus"
  | "payslips"
  | "expenses"
  | "kpi"
  | "jobs"
  | "ai"
  | "company"
  | "notifications"
  | "mydata"
  | "announcements";

export interface EssTab {
  key: EssTabKey;
  label: string;
  /** 底部分頁列／窄版用的短標。 */
  short: string;
  href: string;
}

/**
 * 順序與 key 刻意不動（後台 module-settings 的 checkbox 順序、心智模型與管理端
 * 模組分組一致：差勤 → 專案 → 薪資 → 其他）；`announcements` 追加在最後。
 */
export const ESS_TABS: readonly EssTab[] = [
  { key: "home", label: "今日打卡", short: "打卡", href: "/ess" },
  { key: "schedule", label: "個人班表", short: "班表", href: "/ess/schedule" },
  { key: "punches", label: "打卡紀錄", short: "紀錄", href: "/ess/punches" },
  { key: "sheet", label: "出勤月表", short: "月表", href: "/ess/attendance-sheet" },
  { key: "balances", label: "剩餘假別", short: "假別", href: "/ess/balances" },
  { key: "requests", label: "請假申請", short: "請假", href: "/ess/requests" },
  // 只給「輪到我簽」的人看（主管／被指定的簽核者）；顯示條件見 bottomTabs()。
  { key: "approvals", label: "待我簽核", short: "簽核", href: "/ess/approvals" },
  { key: "projects", label: "專案知識庫", short: "專案", href: "/ess/projects" },
  { key: "bonus", label: "我的分潤", short: "分潤", href: "/ess/my-bonus" },
  { key: "payslips", label: "我的薪資單", short: "薪資", href: "/ess/payslips" },
  { key: "expenses", label: "費用報銷", short: "報銷", href: "/ess/expenses" },
  { key: "kpi", label: "我的考核", short: "考核", href: "/ess/kpi" },
  { key: "jobs", label: "內部職缺", short: "職缺", href: "/ess/jobs" },
  { key: "ai", label: "AI 問答", short: "AI", href: "/ess/ai" },
  { key: "company", label: "公司資訊", short: "公司", href: "/ess/company-info" },
  { key: "notifications", label: "通知中心", short: "通知", href: "/ess/notifications" },
  { key: "mydata", label: "我的資料", short: "資料", href: "/ess/mydata" },
  { key: "announcements", label: "公告", short: "公告", href: "/ess/announcements" },
];

/**
 * 不受 essTabs 限縮、永遠可見的分頁：
 *   - home：它是 /ess 本身，藏掉會讓人進站看不到任何分頁，而且工讀生也要打卡。
 *   - announcements：勞基法施行細則 §37 的揭示／發給義務，需簽收的規章任何身分都要看得到。
 * 後台 module-settings 的 checkbox 以此集合排除；layout 的頁面 gate 也不擋這兩個 key。
 */
export const ALWAYS_VISIBLE_TAB_KEYS: ReadonlySet<string> = new Set<string>(["home", "announcements"]);

export interface EssTabLike {
  key: string;
}

/**
 * ESS 分頁過濾。
 *
 * `allowedKeys` 來自 GET /me 的 `essTabs`（由 tenants.features.essTabs[employment_type]
 * 決定；intern 沒設定時後端給預設清單）。null／undefined＝不限縮，全部分頁可見。
 *
 * 規則：
 *   - 順序永遠照 `tabs` 原本的順序，不照 allowedKeys 的順序（心智模型跟後台一致）。
 *   - `ALWAYS_VISIBLE_TAB_KEYS`（home、announcements）永遠保留。
 *   - allowedKeys 裡不認得的 key 直接忽略（後台打錯字不會炸畫面）。
 */
export function visibleTabs<T extends EssTabLike>(
  tabs: readonly T[],
  allowedKeys: readonly string[] | null | undefined,
): T[] {
  if (allowedKeys == null) return [...tabs];
  const allowed = new Set(allowedKeys);
  return tabs.filter((tab) => ALWAYS_VISIBLE_TAB_KEYS.has(tab.key) || allowed.has(tab.key));
}

/* ------------------------------------------------------ 底部分頁列 --- */

/** 手機底部分頁列上的 ESS 分頁 key（順序即顯示順序；「更多」不是分頁，另外附加）。 */
export const BOTTOM_TAB_KEYS: readonly EssTabKey[] = ["home", "requests", "approvals", "notifications"];

export type BottomTabKey = EssTabKey | "more";

export interface BottomTab {
  key: BottomTabKey;
  label: string;
  href: string;
}

/** 「更多」入口（永遠在底列最後；不受 essTabs 限縮）。 */
export const MORE_TAB: BottomTab = { key: "more", label: "更多", href: "/ess/more" };

/**
 * 底部分頁列的內容：
 *   home（永遠）→ requests（過 essTabs）→ approvals（過 essTabs 且 isManager 或有待簽單）
 *   → notifications（過 essTabs）→ more（永遠）。
 * 徽章數字（待簽／未讀）由 shell 依 key 另外貼上，不放在這裡。
 */
export function bottomTabs(input: {
  essTabs: readonly string[] | null | undefined;
  isManager: boolean;
  pendingApprovals: number;
}): BottomTab[] {
  const allowed = new Set(visibleTabs(ESS_TABS, input.essTabs).map((t) => t.key));
  const showApprovals = input.isManager || input.pendingApprovals > 0;
  const out: BottomTab[] = [];
  for (const key of BOTTOM_TAB_KEYS) {
    if (!allowed.has(key)) continue;
    if (key === "approvals" && !showApprovals) continue;
    const tab = ESS_TABS.find((t) => t.key === key);
    if (tab) out.push({ key: tab.key, label: tab.short, href: tab.href });
  }
  out.push(MORE_TAB);
  return out;
}

/* --------------------------------------------------------- 更多頁 --- */

export interface EssMoreGroupDef {
  title: string;
  keys: readonly EssTabKey[];
}

/**
 * 「更多」頁的分組（順序即顯示順序）。底列上的 key 不列在這裡（就算列了
 * moreGroups() 也會剔除）；內部連結那組來自 tenants.features.internalLinks，
 * 由頁面自己接在後面。
 */
export const MORE_GROUPS: readonly EssMoreGroupDef[] = [
  { title: "差勤", keys: ["punches", "schedule", "sheet", "balances"] },
  { title: "薪資與費用", keys: ["payslips", "expenses", "bonus"] },
  { title: "公司", keys: ["announcements", "company", "jobs", "projects", "ai"] },
  { title: "個人", keys: ["kpi", "mydata"] },
];

export interface EssMoreGroup {
  title: string;
  items: EssTab[];
}

/** 依 essTabs 過濾後的「更多」分組：空組不回傳、底列 key 不重列。 */
export function moreGroups(essTabs: readonly string[] | null | undefined): EssMoreGroup[] {
  const visible = new Map(visibleTabs(ESS_TABS, essTabs).map((t) => [t.key, t] as const));
  const bottom = new Set<string>(BOTTOM_TAB_KEYS);
  const out: EssMoreGroup[] = [];
  for (const group of MORE_GROUPS) {
    const items: EssTab[] = [];
    for (const key of group.keys) {
      if (bottom.has(key)) continue;
      const tab = visible.get(key);
      if (tab) items.push(tab);
    }
    if (items.length > 0) out.push({ title: group.title, items });
  }
  return out;
}

/* ----------------------------------------------------------- 路由 --- */

export interface EssRoute {
  /** 路徑前綴（`/ess/projects` 也涵蓋 `/ess/projects/[id]`）。 */
  prefix: string;
  /** 對應的分頁 key；null＝不是分頁（/ess/more、未知路徑），layout 不做 gate。 */
  key: EssTabKey | null;
  /** 頂部列標題；空字串＝顯示租戶 appName（首頁與未知路徑）。 */
  title: string;
  /** 寬版內容（月表、班表的桌機月曆）；layout 用 max-w-6xl 取代 max-w-3xl。 */
  wide?: boolean;
}

const WIDE_KEYS: ReadonlySet<EssTabKey> = new Set<EssTabKey>(["sheet", "schedule"]);

const UNKNOWN_ROUTE: EssRoute = { prefix: "/ess", key: null, title: "" };

export const ESS_ROUTES: readonly EssRoute[] = [
  ...ESS_TABS.map<EssRoute>((tab) => ({
    prefix: tab.href,
    key: tab.key,
    title: tab.key === "home" ? "" : tab.label,
    ...(WIDE_KEYS.has(tab.key) ? { wide: true } : {}),
  })),
  { prefix: MORE_TAB.href, key: null, title: MORE_TAB.label },
];

function normalizePath(pathname: string): string {
  const noQuery = pathname.split(/[?#]/, 1)[0] ?? "";
  const trimmed = noQuery.length > 1 ? noQuery.replace(/\/+$/, "") : noQuery;
  return trimmed || "/";
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * 依 pathname 找對應路由：最長前綴優先（`/ess/attendance-sheet/123` → sheet，
 * 不會被 `/ess` 搶走）。找不到 → `{ prefix: "/ess", key: null, title: "" }`。
 */
export function routeForPath(pathname: string): EssRoute {
  const path = normalizePath(pathname);
  let best: EssRoute | null = null;
  for (const route of ESS_ROUTES) {
    if (!matchesPrefix(path, route.prefix)) continue;
    if (!best || route.prefix.length > best.prefix.length) best = route;
  }
  if (!best) return UNKNOWN_ROUTE;
  // `/ess` 只在精準相符時才算首頁；`/ess/whatever`（未知子路徑）算未知路徑。
  if (best.key === "home" && path !== best.prefix) return UNKNOWN_ROUTE;
  return best;
}

/**
 * 手機頂部列返回鍵的目標：動態子頁回到自己的列表（`/ess/projects/[id]` →
 * `/ess/projects`、`/ess/attendance-sheet/[id]` → `/ess/attendance-sheet`），
 * 其他一律回「更多」。
 */
export function parentPathFor(pathname: string): string {
  const path = normalizePath(pathname);
  const route = routeForPath(path);
  if (route.key !== null && path !== route.prefix) return route.prefix;
  return MORE_TAB.href;
}

/** 底列根路徑（/ess、/ess/requests、/ess/approvals、/ess/notifications、/ess/more）：頂部列不顯示返回鍵。 */
export function isBottomRootPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (path === MORE_TAB.href) return true;
  return ESS_TABS.some((tab) => BOTTOM_TAB_KEYS.includes(tab.key) && tab.href === path);
}

/* ------------------------------------------------- 身分類別（後台用）--- */

/**
 * 身分類別（employees.employment_type）：目前系統只有這四種可指派值（來源：
 * app/admin/employees/page.tsx 新增員工表單的下拉選單），後台「員工端功能
 * 開放」（module-settings 頁）只針對這四類各給一排 checkbox。
 *
 * `parttime` 同時涵蓋客戶說的「工讀生」（M12，2026-09-23）：時薪制、勞健保依級距表
 * 自動選級（規則 insurance.brackets）；不另開值域，標籤寫明即可。
 */
export const EMPLOYMENT_TYPES = ["regular", "parttime", "contract", "intern"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  regular: "正職",
  parttime: "工讀／兼職（時薪）",
  contract: "約聘",
  intern: "實習",
};

/**
 * intern 在 tenants.features.essTabs 沒有設定時的後端預設值，鏡射
 * apps/api/src/routes/me.ts:9 的 INTERN_DEFAULT_ESS_TABS——後台用它當 intern
 * 排的預設勾選狀態。兩邊是各自檔案裡的常數（web 不能 import api），**改這份
 * 清單要同步改 apps/api/src/routes/me.ts:9**。`home`／`announcements` 不在清單裡
 * 也永遠可見（見 ALWAYS_VISIBLE_TAB_KEYS）。
 */
export const INTERN_DEFAULT_ESS_TABS: readonly string[] = [
  "home",
  "schedule",
  "punches",
  "requests",
  "notifications",
  "mydata",
];
