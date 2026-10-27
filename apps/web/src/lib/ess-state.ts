"use client";

/**
 * ESS 全站共用狀態（/me、租戶品牌、待簽筆數、未讀通知數）的模組層快取。
 *
 * 動機：舊版每個 ESS 頁面各自打 /me＋branding＋pending-approvals（換一頁約 3 次 /me）。
 * 現在只有 EssShell（layout）與少數頁面呼叫 `useEssState()`，資料放在模組層：
 *   - `me`／`branding`：直到 `resetEssState()`（登出）前只抓一次。
 *   - 計數（pendingApprovals／unreadNotifications／pendingLateReports）：TTL 30 秒；分頁回到前景
 *     （visibilitychange）時過期就重抓；簽核／決定遲到說明／標記已讀後呼叫 `invalidateEssState()`
 *     立刻重抓，徽章在同一頁就會更新。
 *   - `pendingLateReports`（2026-10-12）：老闆待決定的遲到說明筆數，員工端「簽核」紅點＝它＋pendingApprovals
 *     （lib/ess-badges.ts）。要先知道是不是老闆（/me＋branding 回來）才抓，所以是同一輪 load 的第二段；
 *     不是老闆不抓、恆為 0；抓失敗當 0，不影響其他欄位。pendingApprovals 的語意不變（後台也在用）。
 *   - `getMeCached()`／`getBrandingCached()` 給頁面直接拿資料用，in-flight 去重
 *     （同時多個呼叫只打一次）。整頁載入時 AuthGate（/me）與根 layout 的 TenantBranding
 *     （branding）也走這兩個——它們最先發出請求，後面的 AdminGate／AdminShell／EssShell 都直接
 *     命中快取，整頁只打一次 /me、一次 branding（2026-09-30 以前兩者各自直打，每頁各多一次，
 *     而且 AdminGate 的 /me 要等 AuthGate 那次回來才開始，白等一輪）。
 *   - `peekMeCached()`：同步讀目前的 /me 快取，給守門元件掛載當下決定要不要先畫「載入中」。
 *   - `invalidateBranding()`：後台存完站台設定／進階功能（adminModules）後清 branding 快取
 *     並重抓，AdminShell 的側欄 appName 與分頁列同一頁就更新。
 * 所有 API 都是 best-effort：失敗一律退化（essTabs null＝不限縮、isAdmin false、
 * 計數 0），不擋頁面。
 *
 * 登出／登入是 client-side 導頁（login page 用 router.replace），模組快取會跨越兩位
 * 使用者：`resetEssState()` 除了清快取還把 generation +1，登出前還在途的回應一律丟棄。
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  getBranding,
  getMe,
  getPendingApprovals,
  getUnreadNotificationCount,
  isAdminRole,
  type Branding,
  type BrandingResponse,
  type Me,
} from "@/lib/ess-api";
import { countPendingLateReports } from "@/lib/ess-badges";
import { getLateReports } from "@/lib/late-reports-api";
import { isBossOrPlatformAdmin } from "@/lib/payroll-periods-api";

export interface EssState {
  /** 第一輪載入（四支 API 全部 settle）是否完成；完成前所有欄位是退化預設值。 */
  loaded: boolean;
  me: Me | null;
  /** HR／平台管理員（可進 /admin）。 */
  isAdmin: boolean;
  /** 任一部門主管（顯示「簽核」分頁）。 */
  isManager: boolean;
  /**
   * 老闆＝tenants.features.approval.fallbackApproverEmpId 就是我，或我是 platform_admin（2026-10-27 起視同老闆；
   * lib/payroll-periods-api.ts isBossOrPlatformAdmin）：簽核分頁永遠顯示，遲到說明／獎金批次由他決定。拿不到＝false。
   */
  isBoss: boolean;
  /** 可見分頁 key；null＝不限縮（也是 /me 未回或失敗時的預設）。 */
  essTabs: string[] | null;
  branding: Branding | null;
  /** tenants.features（internalLinks 等）。 */
  features: Record<string, unknown> | null;
  pendingApprovals: number;
  unreadNotifications: number;
  /**
   * 待我決定的遲到說明（老闆才有；GET /late-reports?decision=undecided，全公司、不分月份，canDecide 才算、
   * 排除自己，規則同簽核頁）。不是老闆或抓失敗＝0。只給員工端「簽核」紅點用，後台徽章不看它。
   */
  pendingLateReports: number;
}

const INITIAL_STATE: EssState = {
  loaded: false,
  me: null,
  isAdmin: false,
  isManager: false,
  isBoss: false,
  essTabs: null,
  branding: null,
  features: null,
  pendingApprovals: 0,
  unreadNotifications: 0,
  pendingLateReports: 0,
};

const COUNTS_TTL_MS = 30_000;

/* ------------------------------------------------------- 模組層快取 --- */

let snapshot: EssState = INITIAL_STATE;
const listeners = new Set<() => void>();

/** 每次 resetEssState() +1；在途回應若 generation 不符就丟棄。 */
let generation = 0;

let meCache: Me | null = null;
let meInflight: Promise<Me> | null = null;

let brandingCache: BrandingResponse | null = null;
let brandingInflight: Promise<BrandingResponse> | null = null;

/** 計數最後一次抓取（成功或失敗退化）的時間；null＝從未抓過／已被 invalidate。 */
let countsAt: number | null = null;
let loadInflight: Promise<void> | null = null;
/** load 進行中時收到 invalidate：跑完再補一輪。 */
let reloadPending = false;

function emit() {
  for (const notify of listeners) notify();
}

function setSnapshot(patch: Partial<EssState>) {
  snapshot = { ...snapshot, ...patch };
  emit();
}

/** GET /me，快取到 reset 為止；in-flight 去重。失敗會 reject（呼叫端自行退化）。 */
export function getMeCached(): Promise<Me> {
  if (meCache) return Promise.resolve(meCache);
  if (!meInflight) {
    const gen = generation;
    const p = getMe()
      .then((me) => {
        if (gen === generation) {
          meCache = me;
          meInflight = null;
        }
        return me;
      })
      .catch((err) => {
        if (gen === generation) meInflight = null;
        throw err;
      });
    meInflight = p;
  }
  return meInflight;
}

/** 目前快取的 /me（還沒抓過、抓失敗或已被清掉 → null）；同步讀，不發請求。 */
export function peekMeCached(): Me | null {
  return meCache;
}

/** GET /api/tenant/branding，快取到 reset 為止；in-flight 去重。 */
export function getBrandingCached(): Promise<BrandingResponse> {
  if (brandingCache) return Promise.resolve(brandingCache);
  if (!brandingInflight) {
    const gen = generation;
    const p = getBranding()
      .then((res) => {
        if (gen === generation) {
          brandingCache = res;
          brandingInflight = null;
        }
        return res;
      })
      .catch((err) => {
        if (gen === generation) brandingInflight = null;
        throw err;
      });
    brandingInflight = p;
  }
  return brandingInflight;
}

function countsStale(): boolean {
  return countsAt === null || Date.now() - countsAt >= COUNTS_TTL_MS;
}

/**
 * 待我決定的遲到說明筆數（老闆才呼叫）。失敗一律 0，不 reject。
 */
async function fetchPendingLateReports(meId: string | null | undefined): Promise<number> {
  try {
    return countPendingLateReports(await getLateReports({ decision: "undecided" }), meId);
  } catch {
    return 0;
  }
}

/**
 * 載入一輪：me＋branding（有快取就直接命中）＋兩個計數；是老闆再抓第二段（待決定的遲到說明）。
 * 任何一支失敗都退化，不 reject。同時多次呼叫只跑一次；`force`（invalidate）在進行中會排一輪補抓。
 */
function load(force = false): Promise<void> {
  if (loadInflight) {
    if (force) reloadPending = true;
    return loadInflight;
  }
  const gen = generation;
  loadInflight = (async () => {
    const [meRes, brandRes, pendingRes, unreadRes] = await Promise.allSettled([
      getMeCached(),
      getBrandingCached(),
      getPendingApprovals(),
      getUnreadNotificationCount(),
    ]);
    if (gen !== generation) return; // 已登出：丟棄
    const me = meRes.status === "fulfilled" ? meRes.value : null;
    const brand = brandRes.status === "fulfilled" ? brandRes.value : null;
    const isBoss = isBossOrPlatformAdmin(brand?.features ?? null, me);
    countsAt = Date.now();
    setSnapshot({
      loaded: true,
      me,
      isAdmin: isAdminRole(me?.role),
      isManager: me?.isManager === true,
      isBoss,
      essTabs: me && Array.isArray(me.essTabs) ? me.essTabs : null,
      branding: brand?.branding ?? null,
      features: brand?.features ?? null,
      pendingApprovals: pendingRes.status === "fulfilled" ? pendingRes.value.requests.length : 0,
      unreadNotifications:
        unreadRes.status === "fulfilled" && typeof unreadRes.value?.count === "number" ? unreadRes.value.count : 0,
      // 不是老闆 → 0；是老闆先留著上一輪的數字（第二段回來再換），紅點不會每輪閃一下歸零。
      ...(isBoss ? {} : { pendingLateReports: 0 }),
    });
    if (!isBoss) return;
    // 第二段：是老闆才抓待決定的遲到說明（要等 /me＋branding 才知道是不是老闆）。
    const pendingLateReports = await fetchPendingLateReports(me?.id);
    if (gen !== generation) return; // 已登出：丟棄
    setSnapshot({ pendingLateReports });
  })().finally(() => {
    if (gen !== generation) return;
    loadInflight = null;
    if (reloadPending) {
      reloadPending = false;
      void load();
    }
  });
  return loadInflight;
}

/** 有需要才載入：me 尚未快取，或計數過期。 */
function ensureFresh() {
  if (!meCache || countsStale()) void load();
}

/**
 * 簽核做完決定、老闆決定遲到說明、標記通知已讀、送出申請後呼叫：清掉計數與 me 快取並立刻重抓，
 * 徽章在同一頁就會更新。branding 不動。沒有任何訂閱者時只清快取，不重抓。
 */
export function invalidateEssState() {
  countsAt = null;
  meCache = null;
  meInflight = null;
  if (listeners.size > 0) void load(true);
}

/**
 * 後台改了站台名稱／隱藏模組（tenants.features.adminModules）後呼叫：清掉 branding 快取並
 * （有訂閱者時）立刻重抓 GET /api/tenant/branding，快照裡的 branding／features 同步更新，
 * AdminShell 的側欄 appName 與分頁列同一頁就會反映。me／計數不動；沒有任何訂閱者時只清快取。
 */
export function invalidateBranding() {
  brandingCache = null;
  brandingInflight = null;
  if (listeners.size === 0) return;
  const gen = generation;
  void getBrandingCached()
    .then((res) => {
      if (gen !== generation) return; // 已登出：丟棄
      // isBoss 是由 features 與 me 算出來的衍生值：老闆設定剛被改（交棒）時要一併重算，不然簽核分頁要等下一輪 load 才跟上。
      const isBoss = isBossOrPlatformAdmin(res.features ?? null, snapshot.me);
      setSnapshot({
        branding: res.branding ?? null,
        features: res.features ?? null,
        isBoss,
        // 不再是老闆：待決定的遲到說明不算進紅點（新接任的老闆等下一輪 load 的第二段再抓）。
        ...(isBoss ? {} : { pendingLateReports: 0 }),
      });
    })
    .catch(() => {
      /* best-effort：失敗保留舊值 */
    });
}

/** 登出時呼叫：清空所有快取與狀態、作廢在途回應，不重抓（接著會導去 /login）。 */
export function resetEssState() {
  generation += 1;
  meCache = null;
  meInflight = null;
  brandingCache = null;
  brandingInflight = null;
  countsAt = null;
  loadInflight = null;
  reloadPending = false;
  snapshot = INITIAL_STATE;
  emit();
}

/* ------------------------------------------------------------ hook --- */

function onVisibilityChange() {
  if (typeof document !== "undefined" && document.visibilityState === "visible") ensureFresh();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

function getSnapshot() {
  return snapshot;
}

function getServerSnapshot() {
  return INITIAL_STATE;
}

/**
 * 訂閱共用狀態。掛載時（與回到前景時）會依需要載入；換頁不會重打 /me 與
 * branding。多個元件同時用也只會有一組請求。
 */
export function useEssState(): EssState {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    ensureFresh();
  }, []);
  return state;
}
