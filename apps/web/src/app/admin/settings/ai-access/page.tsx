"use client";

/**
 * 設定 → AI 連接（個人，2026-11-02）：在 claude.ai／Claude 桌面版／ChatGPT／Claude Code 以「自己的身分」操作系統。
 *   1. 連接網址（MCP 端點）＋各家怎麼加（詳見 repo docs/MCP連接教學.md）。
 *   2. 個人存取金鑰：產生（只顯示一次）、列出、撤銷。DB 只存雜湊。
 *   3. 已授權的 AI 應用（OAuth）：列出、撤銷。
 * 權限：AI 能做的＝你在後台能做的；任何能進後台的角色都看得到這頁（只管自己的金鑰與授權）。
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Card, ConfirmDialog, Field, InlineError, Input, Pill, Select, Skeleton, useToast } from "@/components/admin-ui";
import { apiErrorMessage } from "@/lib/api-client";
import {
  createPersonalKey,
  listAuthorizedApps,
  listPersonalKeys,
  mcpServerUrl,
  revokeAuthorizedApp,
  revokePersonalKey,
  type AuthorizedApp,
  type PersonalKey,
} from "@/lib/mcp-access-api";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-TW", { hour12: false }) : "—");

type Pending = { kind: "key" | "app"; id: string; name: string } | null;

export default function AiAccessPage() {
  const toast = useToast();
  const [keys, setKeys] = useState<PersonalKey[] | null>(null);
  const [apps, setApps] = useState<AuthorizedApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [revoking, setRevoking] = useState(false);
  const url = mcpServerUrl();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [k, a] = await Promise.all([listPersonalKeys(), listAuthorizedApps()]);
      setKeys(k);
      setApps(a);
    } catch (err) {
      setError(apiErrorMessage(err, "載入失敗"));
      setKeys([]);
      setApps([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.show("已複製", "success");
    } catch {
      toast.show("複製失敗，請手動選取", "error");
    }
  }

  async function onCreate() {
    if (!name.trim()) {
      toast.show("請輸入名稱（例：我的筆電 Claude Code）", "error");
      return;
    }
    setCreating(true);
    try {
      const created = await createPersonalKey(name.trim(), Number(days));
      setNewToken(created.token);
      setName("");
      await load();
    } catch (err) {
      toast.show(apiErrorMessage(err, "產生失敗"), "error");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke() {
    if (!pending) return;
    setRevoking(true);
    try {
      if (pending.kind === "key") await revokePersonalKey(pending.id);
      else await revokeAuthorizedApp(pending.id);
      toast.show("已撤銷，立即失效", "success");
      setPending(null);
      await load();
    } catch (err) {
      toast.show(apiErrorMessage(err, "撤銷失敗"), "error");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="連接網址">
        <p className="text-sm text-gray-600">
          在 AI 工具加「自訂連接器／MCP 伺服器」時貼上這個網址。AI 以你本人的身分操作，權限和你在後台完全一樣；每筆操作都記在你名下並標示經由 AI。
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="block flex-1 break-all rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-800">{url}</code>
          <Button variant="secondary" size="sm" onClick={() => copy(url)}>
            複製
          </Button>
        </div>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-600">
          <li>claude.ai／Claude 桌面版：設定 → 連接器 → 新增自訂連接器 → 貼網址 → 連接，會跳到本系統登入並按「同意」。</li>
          <li>ChatGPT：設定 → 應用程式與連接器 → 進階 → 開啟開發者模式 → 建立 → 貼網址、認證選 OAuth。</li>
          <li>
            Claude Code：先在下方產生個人金鑰，再執行
            <code className="mx-1 break-all rounded bg-gray-50 px-1">{`claude mcp add --transport http aster ${url} --header "Authorization: Bearer <金鑰>"`}</code>
          </li>
          <li>薪資結算、放款、獎金發放、刪除、權限與規則變更等危險操作，AI 會先給預覽，你確認後它才會執行。</li>
        </ul>
      </Card>

      <Card title="個人存取金鑰">
        <p className="text-sm text-gray-600">給 Claude Code 等「貼 header」的工具用。金鑰只在產生當下顯示一次，請立即複製保存；遺失就撤銷再產生一把。</p>
        {newToken ? (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm font-medium text-amber-800">新金鑰（只顯示這一次）：</p>
            <code className="mt-1 block break-all text-sm text-gray-900">{newToken}</code>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => copy(newToken)}>
                複製金鑰
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNewToken(null)}>
                我已保存，關閉
              </Button>
            </div>
          </div>
        ) : null}
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <Field label="名稱" htmlFor="pat-name">
            <Input id="pat-name" value={name} maxLength={60} placeholder="例：我的筆電 Claude Code" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="有效期限" htmlFor="pat-days">
            <Select id="pat-days" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="30">30 天</option>
              <option value="90">90 天</option>
              <option value="180">180 天</option>
              <option value="365">365 天</option>
            </Select>
          </Field>
          <Button onClick={onCreate} disabled={creating}>
            {creating ? "產生中…" : "產生金鑰"}
          </Button>
        </div>
        <div className="mt-4">
          {keys === null ? (
            <Skeleton lines={2} />
          ) : keys.length === 0 ? (
            <p className="text-sm text-gray-400">還沒有金鑰。</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">
                      {k.name} <span className="ml-1 font-mono text-xs text-gray-400">{k.prefix}</span>
                    </p>
                    <p className="text-xs text-gray-500">
                      建立 {fmt(k.createdAt)}・最後使用 {fmt(k.lastUsedAt)}・到期 {fmt(k.expiresAt)}
                    </p>
                  </div>
                  <Button size="sm" variant="danger" onClick={() => setPending({ kind: "key", id: k.id, name: k.name })}>
                    撤銷
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card title="已授權的 AI 應用">
        <p className="text-sm text-gray-600">你曾按「同意」授權的 AI 工具（claude.ai、ChatGPT…）。撤銷後該工具立即無法再操作，需要重新連接。</p>
        <div className="mt-3">
          {apps === null ? (
            <Skeleton lines={2} />
          ) : apps.length === 0 ? (
            <p className="text-sm text-gray-400">目前沒有已授權的 AI 應用。</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {apps.map((a) => (
                <li key={a.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">
                      {a.clientName} <Pill tone="blue">OAuth</Pill>
                    </p>
                    <p className="text-xs text-gray-500">
                      授權 {fmt(a.createdAt)}・最後使用 {fmt(a.lastUsedAt)}
                    </p>
                  </div>
                  <Button size="sm" variant="danger" onClick={() => setPending({ kind: "app", id: a.id, name: a.clientName })}>
                    撤銷
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {error ? <InlineError>{error}</InlineError> : null}

      <ConfirmDialog
        open={!!pending}
        title={pending?.kind === "key" ? "撤銷個人金鑰" : "撤銷 AI 應用授權"}
        message={pending ? `確定撤銷「${pending.name}」？撤銷後立即失效，無法復原。` : undefined}
        confirmLabel="撤銷"
        danger
        busy={revoking}
        onConfirm={onRevoke}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
