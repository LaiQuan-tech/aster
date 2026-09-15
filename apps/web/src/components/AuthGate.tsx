"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/use-session";
import { getMeAuth } from "@/lib/auth-api";

const SET_PASSWORD_PATH = "/auth/set-password";

// /me 的 mustChangePassword 只在每個使用者第一次進站時查一次（module 快取），
// 之後的 client-side 導頁不再重打。設完密碼的頁面呼叫 resetMustChangeCache()
// 讓下一次重新查。整頁重載自然清空。
let cachedUserId: string | null = null;
let cachedMustChange = false;

export function resetMustChangeCache() {
  cachedUserId = null;
  cachedMustChange = false;
}

/**
 * Wraps protected pages: while the session is resolving it shows a light
 * loading state; once resolved, an unauthenticated visitor is redirected to
 * /login and authenticated ones see the children.
 *
 * 另外讀一次 GET /me：`mustChangePassword` 為 true（HR 配發暫時密碼）且不在
 * /auth/set-password 時，導去 `/auth/set-password?mode=change` 強制改密碼。
 * /me 404（沒員工列的平台帳號）或 API 失敗一律不擋。
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const userId = session?.user.id ?? null;
  const [checked, setChecked] = useState<{ userId: string; mustChange: boolean } | null>(() =>
    cachedUserId ? { userId: cachedUserId, mustChange: cachedMustChange } : null,
  );

  useEffect(() => {
    if (!loading && !session) {
      router.replace("/login");
    }
  }, [loading, session, router]);

  useEffect(() => {
    if (!userId) return;
    if (cachedUserId === userId) {
      setChecked({ userId, mustChange: cachedMustChange });
      return;
    }
    let active = true;
    (async () => {
      let mustChange = false;
      try {
        const me = await getMeAuth();
        mustChange = me.mustChangePassword === true;
      } catch {
        /* 404 / 網路錯誤：不擋 */
      }
      if (!active) return;
      cachedUserId = userId;
      cachedMustChange = mustChange;
      setChecked({ userId, mustChange });
    })();
    return () => {
      active = false;
    };
  }, [userId]);

  const mustRedirect = !!userId && checked?.userId === userId && checked.mustChange && pathname !== SET_PASSWORD_PATH;

  useEffect(() => {
    if (mustRedirect) router.replace(`${SET_PASSWORD_PATH}?mode=change`);
  }, [mustRedirect, router]);

  if (loading) {
    return (
      <main className="min-h-dvh flex items-center justify-center">
        <p className="text-gray-500">載入中…</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="min-h-dvh flex items-center justify-center">
        <p className="text-gray-500">導向登入…</p>
      </main>
    );
  }

  if (!checked || checked.userId !== userId) {
    return (
      <main className="min-h-dvh flex items-center justify-center">
        <p className="text-gray-500">載入中…</p>
      </main>
    );
  }

  if (mustRedirect) {
    return (
      <main className="min-h-dvh flex items-center justify-center">
        <p className="text-gray-500">請先設定新密碼…</p>
      </main>
    );
  }

  return <>{children}</>;
}
