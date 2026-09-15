"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { forgotPassword } from "@/lib/auth-api";

/**
 * 忘記密碼（免登入）。送出後不論帳號存不存在都顯示同一句話，不透露帳號是否存在。
 * 真正寄信與否由 API 決定（找得到帳號才寄 recovery；60 秒內同 email 只寄一次）。
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "送出失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-gray-50 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm border border-gray-100">
        <h1 className="text-2xl font-bold mb-1" style={{ color: "var(--brand)" }}>
          忘記密碼
        </h1>
        <p className="text-sm text-gray-500 mb-6">輸入您的登入 Email，我們會寄一封重設密碼信給您。</p>

        {sent ? (
          <div className="space-y-4">
            <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700" role="status">
              若 <span className="font-medium">{email.trim()}</span> 有帳號，我們已寄出重設密碼信，請查收（也請看看垃圾郵件匣）。
              連結 24 小時內有效。
            </p>
            <p className="text-xs text-gray-400">沒收到信？請確認 Email 是否正確，或洽 HR 由後台重寄。</p>
            <Link href="/login" className="block text-sm font-medium hover:underline" style={{ color: "var(--brand)" }}>
              回登入頁
            </Link>
          </div>
        ) : (
          <>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
            />
            {error && (
              <p className="text-sm text-red-600 mb-4" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md py-2.5 font-medium text-white disabled:opacity-60"
              style={{ backgroundColor: "var(--brand)" }}
            >
              {submitting ? "送出中…" : "寄送重設密碼信"}
            </button>
            <Link href="/login" className="mt-4 block text-center text-sm text-gray-500 hover:underline">
              回登入頁
            </Link>
          </>
        )}
      </form>
    </main>
  );
}
