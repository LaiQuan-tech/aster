"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase-browser";
import { markPasswordDone } from "@/lib/auth-api";
import { resetMustChangeCache } from "@/components/AuthGate";

/**
 * 設定密碼落地頁（刻意不包 AuthGate）。兩種進入方式：
 *   1. 邀請信／重設密碼信的連結 `?token_hash=…&type=invite|recovery`：
 *      先 `verifyOtp({ token_hash, type })` 換 session，再讓使用者設新密碼。
 *   2. `?mode=change`：已登入、被 AuthGate 因 must_change_password 導來，
 *      跳過 verifyOtp 直接顯示表單。
 * 設完 → `updateUser({ password })` → `POST /me/password-done` 清旗標 → /ess。
 */

type Phase = "verifying" | "form" | "saving" | "done" | "invalid" | "need-login";

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-[var(--brand)]";

function SetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const isChange = params.get("mode") === "change";

  const [phase, setPhase] = useState<Phase>("verifying");
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = getSupabaseBrowser();
      if (isChange) {
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        if (!data.session) {
          setPhase("need-login");
          return;
        }
        setEmail(data.session.user.email ?? null);
        setPhase("form");
        return;
      }
      if (!tokenHash || (type !== "invite" && type !== "recovery")) {
        setPhase("invalid");
        return;
      }
      const { data, error: verifyErr } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (!active) return;
      if (verifyErr || !data.session) {
        setPhase("invalid");
        return;
      }
      setEmail(data.session.user.email ?? null);
      setPhase("form");
    })();
    return () => {
      active = false;
    };
  }, [isChange, tokenHash, type]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("密碼至少 8 碼");
      return;
    }
    if (password !== confirm) {
      setError("兩次輸入的密碼不一致");
      return;
    }
    setPhase("saving");
    try {
      const supabase = getSupabaseBrowser();
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) {
        setError(
          /different from the old password/i.test(updErr.message) ? "新密碼不可與舊密碼相同" : updErr.message,
        );
        setPhase("form");
        return;
      }
      // 清 must_change_password（沒員工列的平台帳號會 404，不擋流程）。
      await markPasswordDone().catch(() => undefined);
      resetMustChangeCache();
      setPhase("done");
      router.replace("/ess");
    } catch (err) {
      setError(err instanceof Error ? err.message : "設定失敗");
      setPhase("form");
    }
  }

  const card = "w-full max-w-sm rounded-xl bg-white p-8 shadow-sm border border-gray-100";
  const title = isChange ? "請先設定新密碼" : type === "invite" ? "啟用帳號" : "重設密碼";

  if (phase === "verifying") {
    return (
      <main className="min-h-dvh flex items-center justify-center bg-gray-50 p-4">
        <p className="text-gray-500">驗證連結中…</p>
      </main>
    );
  }

  if (phase === "need-login") {
    return (
      <main className="min-h-dvh flex items-center justify-center bg-gray-50 p-4">
        <div className={card}>
          <h1 className="text-xl font-bold mb-2" style={{ color: "var(--brand)" }}>
            請先登入
          </h1>
          <p className="text-sm text-gray-500 mb-6">登入後再回到這一頁設定新密碼。</p>
          <Link href="/login" className="text-sm font-medium hover:underline" style={{ color: "var(--brand)" }}>
            前往登入
          </Link>
        </div>
      </main>
    );
  }

  if (phase === "invalid") {
    return (
      <main className="min-h-dvh flex items-center justify-center bg-gray-50 p-4">
        <div className={card}>
          <h1 className="text-xl font-bold mb-2" style={{ color: "var(--brand)" }}>
            連結無效或已過期
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            {type === "invite"
              ? "邀請連結只能使用一次且有時效，請洽 HR 重新寄送邀請信。"
              : "重設密碼連結只能使用一次且有時效，請重新申請。"}
          </p>
          <div className="flex flex-col gap-2 text-sm">
            <Link href="/forgot-password" className="font-medium hover:underline" style={{ color: "var(--brand)" }}>
              重新申請重設密碼
            </Link>
            <Link href="/login" className="text-gray-500 hover:underline">
              回登入頁
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-gray-50 p-4">
      <form onSubmit={onSubmit} className={card}>
        <h1 className="text-2xl font-bold mb-1" style={{ color: "var(--brand)" }}>
          {title}
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          {isChange ? "您目前使用的是 HR 配發的暫時密碼，請設定一組自己的密碼後繼續。" : "請設定您的登入密碼。"}
          {email && (
            <>
              <br />
              帳號：<span className="text-gray-700">{email}</span>
            </>
          )}
        </p>

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="new-password">
          新密碼（至少 8 碼）
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputCls}
        />

        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="confirm-password">
          再輸入一次
        </label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputCls}
        />

        {error && (
          <p className="text-sm text-red-600 mb-4" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={phase === "saving" || phase === "done"}
          className="w-full rounded-md py-2.5 font-medium text-white disabled:opacity-60"
          style={{ backgroundColor: "var(--brand)" }}
        >
          {phase === "saving" ? "儲存中…" : phase === "done" ? "完成，前往系統…" : "設定密碼並登入"}
        </button>
      </form>
    </main>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-dvh flex items-center justify-center bg-gray-50 p-4">
          <p className="text-gray-500">載入中…</p>
        </main>
      }
    >
      <SetPasswordInner />
    </Suspense>
  );
}
