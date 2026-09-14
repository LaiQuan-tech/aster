"use client";

import { useEffect, useId, useRef, useState } from "react";
import { inputCls } from "@/components/admin-ui";
import { CLIENT_CATEGORY_LABELS, type Client } from "@/lib/projects-ext-api";

/**
 * 客戶挑選：可搜尋 combo（B4）。基礎精神抄 VendorCombo（select＋自由文字），
 * 但客戶一定要對回名冊既有的 id——不像廠商／協力技師有 vendorName 自由文字
 * 欄位可以兜底，所以這裡用 `<input list>` + `<datalist>` 做「打字即過濾」：
 * 文字對得上名冊裡的名稱就回傳該筆 id，對不上就回傳 null（不會憑空生出一個
 * 不存在的客戶）。就地新增仍走呼叫端既有的「＋ 新增客戶」表單，不在這裡處理。
 *
 * 分類標籤：datalist 的 `label` 屬性是否顯示看瀏覽器（不保證），所以主要
 * 顯示方式是輸入框旁邊那顆分類 pill，取目前選到的客戶的 category。
 */
export function ClientCombo({
  clients,
  clientId,
  onChange,
  placeholder = "輸入客戶名稱搜尋",
}: {
  clients: Client[];
  clientId: string | null | undefined;
  onChange: (clientId: string | null) => void;
  placeholder?: string;
}) {
  const listId = useId();
  const selected = clients.find((c) => c.id === clientId) ?? null;
  const [text, setText] = useState(selected?.name ?? "");
  // 使用者正在這格打字時，外部 props 變動（例如 clients 非同步載入完成）
  // 不要蓋掉正在輸入的文字；離開這格（blur）才強制對齊真正選到的值。
  const typingRef = useRef(false);

  useEffect(() => {
    if (!typingRef.current) setText(selected?.name ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, clients]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} max-w-xs`}
          list={listId}
          value={text}
          placeholder={placeholder}
          onFocus={() => {
            typingRef.current = true;
          }}
          onChange={(e) => {
            typingRef.current = true;
            const v = e.target.value;
            setText(v);
            const match = clients.find((c) => c.name === v);
            onChange(match ? match.id : null);
          }}
          onBlur={() => {
            typingRef.current = false;
            // 打了不存在的名字就離開：對齊回真正選到的值（多半是清空)，
            // 不留一段看起來像選到、其實沒對到任何客戶的殘字。
            setText(selected?.name ?? "");
          }}
        />
        {selected?.category && (
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
            {CLIENT_CATEGORY_LABELS[selected.category]}
          </span>
        )}
      </div>
      <datalist id={listId}>
        {clients.map((c) => (
          <option key={c.id} value={c.name} label={c.category ? CLIENT_CATEGORY_LABELS[c.category] : undefined} />
        ))}
      </datalist>
    </div>
  );
}
