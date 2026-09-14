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
 * 允許放行的六個分頁（home/schedule/punches/requests/notifications/mydata）
 * 本來就沒有套這層——intern 的預設清單一定包含它們，套了也是白工。
 *
 * 載入中／`/me` 失敗一律不擋（跟 AuthGate 對 mustChangePassword 的失敗策略
 * 一致），避免把整個 ESS 卡死在一次非關鍵 API 失敗上。
 */
function Guard({ tab, children }: { tab: EssTabKey; children: React.ReactNode }) {
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
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">載入中…</p>
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
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

export function EssTabGate({ tab, children }: { tab: EssTabKey; children: React.ReactNode }) {
  return (
    <AuthGate>
      <Guard tab={tab}>{children}</Guard>
    </AuthGate>
  );
}
