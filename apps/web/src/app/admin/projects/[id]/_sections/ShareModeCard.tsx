"use client";

import { Card, inputCls, labelCls } from "@/components/admin-ui";
import type { ShareMode } from "@/lib/projects-api";
import type { ProjectDetail, UpdateProjectExtBody } from "@/lib/projects-ext-api";

interface ShareModeCardProps {
  project: ProjectDetail;
  /** 分潤改版 #6：分潤模式與獎金池只有老闆能改（看得到 ≠ 改得了）。 */
  canEditBonus: boolean;
  /** 看得到集團財務（access.profit）：獎金池總額屬集團財務，false＝欄位不畫。 */
  canSeeProfit: boolean;
  saveProjectField: (patch: UpdateProjectExtBody) => Promise<void>;
}

/**
 * 分潤模式與獎金池（原本在「專案設定」卡）。2026-10-27 起和各角色分潤趴數、成員分潤一起放在頁面最下方的
 * 「專案獎金與分潤」區；只有看得到分潤的人（access.bonus）才由 page.tsx 掛上。
 */
export function ShareModeCard({ project, canEditBonus, canSeeProfit, saveProjectField }: ShareModeCardProps) {
  const lockedTitle = canEditBonus ? undefined : "分潤比例僅老闆可修改";
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">分潤模式</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="project-share-mode">分潤模式</label>
          <select
            id="project-share-mode"
            className={inputCls}
            value={project.shareMode}
            disabled={!canEditBonus}
            title={lockedTitle}
            onChange={(e) => saveProjectField({ shareMode: e.target.value as ShareMode })}
          >
            <option value="pool_pct">獎金池 × 百分比</option>
            <option value="fixed_amount">直接填每人金額</option>
          </select>
        </div>
        {project.shareMode === "pool_pct" && canSeeProfit && (
          <div>
            <label className={labelCls} htmlFor="project-bonus-pool">獎金池總額</label>
            <input
              id="project-bonus-pool"
              className={inputCls}
              type="number"
              min="0"
              disabled={!canEditBonus}
              title={lockedTitle}
              defaultValue={project.bonusPool ?? ""}
              onBlur={(e) => {
                const v = e.target.value === "" ? null : Number(e.target.value);
                if (v !== project.bonusPool) saveProjectField({ bonusPool: v });
              }}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
