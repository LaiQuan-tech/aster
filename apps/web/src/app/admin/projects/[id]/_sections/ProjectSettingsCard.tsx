"use client";

import { Card, ErrorText, inputCls, labelCls } from "@/components/admin-ui";
import type { Department, Employee } from "@/lib/admin-api";
import type { ProjectDetail, UpdateProjectExtBody } from "@/lib/projects-ext-api";
import { parentProjectPatch } from "../../_components/project-application-form";

interface ProjectSettingsCardProps {
  project: ProjectDetail;
  depts: Department[];
  emps: Employee[];
  /**
   * 「母案」下拉的選項（page.tsx 以 `parentProjectChoices` 算好）：同租戶的主案、已排除本案；
   * 只有變更設計／追加／代墊會用到（主案不能掛母案，下拉不顯示）。
   */
  parentChoices: Array<{ id: string; label: string }>;
  /** 後端 PATCH 需要 canManage（＝access.finance）；false 時欄位唯讀。 */
  canEdit: boolean;
  saveProjectField: (patch: UpdateProjectExtBody) => Promise<void>;
  error: string | null;
}

/**
 * 申請單上沒有、但系統要的專案設定（母案／部門／負責人／歸屬年度）。欄位即存，走
 * page.tsx 的 saveProjectField。申請單上有的欄位（工程名稱、開案日期、承接公司、客戶…）
 * 在上方的申請單表格裡改；分潤模式與獎金池在頁面最下方的「專案獎金與分潤」。
 */
export function ProjectSettingsCard({ project, depts, emps, parentChoices, canEdit, saveProjectField, error }: ProjectSettingsCardProps) {
  const lockedTitle = canEdit ? undefined : "需要本案的財務權限才能修改";
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">其他專案設定</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {project.kind !== "main" && (
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="project-parent">母案</label>
            <select
              id="project-parent"
              className={inputCls}
              value={project.parentProjectId ?? ""}
              disabled={!canEdit}
              title={lockedTitle}
              onChange={(e) => {
                const patch = parentProjectPatch(project, e.target.value);
                if (Object.keys(patch).length > 0) saveProjectField(patch);
              }}
            >
              <option value="">未指定（可事後補上）</option>
              {parentChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>{choice.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">母案是選填，可隨時補上或清空；只能選主案，不能選自己。</p>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="project-dept">所屬部門</label>
          <select
            id="project-dept"
            className={inputCls}
            value={project.deptId ?? ""}
            disabled={!canEdit}
            title={lockedTitle}
            onChange={(e) => saveProjectField({ deptId: e.target.value || null })}
          >
            <option value="">不指定</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="project-lead">專案負責人</label>
          <select
            id="project-lead"
            className={inputCls}
            value={project.leadEmpId ?? ""}
            disabled={!canEdit}
            title={lockedTitle}
            onChange={(e) => saveProjectField({ leadEmpId: e.target.value || null })}
          >
            <option value="">不指定</option>
            {emps.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="project-fiscal-year">歸屬年度</label>
          <input
            id="project-fiscal-year"
            className={inputCls}
            type="number"
            min="2000"
            max="2100"
            disabled={!canEdit}
            title={lockedTitle}
            defaultValue={project.fiscalYear ?? ""}
            onBlur={(e) => {
              const v = e.target.value === "" ? null : Number(e.target.value);
              if (v !== project.fiscalYear) saveProjectField({ fiscalYear: v });
            }}
          />
          <p className="mt-1 text-xs text-gray-400">
            獎金歸在哪一年。編號裡的年度是建立年，已印在合約上，不隨這裡改動。
          </p>
        </div>
      </div>

      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
