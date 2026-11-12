"use client";

import { useEffect, useId, useRef, useState } from "react";
import { inputCls } from "@/components/admin-ui";
import { optionLabel, useOptionList } from "@/lib/option-lists-api";
import type { Client } from "@/lib/projects-ext-api";

/** 比對用的名稱：去頭尾空白、全形半形統一（NFKC）、英文不分大小寫、連續空白縮成一個。 */
export function clientNameKey(name: string | null | undefined): string {
  return (name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 打的字對回名冊哪一筆客戶：先比全名，對不到再比簡稱（簡稱只在唯一時才算）。
 * 對不到回 null。
 */
export function matchClientByText(clients: readonly Client[], text: string): Client | null {
  const key = clientNameKey(text);
  if (!key) return null;
  const byName = clients.find((c) => clientNameKey(c.name) === key);
  if (byName) return byName;
  const byShort = clients.filter((c) => c.shortName && clientNameKey(c.shortName) === key);
  return byShort.length === 1 ? byShort[0] : null;
}

/**
 * 輸入框每次變動要怎麼回報給呼叫端：
 *   • 清空 → 選「無客戶」（null）
 *   • 對到名冊某一筆 → 選它
 *   • 對不到（打到一半、或名冊裡還沒有這個名字）→ **不動**呼叫端目前的值（undefined），
 *     免得打一個字就把專案原本的客戶清掉，也不會讓「看起來選到了、其實沒有」的狀態被存出去。
 */
export function clientComboChange(clients: readonly Client[], text: string): string | null | undefined {
  if (!clientNameKey(text)) return null;
  const match = matchClientByText(clients, text);
  return match ? match.id : undefined;
}

/** 名冊重新整理的節流間隔：聚焦就重抓，但連續點來點去不要一直打 API。 */
const REFRESH_INTERVAL_MS = 10_000;

/**
 * 客戶挑選：可搜尋 combo（B4）。基礎精神抄 VendorCombo（select＋自由文字），
 * 但客戶一定要對回名冊既有的 id——不像廠商／協力技師有 vendorName 自由文字
 * 欄位可以兜底，所以這裡用 `<input list>` + `<datalist>` 做「打字即過濾」：
 * 文字對得上名冊裡的名稱就回傳該筆 id，清空就回傳 null（不會憑空生出一個
 * 不存在的客戶）。就地新增仍走呼叫端既有的「＋ 新增客戶」表單，不在這裡處理。
 *
 * 2026-11-12 修：名冊是頁面載入時抓的一份。管理員在另一個分頁（客戶名冊）新增客戶後回來選，
 * 下拉裡沒有新客戶、打完整名稱也對不到，以前會靜默回傳 null、離開格子就把字清掉——
 * 看起來像選了，實際上什麼都沒改，「儲存」也就沒東西可存（或建案時客戶變成空的）。
 * 現在：①給了 `onRefresh` 就在聚焦時重抓名冊，名冊更新後若剛好對到打的字就自動選上；
 * ②對不到時保留原本選的客戶不動，並在格子下方用紅字說明找不到、要怎麼做。
 *
 * 分類標籤：datalist 的 `label` 屬性是否顯示看瀏覽器（不保證），所以主要
 * 顯示方式是輸入框旁邊那顆分類 pill，取目前選到的客戶的 category。
 * 分類 code → 名稱走「選項清單 → 客戶分類」（`useOptionList("client_category")`），
 * 已停用的分類照樣翻得出名稱；清單載入中先不顯示分類字樣，免得閃過原始代碼。
 */
export function ClientCombo({
  clients,
  clientId,
  onChange,
  onRefresh,
  placeholder = "輸入客戶名稱搜尋",
}: {
  clients: Client[];
  clientId: string | null | undefined;
  onChange: (clientId: string | null) => void;
  /** 重新抓客戶名冊（例如別的分頁剛新增了客戶）。聚焦時呼叫，10 秒內不重複。 */
  onRefresh?: () => void | Promise<void>;
  placeholder?: string;
}) {
  const listId = useId();
  const categories = useOptionList("client_category");
  /** 分類名稱；清單還沒載入完回 undefined（不顯示）。 */
  const categoryName = (code: string | null | undefined) => (code && !categories.loading ? optionLabel(categories.items, code) : undefined);
  const selected = clients.find((c) => c.id === clientId) ?? null;
  const [text, setText] = useState(selected?.name ?? "");
  /** 離開格子時打的字對不到名冊：顯示提示用（存的是當時打的字）。 */
  const [notFound, setNotFound] = useState<string | null>(null);
  // 使用者正在這格打字時，外部 props 變動（例如 clients 非同步載入完成）
  // 不要蓋掉正在輸入的文字；離開這格（blur）才強制對齊真正選到的值。
  const typingRef = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    if (!typingRef.current) {
      setText(selected?.name ?? "");
      return;
    }
    // 名冊重抓回來時使用者已經打好名字：對得到就直接選上（不用再打一次）。
    const next = clientComboChange(clients, textRef.current);
    if (next && next !== clientId) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, clients]);

  function refresh() {
    if (!onRefresh) return;
    const now = Date.now();
    if (now - lastRefreshRef.current < REFRESH_INTERVAL_MS) return;
    lastRefreshRef.current = now;
    void Promise.resolve(onRefresh()).catch(() => {});
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} max-w-xs`}
          list={listId}
          value={text}
          placeholder={placeholder}
          aria-invalid={notFound ? true : undefined}
          onFocus={() => {
            typingRef.current = true;
            refresh();
          }}
          onChange={(e) => {
            typingRef.current = true;
            const v = e.target.value;
            setText(v);
            setNotFound(null);
            const next = clientComboChange(clients, v);
            if (next !== undefined && next !== (clientId || null)) onChange(next);
          }}
          onBlur={() => {
            typingRef.current = false;
            const typed = text;
            const next = clientComboChange(clients, typed);
            // 打了名冊裡沒有的名字就離開：對齊回真正選到的值（原本的客戶不動），並提示找不到。
            setNotFound(next === undefined ? typed.trim() : null);
            setText(next ? (clients.find((c) => c.id === next)?.name ?? typed) : next === null ? "" : (selected?.name ?? ""));
          }}
        />
        {categoryName(selected?.category) && (
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
            {categoryName(selected?.category)}
          </span>
        )}
      </div>
      {notFound && (
        <p role="alert" className="text-xs text-red-600">
          名冊裡找不到「{notFound}」，客戶{selected ? `仍是「${selected.name}」` : "未選"}。請從下拉清單點選；剛在別的分頁新增的客戶，點一下這格會重新載入名冊。
        </p>
      )}
      <datalist id={listId}>
        {clients.map((c) => (
          <option key={c.id} value={c.name} label={categoryName(c.category)} />
        ))}
      </datalist>
    </div>
  );
}
