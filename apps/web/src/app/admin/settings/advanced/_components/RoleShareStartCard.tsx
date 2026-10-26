"use client";

/**
 * 設定 → 進階功能 →「新專案起始值：各角色分潤趴數」（2026-10-27）。
 *
 * 原本是專案列表頁上方的全公司共用卡（project_settings.default_share_pct_by_role）。業主改成每個專案在
 * 「專案申請單」各自設定後，這組值保留為**新專案的起始值**：建案時預填進申請單、HR 建案時由後端複製進專案；
 * 專案沒有自己的設定時，新增成員也退回這組值。改這裡**不會**回頭動到已建立的專案。
 * 只有老闆（或 platform_admin）能改，其他人唯讀（後端 PUT /project-settings 另外擋）。
 */
import { useEffect, useState } from "react";
import { InlineError, Skeleton } from "@/components/admin-ui";
import { getProjectSettings, updateProjectSettings, type ProjectSettingsResponse } from "@/lib/projects-api";
import { RoleSharePctCard } from "@/app/admin/projects/_components/RoleSharePctCard";

export function RoleShareStartCard() {
  const [loaded, setLoaded] = useState<ProjectSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getProjectSettings()
      .then((res) => active && setLoaded(res))
      .catch((err) => active && setLoadError(err instanceof Error && err.message ? err.message : "載入失敗"));
    return () => {
      active = false;
    };
  }, []);

  if (loadError) return <InlineError>新專案起始值載入失敗：{loadError}</InlineError>;
  if (!loaded) return <Skeleton className="h-32" />;

  return (
    <RoleSharePctCard
      idPrefix="role-share-start"
      title="新專案起始值：各角色分潤趴數"
      description="建立新專案時預填進專案申請單；每個專案的實際趴數在該案的申請單各自調整。改這裡不會影響已建立的專案。"
      values={loaded.settings.defaultSharePctByRole ?? {}}
      canEdit={loaded.canEditBonus === true}
      bossConfigured={loaded.bossConfigured !== false}
      saveLabel="儲存起始值"
      onSave={async (value) => {
        const res = await updateProjectSettings({ defaultSharePctByRole: value ?? {} });
        setLoaded((cur) => (cur ? { ...cur, settings: res.settings } : cur));
      }}
    />
  );
}
