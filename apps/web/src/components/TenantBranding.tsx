"use client";

import { useEffect } from "react";
import { getBrandingCached } from "@/lib/ess-state";

/**
 * 根 layout 掛的品牌套用：GET /api/tenant/branding → `--brand` 與 document.title。
 * 走 ess-state 的 getBrandingCached（共用快取＋in-flight 去重）：這支是整頁載入最早發出的
 * branding 請求，後面 AdminShell／EssShell 的 useEssState 直接命中，整頁只打一次。
 */
export function TenantBranding() {
  useEffect(() => {
    let active = true;
    getBrandingCached()
      .then((res) => {
        if (!active) return;
        const primaryColor = res.branding?.primaryColor;
        const appName = res.branding?.appName;
        if (primaryColor) {
          document.documentElement.style.setProperty("--brand", primaryColor);
        }
        if (appName) {
          document.title = appName;
        }
      })
      .catch(() => {
        /* Unauthenticated pages keep the default brand. */
      });
    return () => {
      active = false;
    };
  }, []);

  return null;
}
