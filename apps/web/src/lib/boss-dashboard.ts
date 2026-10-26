/**
 * 後台首頁（app/admin/page.tsx）的純函式：數字格式、頂部 4 個大數字、「需要你處理」清單、下鑽連結、下游頁面讀網址篩選。
 * 全部無 React、無 IO，有 vitest（lib/__tests__/boss-dashboard.test.ts）。
 *
 * 2026-10-25 業主說舊版「太複雜」→ 首頁只剩兩塊（老闆 10 秒看懂）：
 *   1. 頂部 4 個大數字（headlineTiles）：依版本（homeViewerOf，2026-10-26 老闆與一般 HR 分開）——
 *      可看集團財務：本年收入／待簽核／未收款／在職人數；一般 HR：待簽核／本月出勤異常／未收款／在職人數；
 *      會計：本月放款支出／待簽核／未收款／本月出勤異常。
 *   2. 「需要你處理」清單（todoItems）：只列數量 > 0 的項目，一行一項；老闆多兩項專屬待辦（獎金批次待核准、遲到說明待決定）放最前。
 * 資料：GET /dashboard/boss-summary（全部角色）＋ GET /group-overview（僅可看集團財務者，只取本年收入與毛利率）。
 * 每格各自降級：讀不到就顯示「—」不擋其他格；boss-summary 404（API 舊版）時待簽核退回只算假單。
 */
import { ADMIN_TABS, isModuleEnabled, resolveAdminPath, type AdminModulesConfig } from "./admin-nav";
import type { BossSummary } from "./dashboard-api";

/* ------------------------------------------------------------- 格式 --- */

/**
 * 首頁統一的金額格式：絕對值滿一萬改用「萬」（最多一位小數，千分位），未滿一萬顯示到元（千分位）；
 * null／undefined／非有限數 →「—」。四捨五入成 0 的負數不顯示「-0」。
 */
export function fmtWan(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) {
    const wan = Math.round(n / 1_000) / 10;
    return `${wan.toLocaleString("zh-TW", { maximumFractionDigits: 1 })} 萬`;
  }
  const rounded = Math.round(n);
  return (rounded === 0 ? 0 : rounded).toLocaleString("zh-TW");
}

/** 件數／人數：千分位；null →「—」。 */
export function fmtCount(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("zh-TW");
}

/** 百分比一位小數；null →「—」。 */
export function fmtPct1(p: number | null | undefined): string {
  return p == null || !Number.isFinite(p) ? "—" : `${p.toFixed(1)}%`;
}

/** 數字要不要標成「需要處理」的顏色：> 0 才標。 */
export function needsAttention(n: number | null | undefined): boolean {
  return n != null && n > 0;
}

/* ---------------------------------------------------------- 載入狀態 --- */

export type Load<T> = { loading: boolean; error: string | null; data: T | null };

/** boss-summary 的載入狀態；outdated＝API 還是舊版（404）。 */
export type SummaryLoad = Load<BossSummary> & { outdated?: boolean };

/** 連到的後台頁能不能開（角色 isAdminPathAllowed ＋ 租戶模組開關 homeLinkModuleEnabled）；page.tsx 組好傳進來。 */
export type LinkOn = (href: string) => boolean;

/** GET /group-overview 首頁用得到的最小子集（本年收入、毛利率、公司家數）。 */
export interface GroupOverviewLite {
  period: { year: number };
  companies: Array<{ id: string; isActive: boolean; excluded?: boolean; revenue: number; expense: number }>;
  group: { revenue: number; grossMarginPct: number | null };
}

/* ---------------------------------------------------------- 下鑽連結 --- */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const bossLinks = {
  groupOverview: "/admin/group-overview",
  leaveApprovals: "/admin/approvals?status=pending",
  disbursementApprovals: "/admin/disbursements/approvals?scope=all",
  disbursements: "/admin/disbursements",
  receivables: "/admin/projects/receivables",
  attendanceSheets: "/admin/attendance-sheets",
  attendanceAnomalies: (period: string) => `/admin/attendance-sheets?period=${encodeURIComponent(period)}&anomaly=1`,
  /** 待發加班另計是「所有月份」的草稿合計 → 另計頁開「未付款＋所有月份」。 */
  overtimeDrafts: "/admin/overtime-settlements?status=draft&all=1",
  employees: "/admin/employees",
  /** 老闆專屬：獎金批次列表（老闆在批次頁核准）；角色開不了後台那頁時改連 ESS 簽核頁。 */
  bonusRuns: "/admin/bonus-runs",
  /** 老闆專屬：遲到說明（老闆在這頁決定是否影響全勤）；開不了時改連 ESS 簽核頁。 */
  lateReports: "/admin/late-reports",
  essApprovals: "/ess/approvals",
} as const;

/* ------------------------------------------------------- 頂部大數字 --- */

export type Tone = "normal" | "attention" | "danger";

export interface HeadlineTile {
  key: "revenue" | "monthDisbursements" | "approvals" | "receivables" | "people" | "attendance";
  label: string;
  loading: boolean;
  /** 讀不到（錯誤、舊 API、子查詢失敗）→「—」。 */
  value: string;
  sub: string | null;
  /** 多家公司時「本年收入」下的小字。 */
  note: string | null;
  /** 角色／模組開不了那一頁 → null（格子照畫、不能點）。 */
  href: string | null;
  tone: Tone;
}

/**
 * 首頁版本（2026-10-26 業主：老闆與一般 HR 分開）：
 *   • group＝可看集團財務（老闆、看得到集團財務的 HR、平台管理員）：本年收入／待簽核／未收款／在職人數；
 *   • hr＝一般 HR（看不到集團財務）：待簽核／本月出勤異常／未收款／在職人數——不顯示收入、毛利率，也不打 /group-overview；
 *   • finance＝會計（維持現狀）：本月放款支出／待簽核／未收款／本月出勤異常。
 * 老闆專屬待辦不看版本，看 summary.scope.isBoss（todoItems）。
 */
export type HomeViewer = "group" | "hr" | "finance";

/**
 * 決定首頁版本。可不可以看集團財務：先看 /me.canSeeGroupFinancials（最早知道，收入那格不用等 boss-summary），
 * 沒有就看 boss-summary 的 scope.groupFinancials；兩個都還沒有 → null（畫骨架、先不打 /group-overview）。
 * 舊 API（boss-summary 404、或 scope 沒有 groupFinancials 欄）／boss-summary 失敗 → 退回舊判斷（HR／平台管理員＝可看）。
 * 會計（及其他非 HR 角色）一律 finance。
 */
export function homeViewerOf(input: {
  role: string | null | undefined;
  /** /me.canSeeGroupFinancials；舊 API 沒有 → undefined。 */
  canSeeGroupFinancials: boolean | null | undefined;
  summary: SummaryLoad;
}): HomeViewer | null {
  const { role, canSeeGroupFinancials, summary } = input;
  if (role !== "hr_admin" && role !== "platform_admin") return "finance";
  if (typeof canSeeGroupFinancials === "boolean") return canSeeGroupFinancials ? "group" : "hr";
  const fromSummary = summary.data?.scope.groupFinancials;
  if (typeof fromSummary === "boolean") return fromSummary ? "group" : "hr";
  if (summary.loading) return null;
  return "group";
}

/** 有實際營運的公司家數（停用且整年沒數字的不算、被排除的不算）。 */
export function activeCompanyCount(overview: GroupOverviewLite): number {
  return overview.companies.filter((c) => !c.excluded && (c.isActive || c.revenue !== 0 || c.expense !== 0)).length;
}

type ScopeKey = keyof BossSummary["scope"];

/**
 * 頂部大數字（最多 4 格，順序依版本固定，見 HomeViewer）。
 * 格子要不要畫：boss-summary 回來後看 scope（false＝這個角色沒權限 → 不畫）；還沒回來／失敗／舊 API → 看角色開不開得了那一頁。
 */
export function headlineTiles(input: {
  viewer: HomeViewer;
  summary: SummaryLoad;
  /** 只有 group 版會用到（其他版本不打 /group-overview）。 */
  overview: Load<GroupOverviewLite>;
  /** boss-summary 404 時退回的待簽假單數。 */
  pendingLeave: Load<number>;
  linkOn: LinkOn;
}): HeadlineTile[] {
  const { viewer, summary, overview, pendingLeave, linkOn } = input;
  const s = summary.outdated || summary.error ? null : summary.data;
  const href = (path: string, gate = path) => (linkOn(gate) ? path : null);
  const visible = (key: ScopeKey, gate: string) => (s ? s.scope[key] !== false : linkOn(gate));
  const tile = (t: Omit<HeadlineTile, "note"> & { note?: string | null }): HeadlineTile => ({ note: null, ...t });

  const revenue = (): HeadlineTile | null => {
    const o = overview.error ? null : overview.data;
    const n = o ? activeCompanyCount(o) : 0;
    return tile({
      key: "revenue",
      label: "本年收入",
      loading: overview.loading,
      value: fmtWan(o?.group.revenue),
      sub: o ? `毛利率 ${fmtPct1(o.group.grossMarginPct)}` : null,
      note: n > 1 ? `${n} 家公司・點看各公司` : null,
      href: href(bossLinks.groupOverview),
      tone: "normal",
    });
  };

  const monthDisbursements = (): HeadlineTile | null => {
    if (!visible("monthDisbursements", bossLinks.disbursements)) return null;
    const d = s?.monthDisbursements ?? null;
    return tile({
      key: "monthDisbursements",
      label: "本月放款支出",
      loading: summary.loading,
      value: fmtWan(d?.amount),
      sub: d ? `${fmtCount(d.count)} 筆已匯款` : null,
      href: href(bossLinks.disbursements),
      tone: "normal",
    });
  };

  // 待簽核（假單＋放款）
  const approvals = (): HeadlineTile | null => {
    if (summary.outdated) {
      if (!linkOn(bossLinks.leaveApprovals)) return null;
      const n = pendingLeave.error ? null : pendingLeave.data;
      return tile({
        key: "approvals",
        label: "待簽核",
        loading: pendingLeave.loading,
        value: fmtCount(n),
        sub: n == null ? null : `假單 ${fmtCount(n)}`,
        href: bossLinks.leaveApprovals,
        tone: needsAttention(n) ? "attention" : "normal",
      });
    }
    const showLeave = visible("leaveApprovals", bossLinks.leaveApprovals);
    const showDisb = visible("disbursementApprovals", bossLinks.disbursementApprovals);
    if (!showLeave && !showDisb) return null;
    const a = s?.approvals ?? null;
    // 任一有權限的子項查詢失敗（null）→ 合計不可信，整格「—」；副標只列查得到的部分。
    const partial = !!a && ((showLeave && a.leave === null) || (showDisb && a.disbursements === null));
    const parts: string[] = [];
    if (a && showLeave && a.leave !== null) parts.push(`假單 ${fmtCount(a.leave)}`);
    if (a && showDisb && a.disbursements !== null) parts.push(`放款 ${fmtCount(a.disbursements)}`);
    const total = partial ? null : a?.total;
    return tile({
      key: "approvals",
      label: "待簽核",
      loading: summary.loading,
      value: fmtCount(total),
      sub: parts.length > 0 ? parts.join("・") : null,
      href: showLeave ? href(bossLinks.leaveApprovals) : href(bossLinks.disbursementApprovals),
      tone: needsAttention(total) ? "attention" : "normal",
    });
  };

  const receivables = (): HeadlineTile | null => {
    if (!visible("receivables", bossLinks.receivables)) return null;
    const r = s?.receivables ?? null;
    return tile({
      key: "receivables",
      label: "未收款",
      loading: summary.loading,
      value: fmtWan(r?.unreceivedTotal),
      sub: r ? `逾期 ${fmtCount(r.overdueCount)} 筆` : null,
      href: href(bossLinks.receivables),
      tone: needsAttention(r?.overdueCount) ? "attention" : "normal",
    });
  };

  const people = (): HeadlineTile | null => {
    if (!visible("people", bossLinks.employees)) return null;
    const p = s?.people ?? null;
    return tile({
      key: "people",
      label: "在職人數",
      loading: summary.loading,
      value: fmtCount(p?.active),
      sub: p ? `本月 +${fmtCount(p.hires)} / −${fmtCount(p.exits)}` : null,
      href: href(bossLinks.employees),
      tone: "normal",
    });
  };

  const attendance = (): HeadlineTile | null => {
    if (!visible("attendance", bossLinks.attendanceSheets)) return null;
    const att = s?.attendance ?? null;
    return tile({
      key: "attendance",
      label: "本月出勤異常",
      loading: summary.loading,
      value: fmtCount(att?.anomalies),
      sub: att ? (att.sheetCount === 0 ? "本月月表尚未產生" : `${fmtCount(att.anomalySheets)} 張月表有異常`) : null,
      href: s ? href(bossLinks.attendanceAnomalies(s.period), bossLinks.attendanceSheets) : null,
      tone: needsAttention(att?.anomalies) ? "attention" : "normal",
    });
  };

  const layout: Record<HomeViewer, Array<() => HeadlineTile | null>> = {
    group: [revenue, approvals, receivables, people],
    hr: [approvals, attendance, receivables, people],
    finance: [monthDisbursements, approvals, receivables, attendance],
  };
  return layout[viewer].map((build) => build()).filter((t): t is HeadlineTile => t !== null);
}

/* ------------------------------------------------------ 需要你處理 --- */

export type TodoIcon = "alert" | "approval" | "money" | "clock" | "project";

export interface TodoItem {
  key: "bonusRuns" | "lateReports" | "compliance" | "leave" | "disbursements" | "overCap" | "overtimeDrafts" | "anomalies";
  icon: TodoIcon;
  text: string;
  /** 數字＋單位，例如「44 張」。 */
  count: string;
  href: string;
  tone: "danger" | "attention";
}

/** 清單預設顯示幾行，其餘收在「查看全部」。 */
export const TODO_LIMIT = 6;

/**
 * 「需要你處理」：只列數量 > 0、且這個角色／模組開得了目標頁的項目，先急後緩
 * （老闆專屬待辦 → 合規 → 簽核 → 加班 → 出勤異常）。
 * 老闆專屬待辦只看 summary.bossTodo（後端 scope.isBoss 才給）：獎金批次待核准、遲到說明待決定；
 * 後台那頁開不了時改連 ESS 簽核頁（老闆在那裡也能核准／決定），所以一定列得出來。
 * boss-summary 404（舊 API）時只剩假單（pendingLeave）。
 */
export function todoItems(input: { summary: SummaryLoad; pendingLeave: Load<number>; linkOn: LinkOn }): TodoItem[] {
  const { summary, pendingLeave, linkOn } = input;
  const items: TodoItem[] = [];
  /** gate＝null：目標頁不用再檢查（已選好開得了的頁）。 */
  const push = (gate: string | null, n: number | null | undefined, item: Omit<TodoItem, "count"> & { unit: string }) => {
    if (!needsAttention(n) || (gate !== null && !linkOn(gate))) return;
    const { unit, ...rest } = item;
    items.push({ ...rest, count: `${fmtCount(n)} ${unit}` });
  };

  if (summary.outdated) {
    push(bossLinks.leaveApprovals, pendingLeave.data, { key: "leave", icon: "approval", text: "假單待簽核", unit: "張", href: bossLinks.leaveApprovals, tone: "attention" });
    return items;
  }
  const s = summary.data;
  if (!s) return items;
  const sheets = bossLinks.attendanceAnomalies(s.period);
  const att = s.attendance;
  const ot = s.overtime;
  const boss = s.bossTodo ?? null;

  if (boss) {
    const bonusHref = linkOn(bossLinks.bonusRuns) ? bossLinks.bonusRuns : bossLinks.essApprovals;
    const lateHref = linkOn(bossLinks.lateReports) ? bossLinks.lateReports : bossLinks.essApprovals;
    push(null, boss.bonusRunsPendingApproval, { key: "bonusRuns", icon: "money", text: "獎金批次待你核准", unit: "批", href: bonusHref, tone: "attention" });
    push(null, boss.lateReportsPending, { key: "lateReports", icon: "clock", text: "遲到說明待你決定", unit: "筆", href: lateHref, tone: "attention" });
  }

  push(bossLinks.attendanceSheets, att?.compliance.total, { key: "compliance", icon: "alert", text: "合規警示（七休一、工時等）", unit: "筆", href: sheets, tone: "danger" });
  push(bossLinks.leaveApprovals, s.approvals.leave, { key: "leave", icon: "approval", text: "假單待簽核", unit: "張", href: bossLinks.leaveApprovals, tone: "attention" });
  push(bossLinks.disbursementApprovals, s.approvals.disbursements, {
    key: "disbursements",
    icon: "approval",
    text: s.approvals.disbursementAmount ? `放款單待簽核・NT$ ${fmtWan(s.approvals.disbursementAmount)}` : "放款單待簽核",
    unit: "張",
    href: bossLinks.disbursementApprovals,
    tone: "attention",
  });
  push(bossLinks.attendanceSheets, ot?.overCapPeople, { key: "overCap", icon: "clock", text: "加班超過月上限", unit: "人", href: sheets, tone: "attention" });
  push(bossLinks.overtimeDrafts, ot?.draftCount, {
    key: "overtimeDrafts",
    icon: "money",
    text: `加班另計待發放${ot?.draftAmount ? `・NT$ ${fmtWan(ot.draftAmount)}` : ""}${ot?.draftMissingAmount ? `（${fmtCount(ot.draftMissingAmount)} 筆未填金額）` : ""}`,
    unit: "筆",
    href: bossLinks.overtimeDrafts,
    tone: "attention",
  });
  push(bossLinks.attendanceSheets, att?.anomalies, { key: "anomalies", icon: "clock", text: "出勤異常", unit: "件", href: sheets, tone: "attention" });
  return items;
}

/**
 * 「需要你處理」的資料是否不完整：清單用到的欄位裡，有權限（scope true）卻是 null（子查詢失敗）的任何一個；
 * 舊 API（404）時看假單後備有沒有讀到。清單為空時據此顯示「部分資料讀不到」而不是綠色 ✓
 * （讀不到不代表沒事）。boss-summary 整支失敗另由畫面顯示「暫時讀不到」。
 */
export function todoDataIncomplete(input: { summary: SummaryLoad; pendingLeave: Load<number> }): boolean {
  const { summary, pendingLeave } = input;
  if (summary.outdated) return !!pendingLeave.error;
  const s = summary.data;
  if (!s) return false;
  const sc = s.scope;
  return (
    (sc.leaveApprovals && s.approvals.leave === null) ||
    (sc.disbursementApprovals && s.approvals.disbursements === null) ||
    (sc.attendance && s.attendance === null) ||
    (sc.overtime && (s.overtime === null || s.overtime.overCapPeople === null || s.overtime.draftCount === null)) ||
    (sc.isBoss === true && (!s.bossTodo || s.bossTodo.bonusRunsPendingApproval === null || s.bossTodo.lateReportsPending === null))
  );
}

/* ---------------------------------------------------------- 模組開關 --- */

/**
 * 首頁卡片連到的後台頁所屬分頁是否啟用（tenants.features.adminModules；分頁沒掛 module＝永遠啟用）。
 * 不看角色（角色另由 isAdminPathAllowed 判斷）；未知路徑、首頁 → true。
 */
export function homeLinkModuleEnabled(href: string, modules: AdminModulesConfig | null | undefined): boolean {
  const resolved = resolveAdminPath(href);
  if (resolved.route.exact || resolved.tab === null) return true;
  const tab = ADMIN_TABS[resolved.section].find((t) => t.key === resolved.tab);
  return isModuleEnabled(modules, tab?.module);
}

/* -------------------------------------------- 下游頁面讀網址篩選（首頁帶過去的） --- */

/** `?period=YYYY-MM`；格式不對或沒帶 → null。 */
export function readPeriodParam(search: string): string | null {
  const v = new URLSearchParams(search).get("period");
  return v && PERIOD_RE.test(v) ? v : null;
}

/** `?name=1`／`true` → true。 */
export function readFlagParam(search: string, name: string): boolean {
  const v = new URLSearchParams(search).get(name);
  return v === "1" || v === "true";
}

/** `?name=` 屬於 allowed 之一才回傳，否則 null。 */
export function readEnumParam<T extends string>(search: string, name: string, allowed: readonly T[]): T | null {
  const v = new URLSearchParams(search).get(name);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}
