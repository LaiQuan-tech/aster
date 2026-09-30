"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/use-session";
import { getMeCached, resetEssState } from "@/lib/ess-state";

const SET_PASSWORD_PATH = "/auth/set-password";

// /me 的 mustChangePassword 只在每個使用者第一次進站時查一次（module 快取），
// 之後的 client-side 導頁不再重打。設完密碼的頁面呼叫 resetMustChangeCache()
// 讓下一次重新查。整頁重載自然清空。
let cachedUserId: string | null = null;
let cachedMustChange = false;
// ess-state 模組快取（/me、branding）目前屬於哪個使用者。在 check「開始」就寫入，不等 /me
// 回來：第一支 /me 還在途時就換了人，也會被偵測到並整包清掉（2026-09-30 審查發現的競態）。
let essOwner: string | null = null;

export function resetMustChangeCache() {
  cachedUserId = null;
  cachedMustChange = false;
  // /me 走 ess-state 的共用快取：設完密碼後 mustChangePassword 已變 false，快取裡那份舊的
  // （true）要丟掉，下一次 AuthGate 才會重抓——不然會又被導回設定密碼頁。整包清（含 branding）：
  // 邀請信連結可能讓同一分頁換成另一個帳號。只在設定密碼頁呼叫，那裡沒有訂閱者，不會閃畫面。
  resetEssState();
}

/**
 * Wraps protected pages: while the session is resolving it shows a light
 * loading state; once resolved, an unauthenticated visitor is redirected to
 * /login and authenticated ones see the children.
 *
 * 另外讀一次 GET /me：`mustChangePassword` 為 true（HR 配發暫時密碼）且不在
 * /auth/set-password 時，導去 `/auth/set-password?mode=change` 強制改密碼。
 * /me 404（沒員工列的平台帳號）或 API 失敗一律不擋。
 *
 * /me 走 lib/ess-state 的 getMeCached（2026-09-30）：這裡是整頁載入第一個要 /me 的地方，
 * 裡面的 AdminGate、AdminShell／EssShell（useEssState）直接命中同一份快取，不再各打一次
 * （以前這裡直打 /me，AdminGate 要等它回來、children 掛上後才發第二次，每頁白等一輪）。
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
      // 登出（含別的分頁登出的廣播）：AuthGate 自己的快取與 ess-state 一起清。不清的話，
      // 同一分頁之後換人，或同一人拿 HR 配發的暫時密碼重登，會沿用舊的 mustChangePassword。
      resetMustChangeCache();
      essOwner = null;
      router.replace("/login");
    }
  }, [loading, session, router]);

  useEffect(() => {
    if (!userId) return;
    // 換了使用者（含第一支 /me 還在途時就換、沒經過 essLogout 的換人）：先把 AuthGate 與
    // ess-state 的快取整包清掉再查，免得守門與頁框拿到上一位的角色、姓名或 mustChangePassword。
    // 首次整頁載入 essOwner 是 null，不清（根 layout 的 TenantBranding 那支在途請求要保留）。
    if (essOwner !== null && essOwner !== userId) resetMustChangeCache();
    essOwner = userId;
    if (cachedUserId === userId) {
      setChecked({ userId, mustChange: cachedMustChange });
      return;
    }
    let active = true;
    (async () => {
      let mustChange = false;
      let ok = false;
      try {
        const me = await getMeCached();
        mustChange = me.mustChangePassword === true;
        ok = true;
      } catch {
        /* 404 / 網路錯誤：這次不擋 */
      }
      if (!active) return;
      // 只有成功才寫模組快取：失敗（網路錯誤、5xx、401）不能被記成「不用改密碼」，下次掛載要重試。
      if (ok) {
        cachedUserId = userId;
        cachedMustChange = mustChange;
      }
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
