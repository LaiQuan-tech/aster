"use client";

import { useEffect, useState } from "react";
import { Card, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import {
  PROJECT_MEMBER_ROLE_LABELS,
  PROJECT_MEMBER_ROLE_ORDER,
  updateProjectSettings,
  type ProjectMemberRole,
  type ProjectSettings,
} from "@/lib/projects-api";
import { humanizeBonusEditError } from "@/lib/projects-ext-api";

type Defaults = Partial<Record<ProjectMemberRole, number>>;

interface RoleShareDefaultsCardProps {
  defaults: Defaults;
  /** 只有老闆（或 platform_admin）能改；其他人唯讀。 */
  canEdit: boolean;
  bossConfigured: boolean;
  onSaved?: (settings: ProjectSettings) => void;
}

function toDraft(defaults: Defaults): Record<ProjectMemberRole, string> {
  const out = {} as Record<ProjectMemberRole, string>;
  for (const role of PROJECT_MEMBER_ROLE_ORDER) out[role] = defaults[role] != null ? String(defaults[role]) : "";
  return out;
}

/**
 * 分潤改版 #2（業主 2026-10-26）：各角色預設分潤趴數（租戶級，`project_settings.default_share_pct_by_role`）。
 * 專案成員編輯器新增成員時依角色帶入這裡的值；只有老闆能改。PUT 一律送完整四鍵（空白＝0）。
 */
export function RoleShareDefaultsCard({ defaults, canEdit, bossConfigured, onSaved }: RoleShareDefaultsCardProps) {
  const [draft, setDraft] = useState(() => toDraft(defaults));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(toDraft(defaults)), [defaults]);

  const total = PROJECT_MEMBER_ROLE_ORDER.reduce((sum, role) => sum + (Number(draft[role]) || 0), 0);

  async function save() {
    const body = {} as Record<ProjectMemberRole, number>;
    for (const role of PROJECT_MEMBER_ROLE_ORDER) {
      const raw = draft[role].trim();
      const n = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setError(`${PROJECT_MEMBER_ROLE_LABELS[role]}的趴數必須介於 0 與 100 之間`);
        return;
      }
      body[role] = n;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await updateProjectSettings({ defaultSharePctByRole: body });
      onSaved?.(res.settings);
      setSaved(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "儲存失敗";
      setError(humanizeBonusEditError(msg));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">各角色預設分潤趴數</h2>
          <p className="mt-0.5 text-xs text-gray-500">專案新增成員時依角色自動帶入；個別專案仍可由老闆調整後存檔。</p>
        </div>
        {!canEdit && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
            {bossConfigured ? "分潤比例僅老闆可修改" : "尚未指定老闆：請先到公司設定指定老闆"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {PROJECT_MEMBER_ROLE_ORDER.map((role) => (
          <div key={role}>
            <label className={labelCls} htmlFor={`role-share-${role}`}>{PROJECT_MEMBER_ROLE_LABELS[role]}</label>
            <div className="flex items-center gap-1">
              <input
                id={`role-share-${role}`}
                className={inputCls}
                type="number"
                min="0"
                max="100"
                step="0.01"
                inputMode="decimal"
                disabled={!canEdit || saving}
                value={draft[role]}
                placeholder="0"
                onChange={(e) => {
                  setSaved(false);
                  setDraft((d) => ({ ...d, [role]: e.target.value }));
                }}
              />
              <span className="text-sm text-gray-500">%</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">四個角色各自是「一位成員」的預設值，合計 {Math.round(total * 100) / 100}%（實際合計依專案人數而定）。</p>
        {canEdit && (
          <PrimaryButton onClick={save} disabled={saving}>{saving ? "儲存中…" : saved ? "已儲存" : "儲存預設趴數"}</PrimaryButton>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
