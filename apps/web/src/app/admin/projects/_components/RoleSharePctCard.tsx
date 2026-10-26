"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Card, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { PROJECT_MEMBER_ROLE_LABELS, PROJECT_MEMBER_ROLE_ORDER, type ProjectMemberRole } from "@/lib/projects-api";
import { humanizeBonusEditError } from "@/lib/projects-ext-api";
import { parseRoleSharePctDraft, roleSharePctDraftOf, type RoleSharePct } from "@/lib/project-share-calculation";

type Draft = Record<ProjectMemberRole, string>;

/** 四角色（經理／主辦／支援／組員）的分潤趴數輸入格。申請單（建案表單）與下方卡片共用。 */
export function RoleSharePctInputs({
  draft,
  onChange,
  disabled,
  idPrefix,
}: {
  draft: Draft;
  onChange: (role: ProjectMemberRole, value: string) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {PROJECT_MEMBER_ROLE_ORDER.map((role) => (
        <div key={role}>
          <label className={labelCls} htmlFor={`${idPrefix}-${role}`}>{PROJECT_MEMBER_ROLE_LABELS[role]}</label>
          <div className="flex items-center gap-1">
            <input
              id={`${idPrefix}-${role}`}
              className={inputCls}
              type="number"
              min="0"
              max="100"
              step="0.01"
              inputMode="decimal"
              disabled={disabled}
              value={draft[role]}
              placeholder="0"
              onChange={(e) => onChange(role, e.target.value)}
            />
            <span className="text-sm text-gray-500">%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 唯讀時的提示：分潤比例僅老闆可修改（沒設老闆時改提示先指定老闆）。 */
export function RoleShareReadOnlyBadge({ bossConfigured }: { bossConfigured: boolean }) {
  return (
    <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
      {bossConfigured ? "分潤比例僅老闆可修改" : "尚未指定老闆：請先到公司設定指定老闆"}
    </span>
  );
}

interface RoleSharePctCardProps {
  title: string;
  description?: ReactNode;
  values: RoleSharePct | null | undefined;
  /** 只有老闆（或 platform_admin）能改；其他人唯讀。 */
  canEdit: boolean;
  bossConfigured: boolean;
  /** 送出四鍵（空白＝0）；`allowUnset` 時四格全空白送 null。失敗請 throw，訊息會顯示在卡片上。 */
  onSave: (value: Record<ProjectMemberRole, number> | null) => Promise<void>;
  allowUnset?: boolean;
  saveLabel?: string;
  idPrefix: string;
  /** 放在其他卡片裡（例如專案申請單）時不另包一層 Card。 */
  embedded?: boolean;
}

/**
 * 各角色分潤趴數（經理／主辦／支援／組員 %）。2026-10-27 起有兩個用途：
 *   • 每個專案的「專案申請單」裡：本案的趴數（`projects.share_pct_by_role`），新增成員時依角色帶入。
 *   • 設定頁：租戶的「新專案起始值」（`project_settings.default_share_pct_by_role`），建案時複製進專案。
 * 兩者都只有老闆能改。
 */
export function RoleSharePctCard({
  title,
  description,
  values,
  canEdit,
  bossConfigured,
  onSave,
  allowUnset = false,
  saveLabel = "儲存分潤趴數",
  idPrefix,
  embedded = false,
}: RoleSharePctCardProps) {
  const [draft, setDraft] = useState<Draft>(() => roleSharePctDraftOf(values));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(roleSharePctDraftOf(values)), [values]);

  const total = PROJECT_MEMBER_ROLE_ORDER.reduce((sum, role) => sum + (Number(draft[role]) || 0), 0);

  async function save() {
    const parsed = parseRoleSharePctDraft(draft, { allowUnset });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onSave(parsed.value);
      setSaved(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "儲存失敗";
      setError(humanizeBonusEditError(msg));
    } finally {
      setSaving(false);
    }
  }

  const body = (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-gray-500">{description}</p> : null}
        </div>
        {!canEdit && <RoleShareReadOnlyBadge bossConfigured={bossConfigured} />}
      </div>
      <RoleSharePctInputs
        draft={draft}
        idPrefix={idPrefix}
        disabled={!canEdit || saving}
        onChange={(role, value) => {
          setSaved(false);
          setDraft((d) => ({ ...d, [role]: value }));
        }}
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">四個角色各自是「一位成員」的趴數，合計 {Math.round(total * 100) / 100}%（實際合計依專案人數而定）。</p>
        {canEdit && (
          <PrimaryButton onClick={save} disabled={saving}>{saving ? "儲存中…" : saved ? "已儲存" : saveLabel}</PrimaryButton>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </>
  );

  if (embedded) return <div className="rounded-lg border border-gray-100 p-3">{body}</div>;
  return <Card>{body}</Card>;
}
