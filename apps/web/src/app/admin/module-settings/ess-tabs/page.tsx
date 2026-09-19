"use client";

/**
 * 員工端功能開放（/admin/module-settings/ess-tabs）：依身分類別勾選 ESS 可見／可進入的分頁，
 * 存到 tenants.features.essTabs。PUT /api/tenant/settings 的 features 是後端淺層合併，這裡只送
 * essTabs 一鍵，其他鍵不動；存成功後 invalidateBranding() 讓 ess-state 的快取同步。
 * 純邏輯（預設值／還原／切換）在 lib/ess-tabs-config.ts；頁面標題與說明由 AdminShell 依路由表渲染。
 */
import { useEffect, useState } from "react";
import { Button, Card, InlineError, Skeleton, useToast } from "@/components/admin-ui";
import { getBranding, saveTenantSettings } from "@/lib/admin-api";
import { invalidateBranding } from "@/lib/ess-state";
import { EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS } from "@/lib/ess-tabs";
import {
  configurableEssTabs,
  defaultEssTabsConfig,
  hydrateEssTabsConfig,
  toggleEssTab,
  type EssTabsConfig,
} from "@/lib/ess-tabs-config";

/** 可勾選的 tab（排除永遠可見的 home／announcements），模組層算一次。 */
const CONFIGURABLE_TABS = configurableEssTabs();

export default function EssTabsSettingsPage() {
  const toast = useToast();
  const [cfg, setCfg] = useState<EssTabsConfig>(() => defaultEssTabsConfig());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBranding()
      .then((res) => {
        if (cancelled) return;
        setCfg(hydrateEssTabsConfig(res.features?.essTabs));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "載入員工端功能開放設定失敗");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveTenantSettings({ features: { essTabs: cfg } });
      setCfg(hydrateEssTabsConfig(saved.features?.essTabs ?? cfg));
      invalidateBranding();
      toast.show("員工端功能開放設定已儲存", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存員工端功能開放設定失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <p className="mb-4 text-sm text-gray-500">
        打卡首頁與公告一律開放，不列在下方；實習生預設只另外開放五個（班表／打卡紀錄／申請／通知／我的資料）。
      </p>
      {loaded ? (
        <div className="space-y-5">
          {EMPLOYMENT_TYPES.map((type) => (
            <div key={type}>
              <p className="mb-2 text-sm font-medium text-gray-700">{EMPLOYMENT_TYPE_LABELS[type]}</p>
              <div className="flex flex-wrap gap-2">
                {CONFIGURABLE_TABS.map((t) => {
                  const checked = cfg[type]?.includes(t.key) ?? false;
                  return (
                    <label
                      key={t.key}
                      className="flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-sm text-gray-700"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setCfg((prev) => toggleEssTab(prev, type, t.key))}
                      />
                      {t.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Skeleton lines={4} />
      )}
      <InlineError className="mt-3">{error}</InlineError>
      <div className="mt-4">
        <Button variant="primary" onClick={() => void onSave()} loading={saving} disabled={!loaded}>
          儲存員工端功能開放設定
        </Button>
      </div>
    </Card>
  );
}
