"use client";

/**
 * 設定 → 進階功能：
 *   1. 7 個預設隱藏的後台模組（lib/admin-nav.ts 的 ADMIN_MODULES）在這裡勾回。存在
 *      tenants.features.adminModules（key → boolean），勾選即存：先樂觀更新，再 PUT
 *      /api/tenant/settings（永遠送完整 map，後端對 adminModules 是整鍵覆蓋不是深合併），
 *      成功後 invalidateBranding() 讓 AdminShell 的分頁列同頁反映；失敗回滾＋錯誤 toast。
 *   2. 帳號安全：tenants.features.accounts.allowWeakInitialPassword（允許 HR 配發簡單密碼：建帳號時
 *      API 改用 password_hash、後台「設定密碼」時直接寫 auth.users，都略過 Supabase 外洩密碼名單檢查）。
 *      同一套勾選即存／回滾／toast；讀法在 lib/auth-api.ts 的 accountsFeatureOf。
 *   3. 會計可用範圍（W4，2026-09-23）：會計（employees.role='accountant'）在後台看得到哪些分區／
 *      分頁。存 tenants.features.roles.accountant（{sections, tabs}），**整鍵覆蓋**，所以存檔時
 *      一律送完整的 sections＋tabs。沒設定時用 lib/admin-nav.ts 的 ACCOUNTANT_DEFAULT_NAV。
 *      ⚠️ 這只管「看不看得見」，真正的權限在 API（requireFinance／requireHrAdmin）——把分頁勾回來
 *      不會讓會計拿到薪資資料，只會讓他點進去看到 403。
 * 三張卡共用同一次 getBrandingCached() 載入。頁首標題／說明由 AdminShell 依路由表提供，
 * 這裡不包 header／main。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, InlineError, Pill, Skeleton, useToast } from "@/components/admin-ui";
import { saveTenantSettings, type AccountsFeatureSettings } from "@/lib/admin-api";
import { accountsFeatureOf } from "@/lib/auth-api";
import { getBrandingCached, invalidateBranding } from "@/lib/ess-state";
import {
  ACCOUNTANT_DEFAULT_NAV,
  ADMIN_MODULES,
  ADMIN_SECTIONS,
  ADMIN_TABS,
  adminModulesOf,
  roleNavOf,
  type AdminModuleKey,
  type AdminModulesConfig,
  type AdminSectionKey,
  type RoleNavConfig,
} from "@/lib/admin-nav";

/** 分區 key → 側欄顯示名稱（列在每個模組旁的 Pill）。 */
const SECTION_LABEL: Partial<Record<AdminSectionKey, string>> = Object.fromEntries(
  ADMIN_SECTIONS.map((section) => [section.key, section.label]),
);

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** 會計範圍卡：home 永遠可見，不列出來讓人勾（勾掉也沒用，sectionsForRole 會補回去）。 */
const ROLE_NAV_SECTIONS = ADMIN_SECTIONS.filter((section) => section.key !== "home");

export default function AdvancedFeaturesPage() {
  const toast = useToast();
  /** null＝尚未載入（載入中或載入失敗）；載入失敗時不開放勾選，免得用不完整的 map 覆蓋。 */
  const [modules, setModules] = useState<AdminModulesConfig | null>(null);
  /** 帳號安全設定；同 modules，null＝尚未載入。 */
  const [accounts, setAccounts] = useState<AccountsFeatureSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<AdminModuleKey | null>(null);
  const [savingAccounts, setSavingAccounts] = useState(false);
  /** 會計可用範圍；null＝尚未載入。 */
  const [roleNav, setRoleNav] = useState<RoleNavConfig | null>(null);
  const [savingRoleNav, setSavingRoleNav] = useState(false);

  useEffect(() => {
    let active = true;
    getBrandingCached()
      .then((res) => {
        if (!active) return;
        setModules(adminModulesOf(res.features));
        setAccounts(accountsFeatureOf(res.features));
        // roleNavOf 以「會計」的身分問一次，拿到的就是租戶目前生效的會計範圍
        // （沒設定時＝ACCOUNTANT_DEFAULT_NAV）。
        setRoleNav(roleNavOf("accountant", res.features) ?? ACCOUNTANT_DEFAULT_NAV);
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

  /** 帳號安全：後端對 accounts 是整鍵覆蓋，所以送完整物件（展開既有值再改這一個鍵）。 */
  async function toggleWeakInitialPassword(enabled: boolean) {
    if (!accounts || savingAccounts) return;
    const prev = accounts;
    const next: AccountsFeatureSettings = { ...prev, allowWeakInitialPassword: enabled };
    setAccounts(next); // optimistic
    setSavingAccounts(true);
    try {
      await saveTenantSettings({ features: { accounts: next } });
      invalidateBranding();
      toast.show("已更新", "success");
    } catch (err) {
      setAccounts(prev); // 回滾
      toast.show(errMsg(err, "儲存失敗"), "error");
    } finally {
      setSavingAccounts(false);
    }
  }

  /** 會計範圍：整鍵覆蓋，所以每次都送完整的 {sections, tabs}。 */
  async function saveRoleNav(next: RoleNavConfig) {
    if (!roleNav || savingRoleNav) return;
    const prev = roleNav;
    setRoleNav(next); // optimistic
    setSavingRoleNav(true);
    try {
      await saveTenantSettings({ features: { roles: { accountant: next } } });
      invalidateBranding();
      toast.show("已更新", "success");
    } catch (err) {
      setRoleNav(prev); // 回滾
      toast.show(errMsg(err, "儲存失敗"), "error");
    } finally {
      setSavingRoleNav(false);
    }
  }

  /** 勾／取消一整個分區：取消時連該區的分頁清單一起清掉，不留孤兒設定。 */
  function toggleRoleSection(key: AdminSectionKey, enabled: boolean) {
    if (!roleNav) return;
    const sections = enabled
      ? [...new Set([...roleNav.sections, key])]
      : roleNav.sections.filter((k) => k !== key);
    const tabs = { ...roleNav.tabs };
    if (enabled) {
      // 新勾回來的分區預設「全部分頁」＝不列 tabs 鍵。
      delete tabs[key];
    } else {
      delete tabs[key];
    }
    void saveRoleNav({ sections, tabs });
  }

  /** 勾／取消單一分頁。該區原本沒有 tabs 鍵（＝全部）時，先展開成完整清單再減。 */
  function toggleRoleTab(section: AdminSectionKey, tabKey: string, enabled: boolean) {
    if (!roleNav) return;
    const all = ADMIN_TABS[section].map((t) => t.key);
    const current = roleNav.tabs[section] ?? all;
    const next = enabled
      ? all.filter((k) => current.includes(k) || k === tabKey)
      : current.filter((k) => k !== tabKey);
    void saveRoleNav({ sections: roleNav.sections, tabs: { ...roleNav.tabs, [section]: next } });
  }

  const loading = modules === null && !loadError;
  const disabled = modules === null || savingKey !== null;
  const accountsDisabled = accounts === null || savingAccounts;

  return (
    <>
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

      <Card title="帳號安全">
        {loading ? (
          <Skeleton lines={2} />
        ) : (
          <div className="flex items-start gap-3 py-1">
            <input
              id="advanced-accounts-allow-weak-initial-password"
              type="checkbox"
              checked={accounts?.allowWeakInitialPassword === true}
              disabled={accountsDisabled}
              onChange={(e) => void toggleWeakInitialPassword(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 accent-[var(--brand)] disabled:opacity-60"
            />
            <label htmlFor="advanced-accounts-allow-weak-initial-password" className="min-w-0 flex-1 cursor-pointer">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-gray-800">允許 HR 配發簡單初始密碼</span>
                {savingAccounts && <span className="text-xs text-gray-400">儲存中…</span>}
              </span>
              <span className="mt-0.5 block text-sm text-gray-500">
                開啟後，HR 在「新增員工帳號」與員工列表的「設定密碼」可以用像 password123 這種常見密碼（略過外洩密碼名單檢查）。
                同仁下次登入仍會被要求自設新密碼，自設的密碼一樣會做檢查。
              </span>
            </label>
          </div>
        )}
      </Card>

      <Card title="會計可用範圍">
        <p className="-mt-1 mb-3 text-sm text-gray-500">
          會計（員工角色設為「會計」的同仁）在後台看得到哪些分區與分頁。預設是
          專案與財務（不含獎金季發放）、出勤月表、報銷與預支、員工基本資料。
          <span className="block text-xs text-gray-400">
            這裡只管看不看得見；薪資、獎金與租戶設定的資料在 API 端就擋住了，勾回來也只會看到「無權限」。
          </span>
        </p>
        {loading || !roleNav ? (
          <Skeleton lines={6} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {ROLE_NAV_SECTIONS.map((section) => {
              const on = roleNav.sections.includes(section.key);
              const tabs = ADMIN_TABS[section.key];
              const allowed = roleNav.tabs[section.key] ?? tabs.map((t) => t.key);
              const id = `role-nav-section-${section.key}`;
              return (
                <li key={section.key} className="py-3">
                  <div className="flex items-start gap-3">
                    <input
                      id={id}
                      type="checkbox"
                      checked={on}
                      disabled={savingRoleNav}
                      onChange={(e) => toggleRoleSection(section.key, e.target.checked)}
                      className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 accent-[var(--brand)] disabled:opacity-60"
                    />
                    <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                      <span className="font-medium text-gray-800">{section.label}</span>
                      <span className="mt-0.5 block text-sm text-gray-500">{section.desc}</span>
                    </label>
                  </div>
                  {on && tabs.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-7">
                      {tabs.map((tab) => {
                        const tabId = `role-nav-tab-${section.key}-${tab.key}`;
                        return (
                          <label key={tab.key} htmlFor={tabId} className="flex cursor-pointer items-center gap-1.5 text-sm text-gray-600">
                            <input
                              id={tabId}
                              type="checkbox"
                              checked={allowed.includes(tab.key)}
                              disabled={savingRoleNav}
                              onChange={(e) => toggleRoleTab(section.key, tab.key, e.target.checked)}
                              className="h-3.5 w-3.5 rounded border-gray-300 accent-[var(--brand)] disabled:opacity-60"
                            />
                            {tab.label}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {savingRoleNav && <p className="mt-2 text-xs text-gray-400">儲存中…</p>}
      </Card>
    </>
  );
}
