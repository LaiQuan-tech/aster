"use client";

import { AdminGate } from "@/components/AdminGate";
import { AdminShell } from "@/components/AdminShell";

/**
 * 後台頁框：AdminGate（登入＋hr_admin／platform_admin 守門，/me 走共用快取）→
 * AdminShell（側欄 9 分區、分頁列、頁首、手機抽屜；導覽內容全在 lib/admin-nav.ts）。
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminGate>{(me) => <AdminShell me={me}>{children}</AdminShell>}</AdminGate>;
}
