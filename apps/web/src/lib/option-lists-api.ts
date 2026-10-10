"use client";

/**
 * 全站共用「選項清單」（管理員可自行新增的下拉選項；客戶分類是第一個）的 typed API 呼叫、
 * 畫面端的取用規則與快取 hook。後端見 apps/api/src/routes/option-lists.ts、
 * apps/api/src/services/option-lists.ts（有哪些清單由那邊的登記表決定）。
 *
 * 業務資料列上存的是 **code**（穩定，改名不影響舊資料），畫面顯示 **label**：
 *   • `useOptionList(key)`：取得這份清單（含停用的項目——舊資料可能還用著它們，要翻得出名稱）。
 *   • `optionLabel(items, code)`：code → 名稱，找不到回 code 本身。
 *   • `optionChoices(items, selectedCode)`：下拉要列的選項＝啟用項＋目前已選的停用項（標「（已停用）」）。
 * 要掛一個新清單：後端登記表加一筆，這邊直接 `useOptionList("新的 key")` 就能用，
 * 「設定 → 選項清單」頁會自動多一張卡片。
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { apiFetch, type ApiError } from "./api-client";
import { getSupabaseBrowser } from "./supabase-browser";

/* ================================================================ 型別 == */

export interface OptionItem {
  /** 穩定代碼：資料列上存的是它。 */
  code: string;
  label: string;
  sortOrder: number;
  /** 停用＝新單據的下拉不再出現；舊資料照常顯示原名稱。 */
  isActive: boolean;
}

export interface OptionListInfo {
  key: string;
  title: string;
  description: string;
  /** 呼叫者能不能新增／改名／排序／停用／刪除這份清單的項目。 */
  canManage: boolean;
}

export interface OptionListDetail extends OptionListInfo {
  items: OptionItem[];
  /** 只有管理視圖（`manage: true` 且有管理權限）才有：code → 被資料引用的筆數（0＝沒用過，可以刪）。 */
  usage?: Record<string, number>;
}

/** 整批存檔的一項：有 `code`＝更新既有項目，沒有＝新增（code 由後端產生）。 */
export interface OptionItemInput {
  code?: string;
  label: string;
  sortOrder?: number;
  isActive?: boolean;
}

/* ============================================================ API 呼叫 == */

export function listOptionLists() {
  return apiFetch<{ lists: OptionListInfo[] }>("/option-lists");
}

/**
 * 讀一份清單。預設只回啟用的項目；`includeInactive` 連停用的一起回（任何登入者都可用，不含使用量）；
 * `manage` 且呼叫者有管理權限時回全部項目＋`usage`（要掃資料表，只有管理頁用）。
 */
export function getOptionList(key: string, opts: { manage?: boolean; includeInactive?: boolean } = {}) {
  const query = [opts.manage ? "manage=1" : "", opts.includeInactive ? "includeInactive=1" : ""].filter(Boolean).join("&");
  return apiFetch<OptionListDetail>(`/option-lists/${encodeURIComponent(key)}${query ? `?${query}` : ""}`);
}

/**
 * 整批 upsert：有 code 的更新、沒有的新增，**不在陣列裡的不會被刪**。回管理視圖（全部項目＋usage）。
 * 名稱重複 409 `label_taken`；刪除一律走 `deleteOptionItem`（只准刪沒被用過的）。
 */
export function putOptionList(key: string, items: OptionItemInput[]) {
  return apiFetch<OptionListDetail>(`/option-lists/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ items }),
  });
}

/** 刪除一個沒被用過的選項；被用過 409 `option_in_use`（`err.body.usage` 是筆數）。 */
export function deleteOptionItem(key: string, code: string) {
  return apiFetch<{ code: string }>(`/option-lists/${encodeURIComponent(key)}/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
}

export function humanizeOptionListError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback;
  // list_not_found 含 not_found，要先判。
  if (msg.includes("list_not_found")) return "找不到這份清單，請重新整理。";
  if (msg.includes("label_taken")) return "名稱重複，請改一下再存。";
  if (msg.includes("option_in_use")) {
    const usage = (err as ApiError).body as { usage?: unknown } | undefined;
    const count = typeof usage?.usage === "number" ? ` ${usage.usage} 筆` : "";
    return `這個選項已被${count}資料使用，無法刪除，可改為停用。`;
  }
  if (msg.includes("too_many_items")) return "這份清單的項目太多了（最多 200 項），請先刪掉用不到的。";
  if (msg.includes("duplicate_item")) return "同一個選項出現了兩次，請重新整理後再試。";
  if (msg.includes("not_found")) return "找不到這個選項，可能已被刪除，請重新整理。";
  if (msg.includes("forbidden")) return "你沒有管理這份清單的權限。";
  return msg;
}

/* ====================================================== 代碼 ↔ 名稱規則 == */

export const OPTION_INACTIVE_MARK = "（已停用）";
export const OPTION_DELETED_MARK = "（已刪除）";

/**
 * code → 名稱。找不到（例如項目被刪掉前留下的舊資料）回 code 本身；沒有值回空字串。
 * 停用的項目照樣翻得出名稱（舊資料照常顯示原名稱）。
 */
export function optionLabel(items: readonly OptionItem[], code: string | null | undefined): string {
  if (!code) return "";
  return items.find((item) => item.code === code)?.label ?? code;
}

export interface OptionChoice {
  code: string;
  /** 下拉顯示的字：名稱，已停用的後面加「（已停用）」。 */
  label: string;
  inactive: boolean;
}

/**
 * 下拉的選項＝啟用的項目，再加上「目前已選的項目」（它已停用的話標「（已停用）」，保留在原本的排序位置）。
 * 新表單（`selectedCode` 沒帶／空字串）只列啟用的項目；開舊資料編輯時，原本選著的停用項照舊留在下拉裡，
 * 不然下拉會悄悄換成「未選」，一存檔就把歷史資料改掉。
 *
 * 清單已載入、但已選的 code 根本不在清單裡（項目被刪掉前留下的舊值）：補一個「code（已刪除）」的選項，
 * 讓畫面如實顯示目前存的值，而不是看起來像空的。清單還沒載入（`items` 空）時不補，免得載入中閃過原始代碼。
 */
export function optionChoices(items: readonly OptionItem[], selectedCode?: string | null): OptionChoice[] {
  const choices = items
    .filter((item) => item.isActive !== false || (!!selectedCode && item.code === selectedCode))
    .map<OptionChoice>((item) => {
      const inactive = item.isActive === false;
      return { code: item.code, label: `${item.label}${inactive ? OPTION_INACTIVE_MARK : ""}`, inactive };
    });
  if (selectedCode && items.length > 0 && !items.some((item) => item.code === selectedCode)) {
    choices.push({ code: selectedCode, label: `${selectedCode}${OPTION_DELETED_MARK}`, inactive: true });
  }
  return choices;
}

/* ============================================================ 快取 hook == */

type Entry = {
  status: "idle" | "loading" | "ready" | "error";
  items: OptionItem[];
  canManage: boolean;
  error: string | null;
  /** 最後一次抓取（成功或背景更新失敗）的時間。 */
  at: number;
};

const EMPTY_ITEMS: OptionItem[] = [];
const IDLE: Entry = { status: "idle", items: EMPTY_ITEMS, canManage: false, error: null, at: 0 };
/** 資料超過這個時間，下一次有元件掛載時在背景重抓（別的管理者改了清單，這邊最晚幾分鐘後跟上）。 */
const TTL_MS = 5 * 60_000;
/** 載入失敗後，下一次有元件掛載時若已過這麼久就自動重試（太短會在後端掛掉時連環重打）。 */
const ERROR_RETRY_MS = 10_000;

const entries = new Map<string, Entry>();
/** 每次失效 +1：在途回應若版本不符就丟棄（存檔後失效時，舊的回應不能蓋掉新資料）。 */
const versions = new Map<string, number>();
/** 正在抓的 key → 它抓的版本，同一版只發一次請求。 */
const inflight = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const notify of listeners) notify();
}
function entryOf(key: string): Entry {
  return entries.get(key) ?? IDLE;
}
function versionOf(key: string): number {
  return versions.get(key) ?? 0;
}
function setEntry(key: string, entry: Entry) {
  entries.set(key, entry);
  emit();
}

function fetchList(key: string) {
  const version = versionOf(key);
  if (inflight.get(key) === version) return;
  inflight.set(key, version);
  // 含停用的項目：畫面要把舊資料的 code 翻成名稱，停用的也要認得。使用量不需要，不帶 manage。
  getOptionList(key, { includeInactive: true })
    .then((res) => {
      if (versionOf(key) !== version) return;
      setEntry(key, { status: "ready", items: res.items, canManage: res.canManage === true, error: null, at: Date.now() });
    })
    .catch((err: unknown) => {
      if (versionOf(key) !== version) return;
      const prev = entryOf(key);
      setEntry(
        key,
        // 背景更新失敗：留著舊資料（並重設計時，免得每次掛載都重打）；第一次載入失敗才標成 error。
        prev.status === "ready"
          ? { ...prev, at: Date.now() }
          : { ...IDLE, status: "error", error: err instanceof Error ? err.message : "載入失敗", at: Date.now() },
      );
    })
    .finally(() => {
      if (inflight.get(key) === version) inflight.delete(key);
    });
}

function ensureLoaded(key: string) {
  const entry = entryOf(key);
  if (entry.status === "idle") {
    setEntry(key, { ...IDLE, status: "loading" });
    fetchList(key);
  } else if (entry.status === "ready" && Date.now() - entry.at > TTL_MS) {
    fetchList(key);
  } else if (entry.status === "error" && Date.now() - entry.at > ERROR_RETRY_MS) {
    setEntry(key, { ...IDLE, status: "loading" });
    fetchList(key);
  }
}

/**
 * 讓快取失效（不帶 key＝全部）。管理頁存檔／刪除後呼叫：目前掛著這份清單的畫面會立刻重抓，
 * 沒掛著的下次用到時才抓。
 */
export function invalidateOptionList(key?: string) {
  const keys = key ? [key] : [...new Set([...entries.keys(), ...inflight.keys(), ...versions.keys()])];
  for (const k of keys) {
    versions.set(k, versionOf(k) + 1);
    entries.delete(k);
  }
  emit();
}

let watchingSignOut = false;
/** 登出時清掉所有快取：同一個瀏覽分頁換另一個租戶的帳號登入，不能看到上一位的選項清單。只註冊一次。 */
function watchSignOut() {
  if (watchingSignOut || typeof window === "undefined") return;
  watchingSignOut = true;
  try {
    getSupabaseBrowser().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") invalidateOptionList();
    });
  } catch {
    watchingSignOut = false; // best-effort：註冊不成，下次掛載再試
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface OptionListState {
  /** 全部項目（含停用的），依 sortOrder 排；還沒載入完是空陣列。 */
  items: OptionItem[];
  /** 呼叫者能不能管理這份清單（決定要不要顯示「管理分類」之類的連結）。 */
  canManage: boolean;
  loading: boolean;
  error: string | null;
  /** 清掉快取並重抓（載入失敗時給「重試」用）。 */
  reload: () => void;
}

/**
 * 取得一份選項清單（含停用的項目）。模組層快取：多個元件、換頁都共用同一份、只打一次請求；
 * 管理頁存檔後 `invalidateOptionList(key)` 會讓它立刻更新。
 */
export function useOptionList(key: string): OptionListState {
  const getSnapshot = useCallback(() => entryOf(key), [key]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, () => IDLE);
  useEffect(() => {
    watchSignOut();
    ensureLoaded(key);
  }, [key, entry.status]);
  const reload = useCallback(() => invalidateOptionList(key), [key]);
  return {
    items: entry.items,
    canManage: entry.canManage,
    loading: entry.status === "idle" || entry.status === "loading",
    error: entry.error,
    reload,
  };
}
