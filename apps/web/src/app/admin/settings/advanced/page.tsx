"use client";

/**
 * 設定 → 進階功能：7 個預設隱藏的後台模組（lib/admin-nav.ts 的 ADMIN_MODULES）在這裡勾回。
 * 存在 tenants.features.adminModules（key → boolean），勾選即存：先樂觀更新，再 PUT
 * /api/tenant/settings（永遠送完整 map，後端對 adminModules 是整鍵覆蓋不是深合併），
 * 成功後 invalidateBranding() 讓 AdminShell 的分頁列同頁反映；失敗回滾＋錯誤 toast。
 * 頁首標題／說明由 AdminShell 依路由表提供，這裡不包 header／main。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, InlineError, Pill, Skeleton, useToast } from "@/components/admin-ui";
import { saveTenantSettings } from "@/lib/admin-api";
import { getBrandingCached, invalidateBranding } from "@/lib/ess-state";
import {
  ADMIN_MODULES,
  ADMIN_SECTIONS,
  adminModulesOf,
  type AdminModuleKey,
  type AdminModulesConfig,
  type AdminSectionKey,
} from "@/lib/admin-nav";

/** 分區 key → 側欄顯示名稱（列在每個模組旁的 Pill）。 */
const SECTION_LABEL: Partial<Record<AdminSectionKey, string>> = Object.fromEntries(
  ADMIN_SECTIONS.map((section) => [section.key, section.label]),
);

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function AdvancedFeaturesPage() {
  const toast = useToast();
  /** null＝尚未載入（載入中或載入失敗）；載入失敗時不開放勾選，免得用不完整的 map 覆蓋。 */
  const [modules, setModules] = useState<AdminModulesConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<AdminModuleKey | null>(null);

  useEffect(() => {
    let active = true;
    getBrandingCached()
      .then((res) => {
        if (active) setModules(adminModulesOf(res.features));
      })
      .catch((err) => {
        if (active) setLoadError(errMsg(err, "載入失敗"));
      });
    return () => {
      active = false;
    };
  }, []);

  async function toggle(key: AdminModuleKey, enabled: boolean) {
    if (!modules || savingKey) return;
    const prev = modules;
    const next: AdminModulesConfig = { ...prev, [key]: enabled };
    setModules(next); // optimistic
    setSavingKey(key);
    try {
      await saveTenantSettings({ features: { adminModules: next } });
      invalidateBranding();
      toast.show("已更新", "success");
    } catch (err) {
      setModules(prev); // 回滾
      toast.show(errMsg(err, "儲存失敗"), "error");
    } finally {
      setSavingKey(null);
    }
  }

  const loading = modules === null && !loadError;
  const disabled = modules === null || savingKey !== null;

  return (
    <Card>

      {loadError && <InlineError className="mt-3">載入設定失敗：{loadError}（請重新整理後再試）</InlineError>}

      {loading ? (
        <Skeleton lines={7} className="mt-4" />
      ) : (
        <ul className="mt-2 divide-y divide-gray-100">
          {ADMIN_MODULES.map((m) => {
            const id = `advanced-module-${m.key}`;
            const checked = modules?.[m.key] === true;
            return (
              <li key={m.key} className="flex items-start gap-3 py-3">
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => void toggle(m.key, e.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 accent-[var(--brand)] disabled:opacity-60"
                />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-800">{m.label}</span>
                    <Pill tone="gray">{SECTION_LABEL[m.section] ?? m.section}</Pill>
                    {savingKey === m.key && <span className="text-xs text-gray-400">儲存中…</span>}
                  </span>
                  <span className="mt-0.5 block text-sm text-gray-500">{m.desc}</span>
                </label>
                <Link href={m.href} className="shrink-0 py-0.5 text-sm font-medium hover:underline" style={{ color: "var(--brand)" }}>
                  開啟
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 border-t border-gray-100 pt-3 text-xs text-gray-400">
        Company Space 已精簡為『
        <Link href="/admin/company-space" className="underline">
          站台與內部連結
        </Link>
        』常駐於設定，不在此列。
      </p>
    </Card>
  );
}
