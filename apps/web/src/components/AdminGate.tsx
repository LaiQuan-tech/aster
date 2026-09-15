"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "@/components/AuthGate";
import { getMe, type Me } from "@/lib/admin-api";
import { ADMIN_ROLES } from "@/lib/roles";

/**
 * Back-office gate. Sits inside AuthGate (so an unauthenticated visitor is
 * already bounced to /login), then calls GET /me: only hr_admin / platform_admin
 * may proceed; everyone else sees a "no permission" panel with a link back to
 * the ESS. The resolved profile is handed to children via a render prop so the
 * layout can show the signed-in admin without re-fetching.
 */
function Guard({ children }: { children: (me: Me) => React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "denied" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const profile = await getMe();
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
  }, []);

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
        <p className="text-gray-500">此頁面僅限 HR 管理員存取。</p>
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
