"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/AuthGate";
import { getMe } from "@/lib/ess-api";
import type { EssTabKey } from "@/components/EssHeader";

/**
 * ESS 分頁層級 guard（A3 實習生分頁限縮）。與 AdminGate 同款寫法：內含
 * AuthGate，頁面直接拿 EssTabGate 取代原本包的 <AuthGate>，不必兩層都寫。
 *
 * EssHeader 的 visibleTabs() 只是「藏起分頁按鈕」，擋不住直接打網址；這層
 * 才是真正的頁面級擋法。沿用 EssHeader 取 `/me` 的方式（lib/ess-api 的
 * getMe()）：essTabs 為 null（未設定限縮；intern 以外身分預設如此）或含有
 * 這個 tab key 才放行，否則顯示「此帳號未開放此功能」＋回首頁連結。
 *
 * `home` 永遠不套這層：它是 /ess 本身，擋了會讓人進站看不到任何分頁，
 * 而且工讀生也要打卡（跟 visibleTabs() 永遠保留 home 的規則一致）。
 *
 * `optimistic`：schedule/punches/requests/notifications/mydata 這五個高頻頁
 * （intern 沒特別設定時預設就看得到的分頁）傳這個 prop——`/me` 還沒回來前
 * 直接渲染 children，不擋一個置中的「載入中…」畫面；等確定不允許才換成
 * 「此帳號未開放此功能」。沒傳的頁面維持原本保守行為（loading 中先擋），
 * 這些頁通常本來就不是每次進站都會點，多一格 loading 不太影響體感。
 *
 * 載入中／`/me` 失敗一律不擋（跟 AuthGate 對 mustChangePassword 的失敗策略
 * 一致），避免把整個 ESS 卡死在一次非關鍵 API 失敗上。
 */
function Guard({
  tab,
  optimistic = false,
  children,
}: {
  tab: EssTabKey;
  optimistic?: boolean;
  children: React.ReactNode;
}) {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    getMe()
      .then((me) => {
        if (!active) return;
        const tabs = Array.isArray(me.essTabs) ? me.essTabs : null;
        setAllowed(tabs == null || tabs.includes(tab));
      })
      .catch(() => {
        if (active) setAllowed(true);
      });
    return () => {
      active = false;
    };
  }, [tab]);

  if (allowed === null) {
    if (optimistic) return <>{children}</>;
    return (
      <main className="min-h-dvh flex items-center justify-center">
        <p className="text-gray-500">載入中…</p>
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="min-h-dvh flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-bold text-gray-800">此帳號未開放此功能</h1>
        <p className="text-gray-500">請聯絡人資調整可用功能，或返回打卡首頁。</p>
        <Link
          href="/ess"
          className="rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: "var(--brand)" }}
        >
          回首頁
        </Link>
      </main>
    );
  }

  return <>{children}</>;
}

export function EssTabGate({
  tab,
  optimistic,
  children,
}: {
  tab: EssTabKey;
  /** 見上方 Guard 的說明；只有五個高頻頁面傳 true。 */
  optimistic?: boolean;
  children: React.ReactNode;
}) {
  return (
    <AuthGate>
      <Guard tab={tab} optimistic={optimistic}>
        {children}
      </Guard>
    </AuthGate>
  );
}
