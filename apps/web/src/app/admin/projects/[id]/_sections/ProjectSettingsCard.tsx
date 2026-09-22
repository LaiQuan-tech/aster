"use client";

import { useEffect, useState } from "react";
import { Card, ErrorText, inputCls, labelCls } from "@/components/admin-ui";
import { ClientCombo } from "@/components/ClientCombo";
import type { Department, Employee } from "@/lib/admin-api";
import {
  getProjectSettings,
  updateProjectSettings,
  PROJECT_MEMBER_ROLE_LABELS,
  PROJECT_MEMBER_ROLE_ORDER,
  type ProjectMemberRole,
  type ShareMode,
} from "@/lib/projects-api";
import { listClients, type Client, type ProjectDetail, type UpdateProjectExtBody } from "@/lib/projects-ext-api";

interface ProjectSettingsCardProps {
  project: ProjectDetail;
  depts: Department[];
  emps: Employee[];
  isPool: boolean;
  /** W4：分潤區（獎金池、角色預設趴數）的可見性。會計為 false。 */
  canBonus: boolean;
  saveProjectField: (patch: UpdateProjectExtBody) => Promise<void>;
  error: string | null;
}

/**
 * 專案設定（客戶／部門／負責人／分潤模式／年度／起迄日）。欄位即存，走
 * page.tsx 的 saveProjectField。客戶名冊自己抓（B4）——`[id]/page.tsx`
 * 目前沒有載入 clients，改成外部傳入要動到那支檔案，這裡改成自給自足即可。
 *
 * W3（2026-09-23）另加「成員角色預設分潤」：四個角色各一個趴數，新增成員沒填
 * 趴數時後端會套上去。這是**租戶級**設定（`project_settings.default_share_pct_by_role`），
 * 不是這個專案的設定——改了會影響之後所有專案的新成員，所以卡片上寫明。
 */
export function ProjectSettingsCard({ project, depts, emps, isPool, canBonus, saveProjectField, error }: ProjectSettingsCardProps) {
  const [clients, setClients] = useState<Client[]>([]);
  const [defaultShare, setDefaultShare] = useState<Partial<Record<ProjectMemberRole, number>> | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  useEffect(() => {
    listClients().then((r) => setClients(r.clients)).catch(() => {});
    if (!canBonus) return;
    getProjectSettings()
      .then((r) => setDefaultShare(r.settings.defaultSharePctByRole ?? {}))
      .catch(() => setDefaultShare({}));
  }, [canBonus]);

  /** 整鍵覆蓋：送完整四鍵，空白的角色不進物件（＝沒有預設）。 */
  async function saveDefaultShare(role: ProjectMemberRole, raw: string) {
    if (!defaultShare) return;
    const next: Partial<Record<ProjectMemberRole, number>> = { ...defaultShare };
    if (raw === "") delete next[role];
    else next[role] = Number(raw);
    setDefaultShare(next);
    setShareError(null);
    try {
      const res = await updateProjectSettings({ defaultSharePctByRole: next });
      setDefaultShare(res.settings.defaultSharePctByRole ?? {});
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "儲存預設分潤失敗");
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">專案設定</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls}>客戶</label>
          <ClientCombo clients={clients} clientId={project.clientId} onChange={(id) => saveProjectField({ clientId: id })} />
        </div>
        <div>
          <label className={labelCls}>所屬部門</label>
          <select
            className={inputCls}
            value={project.deptId ?? ""}
            onChange={(e) => saveProjectField({ deptId: e.target.value || null })}
          >
            <option value="">不指定</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>專案負責人</label>
          <select
            className={inputCls}
            value={project.leadEmpId ?? ""}
            onChange={(e) => saveProjectField({ leadEmpId: e.target.value || null })}
          >
            <option value="">不指定</option>
            {emps.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>分潤模式</label>
          <select
            className={inputCls}
            value={project.shareMode}
            disabled={!canBonus}
            onChange={(e) => saveProjectField({ shareMode: e.target.value as ShareMode })}
          >
            <option value="pool_pct">獎金池 × 百分比</option>
            <option value="fixed_amount">直接填每人金額</option>
          </select>
        </div>
        {isPool && canBonus && (
          <div>
            <label className={labelCls}>獎金池總額</label>
            <input
              className={inputCls}
              type="number"
              min="0"
              defaultValue={project.bonusPool ?? ""}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                if (v !== project.bonusPool) saveProjectField({ bonusPool: v });
              }}
            />
          </div>
        )}
        <div>
          <label className={labelCls}>歸屬年度</label>
          <input
            className={inputCls}
            type="number"
            min="2000"
            max="2100"
            defaultValue={project.fiscalYear ?? ""}
            onBlur={(e) => {
              const v = e.target.value === "" ? null : Number(e.target.value);
              if (v !== project.fiscalYear) saveProjectField({ fiscalYear: v });
            }}
          />
          <p className="mt-1 text-xs text-gray-400">
            報表與獎金歸在哪一年。編號裡的年度是建立年，已印在合約上，不隨這裡改動。
          </p>
        </div>
        <div>
          <label className={labelCls}>開案日期</label>
          <input
            className={inputCls}
            type="date"
            defaultValue={project.openedOn ?? ""}
            onBlur={(e) => {
              const v = e.target.value || null;
              if (v !== (project.openedOn ?? null)) saveProjectField({ openedOn: v });
            }}
          />
          <p className="mt-1 text-xs text-gray-400">
            申請單抬頭與年度總表的建立日期依據；預先取號的舊案子若這裡是空的可手動補。
          </p>
        </div>
        <div>
          <label className={labelCls}>預定起始日</label>
          <input
            className={inputCls}
            type="date"
            defaultValue={project.startsOn ?? ""}
            onBlur={(e) => {
              const v = e.target.value || null;
              if (v !== (project.startsOn ?? null)) saveProjectField({ startsOn: v });
            }}
          />
        </div>
        <div>
          <label className={labelCls}>預定完工日</label>
          <input
            className={inputCls}
            type="date"
            defaultValue={project.endsOn ?? ""}
            onBlur={(e) => {
              const v = e.target.value || null;
              if (v !== (project.endsOn ?? null)) saveProjectField({ endsOn: v });
            }}
          />
          <p className="mt-1 text-xs text-gray-400">
            甘特圖與進度示警的依據。過了完工日還沒結案會被示警。
          </p>
        </div>
      </div>

      {isPool && canBonus && (
        <div className="mt-4 border-t pt-4">
          <label className={labelCls}>成員角色預設分潤 %</label>
          <p className="-mt-1 mb-2 text-xs text-gray-400">
            新增成員時沒填趴數就套這裡的值。這是<span className="font-medium text-gray-500">全租戶共用</span>的設定，
            改了會影響之後所有專案的新成員，既有成員的趴數不動。留空＝該角色沒有預設。
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {PROJECT_MEMBER_ROLE_ORDER.map((role) => (
              <div key={role}>
                <p className="mb-1 text-xs text-gray-500">{PROJECT_MEMBER_ROLE_LABELS[role]}</p>
                <input
                  className={inputCls}
                  type="number"
                  min="0"
                  max="100"
                  disabled={defaultShare === null}
                  defaultValue={defaultShare?.[role] ?? ""}
                  onBlur={(e) => {
                    const cur = defaultShare?.[role];
                    const v = e.target.value === "" ? undefined : Number(e.target.value);
                    if (v !== cur) void saveDefaultShare(role, e.target.value);
                  }}
                />
              </div>
            ))}
          </div>
          <ErrorText>{shareError}</ErrorText>
        </div>
      )}

      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
