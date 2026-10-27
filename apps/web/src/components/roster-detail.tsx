"use client";

/**
 * 名冊內頁（/admin/clients/[id]、/admin/vendors/[id]）共用的版面零件（2026-10-27 業主：
 * 列表按「編輯」改進內頁編輯，比照員工內頁 /admin/employees/[id]）：
 *   - RosterDetailHeader：上方「← 返回列表」、標題、副標、徽章，右側放動作（刪除）。
 *   - RosterSection：有標題的區塊卡，欄位兩欄格線（手機一欄）；disabled＝唯讀或儲存中。
 *   - RosterSaveBar：固定在頁面底部的「取消／儲存」列（與員工內頁同一個樣式）。
 *   - useRosterRoles：目前登入者是不是 HR／平台管理員（關係企業、刪除）、會計／HR（廠商新增修改、收款帳戶）。
 */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button, Card, ErrorText } from "@/components/admin-ui";
import { getMeCached, peekMeCached } from "@/lib/ess-state";
import { isAdminRole, isHrRole } from "@/lib/roles";

export function useRosterRoles(): { isHr: boolean; isAdmin: boolean } {
  const [roles, setRoles] = useState(() => {
    const role = peekMeCached()?.role;
    return { isHr: isHrRole(role), isAdmin: isAdminRole(role) };
  });
  useEffect(() => {
    let active = true;
    getMeCached()
      .then((me) => {
        if (active) setRoles({ isHr: isHrRole(me.role), isAdmin: isAdminRole(me.role) });
      })
      .catch(() => {
        // 取不到角色就當不能（API 仍會擋）。
        if (active) setRoles({ isHr: false, isAdmin: false });
      });
    return () => {
      active = false;
    };
  }, []);
  return roles;
}

export function RosterDetailHeader({
  backHref,
  backLabel,
  title,
  subtitle,
  badges,
  actions,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link href={backHref} className="text-sm text-gray-500 hover:text-gray-800 hover:underline">
            ← {backLabel}
          </Link>
          <h2 className="mt-1 break-words text-xl font-bold text-gray-900">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p> : null}
          {badges ? <div className="mt-2 flex flex-wrap gap-1.5">{badges}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </Card>
  );
}

export function RosterSection({
  title,
  hint,
  disabled,
  children,
}: {
  title: string;
  hint?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
      <fieldset disabled={disabled} className="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {children}
      </fieldset>
    </Card>
  );
}

export function RosterSaveBar({
  dirty,
  saving,
  error,
  isNew,
  canSave,
  saveLabel,
  onCancel,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  isNew: boolean;
  /** 必填欄位都有值（公司名稱）。 */
  canSave: boolean;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="sticky bottom-0 z-30 rounded-xl border border-gray-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur lg:pr-44">
      {error && (
        <div className="mb-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="flex items-center justify-end gap-3">
        <span className="mr-auto text-xs text-gray-500" aria-live="polite">
          {isNew ? (canSave ? "填好後按「" + saveLabel + "」建檔" : "請至少填公司名稱") : dirty ? "有尚未儲存的修改" : "所有修改都已儲存"}
        </span>
        <Button variant="secondary" onClick={onCancel} disabled={saving || (!isNew && !dirty)}>
          取消
        </Button>
        <Button variant="primary" onClick={onSave} loading={saving} disabled={!canSave || (!isNew && !dirty && !error)}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
