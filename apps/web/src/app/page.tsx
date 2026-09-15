"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/use-session";

/**
 * Entry point: bounce to /ess when signed in, otherwise to /login. Kept as a
 * tiny client redirect so it reuses the same persisted Supabase session.
 */
export default function Home() {
  const { session, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(session ? "/ess" : "/login");
  }, [loading, session, router]);

  return (
    <main className="min-h-dvh flex items-center justify-center">
      <p className="text-gray-500">載入中…</p>
    </main>
  );
}
