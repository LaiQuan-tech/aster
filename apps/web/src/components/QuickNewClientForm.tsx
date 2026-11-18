"use client";

import { useState } from "react";
import { PrimaryButton, inputCls } from "@/components/admin-ui";
import { matchClientByText } from "@/components/ClientCombo";
import { optionChoices, useOptionList } from "@/lib/option-lists-api";
import type { Client, ClientCategory, ClientInput } from "@/lib/projects-ext-api";

/** 快速新增客戶表單的欄位（全是輸入框原字串）。 */
export interface QuickNewClientFields {
  name: string;
  category: ClientCategory | "";
  taxId: string;
  phone: string;
}

export const EMPTY_QUICK_NEW_CLIENT: QuickNewClientFields = { name: "", category: "", taxId: "", phone: "" };

/**
 * 表單欄位 → POST /clients 的 body：去頭尾空白、空字串送 null。名稱空白回 null（不能建）。
 * 與新建專案的「＋ 新增客戶」送出內容一致（名稱／分類／統編／電話）。
 */
export function quickNewClientBody(fields: QuickNewClientFields): ClientInput | null {
  const name = fields.name.trim();
  if (!name) return null;
  return {
    name,
    category: fields.category || null,
    taxId: fields.taxId.trim() || null,
    phone: fields.phone.trim() || null,
  };
}

/**
 * 要建的名稱名冊裡已經有了（全名，或唯一的簡稱，比對規則同客戶名稱搜尋格）→ 回那一筆，呼叫端直接選用、不重複建檔。
 */
export function quickNewClientExisting(clients: readonly Client[], name: string): Client | null {
  return matchClientByText(clients, name);
}

/**
 * 「＋ 新增客戶」就地建檔表單（2026-11-18 從新建專案申請單抽出，既有專案申請單共用）：
 * 名稱＊／分類／統編／電話 → 「建立並選用」。名冊已有同名客戶時不重建、直接選用它。
 * 建立失敗的錯誤由 onCreate 丟出、顯示在表單下方。
 */
export function QuickNewClientForm({
  clients,
  initialName = "",
  onCreate,
  onPicked,
  className = "",
}: {
  clients: readonly Client[];
  /** 預填的名稱（例如客戶名稱格打了名冊沒有的字）。 */
  initialName?: string;
  /** 真正建檔（POST /clients）；成功回傳新客戶。 */
  onCreate: (body: ClientInput) => Promise<Client>;
  /** 建好（或名冊已有同名而直接選用）之後要選上的客戶。 */
  onPicked: (client: Client, created: boolean) => void;
  className?: string;
}) {
  const [fields, setFields] = useState<QuickNewClientFields>({ ...EMPTY_QUICK_NEW_CLIENT, name: initialName });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = useOptionList("client_category");
  const body = quickNewClientBody(fields);
  const set = <K extends keyof QuickNewClientFields>(k: K, v: QuickNewClientFields[K]) => setFields((f) => ({ ...f, [k]: v }));

  async function submit() {
    if (!body) return;
    const existing = quickNewClientExisting(clients, body.name);
    if (existing) {
      onPicked(existing, false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = await onCreate(body);
      onPicked(client, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增客戶失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rounded-lg border border-dashed border-slate-300 p-3 ${className}`} data-testid="quick-new-client">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
        <input aria-label="新客戶名稱" className={inputCls} value={fields.name} onChange={(e) => set("name", e.target.value)} placeholder="客戶名稱 *" />
        <select aria-label="新客戶分類" className={inputCls} value={fields.category} onChange={(e) => set("category", e.target.value as ClientCategory | "")}>
          <option value="">分類</option>
          {optionChoices(categories.items, fields.category).map((choice) => (
            <option key={choice.code} value={choice.code}>{choice.label}</option>
          ))}
        </select>
        <input aria-label="新客戶統編" className={inputCls} value={fields.taxId} onChange={(e) => set("taxId", e.target.value)} placeholder="統編" />
        <input aria-label="新客戶電話" className={inputCls} value={fields.phone} onChange={(e) => set("phone", e.target.value)} placeholder="電話" />
        <PrimaryButton type="button" onClick={() => void submit()} disabled={busy || !body}>{busy ? "建立中…" : "建立並選用"}</PrimaryButton>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
