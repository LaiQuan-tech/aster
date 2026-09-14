"use client";

import { Card, PrimaryButton, ErrorText, inputCls, labelCls } from "@/components/admin-ui";
import { PROJECT_STATUS_ORDER, PROJECT_STATUS_LABELS, statusLabel, type ProjectStatus } from "@/lib/projects-api";
import { updateProjectFields, type ProjectDetail, type UpdateProjectExtBody } from "@/lib/projects-ext-api";
import { STATUS_ERRORS, humanError, type Setter } from "./shared";

interface StatusCardProps {
  project: ProjectDetail;
  newStatus: ProjectStatus | "";
  setNewStatus: Setter<ProjectStatus | "">;
  statusReason: string;
  setStatusReason: Setter<string>;
  statusEffectiveOn: string;
  setStatusEffectiveOn: Setter<string>;
  savingStatus: boolean;
  setSavingStatus: Setter<boolean>;
  saveProjectField: (patch: UpdateProjectExtBody) => Promise<void>;
  error: string | null;
  setError: Setter<string | null>;
  load: () => Promise<void>;
}

/** 案情狀態（模組四第 2 條）。改狀態要理由，所以不能是即存下拉；封存是另一軸，走 saveProjectField。 */
export function StatusCard({
  project,
  newStatus,
  setNewStatus,
  statusReason,
  setStatusReason,
  statusEffectiveOn,
  setStatusEffectiveOn,
  savingStatus,
  setSavingStatus,
  saveProjectField,
  error,
  setError,
  load,
}: StatusCardProps) {
  async function changeStatus() {
    if (!project || !newStatus) return;
    if (!statusReason.trim()) {
      setError(STATUS_ERRORS.status_reason_required);
      return;
    }
    setSavingStatus(true);
    setError(null);
    try {
      await updateProjectFields(project.id, {
        status: newStatus,
        statusReason: statusReason.trim(),
        statusEffectiveOn: statusEffectiveOn || null,
      });
      setNewStatus("");
      setStatusReason("");
      setStatusEffectiveOn("");
      await load();
    } catch (err) {
      setError(humanError(err, "變更狀態失敗"));
    } finally {
      setSavingStatus(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">案情狀態</h2>

      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            project.status === "active"
              ? "bg-green-50 text-green-700"
              : project.status === "suspended"
                ? "bg-amber-50 text-amber-700"
                : project.status === "terminated"
                  ? "bg-red-50 text-red-700"
                  : "bg-gray-100 text-gray-600"
          }`}
        >
          {statusLabel(project.status)}
        </span>
        {project.statusEffectiveOn && (
          <span className="text-gray-500">自 {project.statusEffectiveOn} 起</span>
        )}
        {project.archivedAt && (
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500">已封存</span>
        )}
      </div>
      {project.statusReason && (
        <p className="mb-4 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
          理由：{project.statusReason}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className={labelCls}>變更為</label>
          <select
            className={inputCls}
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value as ProjectStatus | "")}
          >
            <option value="">不變更</option>
            {PROJECT_STATUS_ORDER.filter((v) => v !== project.status).map((v) => (
              <option key={v} value={v}>{PROJECT_STATUS_LABELS[v]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>生效日</label>
          <input
            className={inputCls}
            type="date"
            value={statusEffectiveOn}
            onChange={(e) => setStatusEffectiveOn(e.target.value)}
          />
          <p className="mt-1 text-xs text-gray-400">
            解約通知書／結案文件上的那一天，不是今天。留空才用今天。
          </p>
        </div>
        <div>
          <label className={labelCls}>理由 *</label>
          <input
            className={inputCls}
            value={statusReason}
            onChange={(e) => setStatusReason(e.target.value)}
            placeholder="例如：業主資金斷鏈，依約第 12 條終止"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <PrimaryButton onClick={changeStatus} disabled={savingStatus || !newStatus}>
          {savingStatus ? "變更中…" : "變更狀態"}
        </PrimaryButton>
        <span className="text-xs text-gray-400">
          狀態變更不擋（結案後返工是真的），但一律留下理由與生效日。
        </span>
      </div>

      <div className="mt-5 border-t pt-4">
        <label className={labelCls}>封存（只影響列表是否顯示，與案情無關）</label>
        {project.status === "active" ? (
          <p className="text-sm text-gray-400">
            「進行中」的專案不能封存。要收起來請先改成暫停、結案或已解約。
          </p>
        ) : (
          <button
            type="button"
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            onClick={() => saveProjectField({ archived: !project.archivedAt })}
          >
            {project.archivedAt ? "取消封存" : "封存此專案"}
          </button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
