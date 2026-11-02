"use client";

/**
 * OAuth 同意頁（MCP 連接，2026-11-02）：claude.ai／ChatGPT／Claude Code 等 AI 用戶端要以使用者身分操作亞斯特。
 *
 * 流程：API GET /oauth/authorize 驗完參數 → 302 到這頁 `?req=<簽章 blob>`。
 *   沒登入 → 導去 /login?next=<本頁>，登入後回來。
 *   已登入 → 顯示「<用戶端名稱> 想以你的身分操作亞斯特（權限同你的後台權限）」→ 同意／拒絕
 *   → POST /oauth/authorize/decision → 照回傳的 redirect_to 回到 AI 用戶端（帶 code 或 access_denied）。
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "@/lib/use-session";
import { apiErrorMessage } from "@/lib/api-client";
import { decideConsent, describeConsent, type ConsentInfo } from "@/lib/mcp-access-api";

function ConsentInner() {
  const router = useRouter();
  const params = useSearchParams();
  const req = params.get("req") ?? "";
  const { session, loading } = useSession();
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      const here = `/oauth/consent?req=${encodeURIComponent(req)}`;
      router.replace(`/login?next=${encodeURIComponent(here)}`);
      return;
    }
    if (!req) {
      setError("授權連結不完整，請回到 AI 工具重新連接。");
      return;
    }
    describeConsent(req)
      .then(setInfo)
      .catch((err) => setError(apiErrorMessage(err, "授權連結無效或已過期，請回到 AI 工具重新連接。")));
  }, [loading, session, req, router]);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { redirect_to } = await decideConsent(req, approve);
      window.location.href = redirect_to;
    } catch (err) {
      setError(apiErrorMessage(err, "送出失敗，請重試。"));
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-sm border border-gray-100">
        <h1 className="text-xl font-bold mb-4" style={{ color: "var(--brand)" }}>
          授權 AI 連接
        </h1>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : !info ? (
          <p className="text-sm text-gray-500">載入中…</p>
        ) : (
          <>
            <p className="text-base text-gray-900">
              <strong>{info.clientName}</strong> 想以你的身分操作亞斯特（權限同你的後台權限）。
            </p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 list-disc pl-5">
              <li>它能做的事和你在後台能做的完全一樣，不會更多；每筆操作都記在你名下，並標示經由 AI（MCP）。</li>
              <li>薪資結算、放款、獎金發放、刪除、權限與規則變更等危險操作，AI 會先給你預覽，你確認後才會執行。</li>
              <li>同意後會回到 <span className="font-mono">{info.redirectHost}</span>。隨時可在「設定 → AI 連接」撤銷。</li>
              {session?.user?.email ? <li>目前登入：{session.user.email}</li> : null}
            </ul>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => decide(true)}
                className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                style={{ background: "var(--brand)" }}
              >
                同意
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => decide(false)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 disabled:opacity-50"
              >
                拒絕
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default function ConsentPage() {
  return (
    <Suspense fallback={null}>
      <ConsentInner />
    </Suspense>
  );
}
