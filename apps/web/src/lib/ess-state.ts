"use client";

/**
 * ESS 全站共用狀態（/me、租戶品牌、待簽筆數、未讀通知數）的模組層快取。
 *
 * 動機：舊版每個 ESS 頁面各自打 /me＋branding＋pending-approvals（換一頁約 3 次 /me）。
 * 現在只有 EssShell（layout）與少數頁面呼叫 `useEssState()`，資料放在模組層：
 *   - `me`／`branding`：直到 `resetEssState()`（登出）前只抓一次。
 *   - 計數（pendingApprovals／unreadNotifications）：TTL 30 秒；分頁回到前景
 *     （visibilitychange）時過期就重抓；簽核／標記已讀後呼叫 `invalidateEssState()`
 *     立刻重抓，徽章在同一頁就會更新。
 *   - `getMeCached()`／`getBrandingCached()` 給頁面直接拿資料用，in-flight 去重
 *     （同時多個呼叫只打一次）。
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

export interface EssState {
  /** 第一輪載入（四支 API 全部 settle）是否完成；完成前所有欄位是退化預設值。 */
  loaded: boolean;
  me: Me | null;
  /** HR／平台管理員（可進 /admin）。 */
  isAdmin: boolean;
  /** 任一部門主管（顯示「簽核」分頁）。 */
  isManager: boolean;
  /** 可見分頁 key；null＝不限縮（也是 /me 未回或失敗時的預設）。 */
  essTabs: string[] | null;
  branding: Branding | null;
  /** tenants.features（internalLinks 等）。 */
  features: Record<string, unknown> | null;
  pendingApprovals: number;
  unreadNotifications: number;
}

const INITIAL_STATE: EssState = {
  loaded: false,
  me: null,
  isAdmin: false,
  isManager: false,
  essTabs: null,
  branding: null,
  features: null,
  pendingApprovals: 0,
  unreadNotifications: 0,
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
 * 載入一輪：me＋branding（有快取就直接命中）＋兩個計數。任何一支失敗都退化，
 * 不 reject。同時多次呼叫只跑一次；`force`（invalidate）在進行中會排一輪補抓。
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
    countsAt = Date.now();
    setSnapshot({
      loaded: true,
      me,
      isAdmin: isAdminRole(me?.role),
      isManager: me?.isManager === true,
      essTabs: me && Array.isArray(me.essTabs) ? me.essTabs : null,
      branding: brand?.branding ?? null,
      features: brand?.features ?? null,
      pendingApprovals: pendingRes.status === "fulfilled" ? pendingRes.value.requests.length : 0,
      unreadNotifications:
        unreadRes.status === "fulfilled" && typeof unreadRes.value?.count === "number" ? unreadRes.value.count : 0,
    });
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
 * 簽核做完決定、標記通知已讀、送出申請後呼叫：清掉計數與 me 快取並立刻重抓，
 * 徽章在同一頁就會更新。branding 不動。沒有任何訂閱者時只清快取，不重抓。
 */
export function invalidateEssState() {
  countsAt = null;
  meCache = null;
  meInflight = null;
  if (listeners.size > 0) void load(true);
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
