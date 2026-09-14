"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { useSession } from "@/lib/use-session";

const REMEMBER_KEY = "aster_login";

export default function LoginPage() {
  const router = useRouter();
  const { session, loading } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const resolveLoginEmail = (value: string) => {
    const normalized = value.trim();
    return normalized.toLowerCase() === "demo" ? "demo@daoteng.demo" : normalized;
  };

  // Already signed in → skip the form.
  useEffect(() => {
    if (!loading && session) router.replace("/ess");
  }, [loading, session, router]);

  // 若之前勾選「記住帳號」，載入時自動帶入 email 並勾起。
  // 只存 { email }；舊版曾把密碼明碼一起存進 localStorage，讀到舊格式
  // 立刻改寫成只剩 email（主動把密碼清掉）。
  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { email?: string; password?: string };
        if (parsed.email) setEmail(parsed.email);
        setRemember(true);
        if ("password" in parsed) {
          localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email: parsed.email ?? "" }));
        }
      }
    } catch {
      /* 壞資料忽略 */
      try {
        localStorage.removeItem(REMEMBER_KEY);
      } catch {
        /* ignore */
      }
    }
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = getSupabaseBrowser();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: resolveLoginEmail(email),
        password,
      });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      // 記住帳號：勾選則只存 email 到 localStorage（絕不存密碼），取消則清除。
      try {
        if (remember) {
          localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email: email.trim() }));
        } else {
          localStorage.removeItem(REMEMBER_KEY);
        }
      } catch {
        /* localStorage 不可用時略過 */
      }
      router.replace("/ess");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登入失敗");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm border border-gray-100"
      >
        <h1
          className="text-2xl font-bold mb-1"
          style={{ color: "var(--brand)" }}
        >
          員工登入
        </h1>
        <p className="text-sm text-gray-500 mb-6">亞斯特設計顧問 數位化系統</p>

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="email">
          Email / 帳號
        </label>
        <input
          id="email"
          type="text"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
        />
        <p className="-mt-2 mb-4 text-xs text-gray-400">Demo 可直接輸入 demo。</p>

        <div className="mb-1 flex items-center justify-between">
          <label className="block text-sm font-medium text-gray-700" htmlFor="password">
            密碼
          </label>
          <Link href="/forgot-password" className="text-xs hover:underline" style={{ color: "var(--brand)" }}>
            忘記密碼？
          </Link>
        </div>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
        />

        <label className="mb-4 flex items-center gap-2 text-sm text-gray-600 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 accent-[var(--brand)]"
          />
          記住帳號
        </label>

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
          {submitting ? "登入中…" : "登入"}
        </button>
      </form>
    </main>
  );
}
