"use client";

/**
 * 最高風險 MCP 操作的確認頁（資安驗收 M4，2026-11-02）。
 *
 * AI 要做薪資計算／定案／寄送、期間鎖定重開、放款／作廢、獎金核准／發放／沖回、角色權限帳號、規則與簽核流程、
 * 新增租戶、刪除這類動作時，不能自己完成：API 建一筆待確認操作，AI 把這頁的網址給使用者。
 * 使用者本人登入後看到完整內容 → 「確認執行」（API 以他此刻的身分、重新檢查權限執行，結果存起來給 AI 查）或「拒絕」。
 * 只有建立者本人（同租戶）看得到；next.config.ts 對 /mcp/* 設 frame-ancestors 'none'。
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/use-session";
import { apiErrorMessage } from "@/lib/api-client";
import { decidePendingAction, getPendingAction, type PendingAction } from "@/lib/mcp-access-api";

const STATUS_LABEL: Record<PendingAction["status"], string> = {
  pending: "等待你確認",
  executing: "執行中",
  done: "已執行",
  failed: "執行失敗",
  rejected: "已拒絕",
  expired: "已逾時（未執行）",
};

const pretty = (value: unknown) => (value === null || value === undefined ? "（無）" : JSON.stringify(value, null, 2));

export default function ConfirmPendingActionPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? "");
  const { session, loading } = useSession();
  const [action, setAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace(`/login?next=${encodeURIComponent(`/mcp/confirm/${id}`)}`);
      return;
    }
    getPendingAction(id)
      .then(setAction)
      .catch((err) => setError(apiErrorMessage(err, "找不到這筆待確認操作（只有建立者本人看得到）。")));
  }, [loading, session, id, router]);

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    try {
      setAction(await decidePendingAction(id, approve));
    } catch (err) {
      setError(apiErrorMessage(err, "送出失敗"));
      try {
        setAction(await getPendingAction(id));
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh bg-gray-50 p-4">
      <div className="mx-auto w-full max-w-2xl rounded-xl border border-gray-100 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-red-700">確認 AI 要執行的高風險操作</h1>
        <p className="mb-4 text-sm text-gray-500">這個動作會以你本人的身分、照你目前的後台權限執行。請逐項確認內容無誤。</p>
        {error ? (
          <p role="alert" className="mb-3 text-sm text-red-600">
            {error}
          </p>
        ) : null}
        {!action ? (
          !error ? <p className="text-sm text-gray-500">載入中…</p> : null
        ) : (
          <>
            {action.targetSummary ? (
              <div className="mb-4 rounded-lg border-2 border-amber-400 bg-amber-50 p-4">
                <p className="text-xs font-medium text-amber-800">操作對象</p>
                <p className="mt-1 text-lg font-bold text-gray-900">{action.targetSummary}</p>
              </div>
            ) : (
              <div role="alert" className="mb-4 rounded-lg border-2 border-red-500 bg-red-50 p-4">
                <p className="text-lg font-bold text-red-700">⚠ 無法辨識對象，請小心</p>
                <p className="mt-1 text-sm text-red-700">系統無法把這個操作對應到具體的人或單據。請仔細核對下方 API 路徑與內容，不確定就按「拒絕」。</p>
              </div>
            )}
            {action.dangerFields.length > 0 ? (
              <div role="alert" className="mb-4 rounded-lg border-2 border-red-500 bg-red-50 p-4">
                <p className="text-sm font-bold text-red-700">⚠ 這次會改到以下敏感欄位，請逐一核對：</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {action.dangerFields.map((f) => (
                    <li key={f} className="rounded bg-white px-2 py-0.5 font-mono text-sm font-bold text-red-800 ring-1 ring-red-300">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-gray-500">操作</dt>
              <dd className="font-medium text-gray-900">{action.summary}</dd>
              <dt className="text-gray-500">AI 工具</dt>
              <dd className="text-gray-900">{action.clientName}</dd>
              <dt className="text-gray-500">API</dt>
              <dd className="break-all font-mono text-gray-900">
                {action.method} {action.path}
              </dd>
              <dt className="text-gray-500">狀態</dt>
              <dd className="font-medium text-gray-900">{STATUS_LABEL[action.status]}</dd>
              <dt className="text-gray-500">期限</dt>
              <dd className="text-gray-900">{new Date(action.expiresAt).toLocaleString("zh-TW", { hour12: false })}</dd>
            </dl>
            <p className="mt-4 text-sm font-medium text-gray-700">查詢參數</p>
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-800">{pretty(action.query)}</pre>
            <p className="mt-3 text-sm font-medium text-gray-700">內容（body）</p>
            <pre className="mt-1 max-h-72 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-800">{pretty(action.body)}</pre>
            {action.status === "pending" ? (
              <div className="mt-6 flex gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(true)}
                  className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {busy ? "處理中…" : "確認執行"}
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
            ) : null}
            {action.result ? (
              <>
                <p className="mt-4 text-sm font-medium text-gray-700">執行結果</p>
                <pre className="mt-1 max-h-72 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-800">{action.result}</pre>
              </>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
