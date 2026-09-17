"use client";

import type { ReactNode } from "react";
import { AuthGate } from "@/components/AuthGate";
import { EssShell } from "@/components/EssShell";

/**
 * /ess/** 共用 layout：登入守門（AuthGate）→ 共用頁框（EssShell：頂部列、底部分頁列、
 * 桌機導覽、頁面 gate、ToastProvider）。頁面本身不再各自包 AuthGate／EssHeader。
 */
export default function EssLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <EssShell>{children}</EssShell>
    </AuthGate>
  );
}
