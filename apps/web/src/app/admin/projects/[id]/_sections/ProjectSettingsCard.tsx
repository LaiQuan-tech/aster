"use client";

import { Card, ErrorText, inputCls, labelCls } from "@/components/admin-ui";
import type { Department, Employee } from "@/lib/admin-api";
import type { ShareMode } from "@/lib/projects-api";
import type { ProjectDetail, UpdateProjectExtBody } from "@/lib/projects-ext-api";

interface ProjectSettingsCardProps {
  project: ProjectDetail;
  depts: Department[];
  emps: Employee[];
  isPool: boolean;
  saveProjectField: (patch: UpdateProjectExtBody) => Promise<void>;
  error: string | null;
}

/** 專案設定（部門／負責人／分潤模式／年度／起迄日）。欄位即存，走 page.tsx 的 saveProjectField。 */
export function ProjectSettingsCard({ project, depts, emps, isPool, saveProjectField, error }: ProjectSettingsCardProps) {
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">專案設定</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            onChange={(e) => saveProjectField({ shareMode: e.target.value as ShareMode })}
          >
            <option value="pool_pct">獎金池 × 百分比</option>
            <option value="fixed_amount">直接填每人金額</option>
          </select>
        </div>
        {isPool && (
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
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
