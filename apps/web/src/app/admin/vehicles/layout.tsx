"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/admin-ui";
import { adminModulesOf, isModuleEnabled } from "@/lib/admin-nav";
import { useEssState } from "@/lib/ess-state";

/**
 * /admin/vehicles/** 的模組守門（2026-11-05 業主：模組關閉時隱藏選單與頁面）。
 * 其他隱藏模組直開網址仍可用；公務車比照 API（403 module_disabled）更嚴格：features 載入後
 * adminModules.vehicles !== true 就不渲染頁面，改顯示開啟方式。features 未回前照常渲染（避免閃爍；API 仍會擋）。
 */
export default function AdminVehiclesLayout({ children }: { children: ReactNode }) {
  const state = useEssState();
  const enabled = isModuleEnabled(adminModulesOf(state.features), "vehicles");
  if (state.loaded && !enabled) {
    return (
      <Card>
        <h2 className="text-base font-semibold text-gray-800">公務車功能尚未開啟</h2>
        <p className="mt-1 text-sm text-gray-500">
          到「設定 → 進階功能」勾選「公務車」後，後台與員工端才會出現公務車頁面。
        </p>
        <Link href="/admin/settings/advanced" className="mt-3 inline-block text-sm font-medium underline" style={{ color: "var(--brand)" }}>
          前往進階功能
        </Link>
      </Card>
    );
  }
  return <>{children}</>;
}
