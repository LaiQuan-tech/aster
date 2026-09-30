"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/AuthGate";
import type { Me } from "@/lib/admin-api";
import { getMeCached, peekMeCached } from "@/lib/ess-state";
import { ADMIN_ROLES } from "@/lib/roles";

type GuardState = "loading" | "ok" | "denied" | "error";

/** 掛載當下 /me 已在快取（AuthGate 剛抓過、或從員工端切過來）→ 直接決定，不先畫一輪「載入中」。 */
function initialGuard(): { me: Me | null; state: GuardState } {
  const cached = peekMeCached();
  if (!cached) return { me: null, state: "loading" };
  return ADMIN_ROLES.includes(cached.role) ? { me: cached, state: "ok" } : { me: null, state: "denied" };
}

/**
 * Back-office gate. Sits inside AuthGate (so an unauthenticated visitor is
 * already bounced to /login), then reads GET /me（走 lib/ess-state 的 getMeCached：
 * 與 AuthGate／AdminShell／員工端共用同一份模組層快取，整頁只打一次——AuthGate 放行時
 * 快取已經有了，這裡同步 peek 就能在同一輪 render 畫出 AdminShell＋頁面，頁面資料立刻開打）:
 * only ADMIN_ROLES
 * （hr_admin / platform_admin，2026-09-23 起加 accountant 會計——會計看到的分區由
 * lib/admin-nav.ts roleNavOf 限縮，API 端另有 requireFinance 守門）may proceed;
 * everyone else sees a "no permission" panel with a link back to the ESS. The
 * resolved profile is handed to children via a render prop so the layout can
 * show the signed-in admin without re-fetching.
 */
function Guard({ children }: { children: (me: Me) => React.ReactNode }) {
  const [initial] = useState(initialGuard);
  const [me, setMe] = useState<Me | null>(initial.me);
  const [state, setState] = useState<GuardState>(initial.state);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial.state !== "loading") return; // 已由快取決定
    let active = true;
    (async () => {
      try {
        const profile = await getMeCached();
        if (!active) return;
        if (ADMIN_ROLES.includes(profile.role)) {
          setMe(profile);
          setState("ok");
        } else {
          setState("denied");
        }
      } catch (err) {
        if (!active) return;
        // A 404 from /me (token user has no employee row) is effectively "no
        // access" too; anything else is surfaced as an error.
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 403) {
          setState("denied");
        } else {
          setError(err instanceof Error ? err.message : "載入失敗");
          setState("error");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [initial.state]);

  if (state === "loading") {
    return (
      <main className="min-h-dvh flex items-center justify-center">
        <p className="text-gray-500">載入中…</p>
      </main>
    );
  }

  if (state === "denied") {
    return (
      <main className="min-h-dvh flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-bold text-gray-800">無權限</h1>
        <p className="text-gray-500">此頁面僅限 HR 管理員與會計存取。</p>
        <Link
          href="/ess"
          className="rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: "var(--brand)" }}
        >
          回到員工自助
        </Link>
      </main>
    );
  }

  if (state === "error") {
    return (
      <main className="min-h-dvh flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-red-600" role="alert">
          {error}
        </p>
        <Link href="/ess" className="text-sm text-gray-500 hover:underline">
          回到員工自助
        </Link>
      </main>
    );
  }

  return <>{me && children(me)}</>;
}

export function AdminGate({ children }: { children: (me: Me) => React.ReactNode }) {
  return (
    <AuthGate>
      <Guard>{children}</Guard>
    </AuthGate>
  );
}
