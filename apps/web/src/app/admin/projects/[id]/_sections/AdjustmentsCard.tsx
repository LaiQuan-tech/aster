"use client";

import { Empty } from "@/components/admin-ui";
import { CollapsibleCard } from "@/components/CollapsibleCard";
import type { ShareAdjustment } from "@/lib/projects-api";
import { fmtMoney } from "./shared";

interface AdjustmentsCardProps {
  adjustments: ShareAdjustment[];
}

/** 分潤版本歷程（唯讀）。2026-10-27 起放在「獎金分潤」卡下方、預設收起，只給看得到分潤的人（page.tsx 判斷）。 */
export function AdjustmentsCard({ adjustments }: AdjustmentsCardProps) {
  const groups = adjustments.reduce<Array<{ key: string; items: ShareAdjustment[] }>>((result, adjustment) => {
    const key = adjustment.changeSetId ?? `legacy:${adjustment.id}`;
    const existing = result.find((group) => group.key === key);
    if (existing) existing.items.push(adjustment);
    else result.push({ key, items: [adjustment] });
    return result;
  }, []);

  function fieldLabel(field: string): string {
    return ({ pct: "成員比例", amount: "固定金額", pool: "獎金池", bonus_rate: "獎金比例", role: "專案角色", member_add: "加入成員", member_remove: "移除成員", share_mode: "分潤模式" } as Record<string, string>)[field] ?? field;
  }

  function valueText(value: number | string | null): string {
    if (value == null || value === "") return "—";
    return typeof value === "number" ? fmtMoney(value) : value;
  }

  function adjustmentValueText(field: string, value: number | string | null): string {
    if (field === "share_mode" && typeof value === "number") return ({ 1: "百分比", 2: "指定金額" } as Record<number, string>)[value] ?? String(value);
    if (field === "role" && typeof value === "number") return ({ 1: "經理", 2: "主辦", 3: "組員", 4: "支援" } as Record<number, string>)[value] ?? String(value);
    if ((field === "pct" || field === "bonus_rate" || field === "member_add" || field === "member_remove") && typeof value === "number") return `${value}%`;
    return valueText(value);
  }

  return (
    <CollapsibleCard title={`分潤版本歷程（${groups.length}）`} hint="每次儲存分潤留一個版本：誰、何時、原因、改了什麼。">
      {groups.length === 0 ? (
        <Empty>尚無異動</Empty>
      ) : (
        <div className="space-y-3">
          {groups.map(({ key, items }) => {
            const head = items[0];
            return <section key={key} className="rounded-lg border border-gray-200">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-gray-50 px-3 py-2 text-xs">
                <div><span className="font-semibold text-gray-800">{head.reason ?? "舊版單筆調整"}</span><span className="ml-2 text-gray-500">{new Date(head.createdAt).toLocaleString("zh-TW")}</span></div>
                <span className="text-gray-500">操作者：{head.changedByName ?? "—"}{head.changeSetId ? ` · ${items.length} 項變更` : " · 舊版紀錄"}</span>
              </div>
              <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-xs text-gray-500"><th className="px-3 py-2">對象</th><th className="px-3 py-2">項目</th><th className="px-3 py-2">調整前</th><th className="px-3 py-2">調整後</th></tr></thead><tbody>
                {items.map((item) => <tr key={item.id} className="border-b last:border-0"><td className="px-3 py-2 text-gray-700">{item.name ?? (item.employeeId ? item.employeeId : "專案")}</td><td className="px-3 py-2 text-gray-600">{fieldLabel(item.field)}</td><td className="px-3 py-2 text-gray-500">{adjustmentValueText(item.field, item.oldValue)}</td><td className="px-3 py-2 font-medium text-gray-800">{adjustmentValueText(item.field, item.newValue)}</td></tr>)}
              </tbody></table></div>
            </section>;
          })}
        </div>
      )}
    </CollapsibleCard>
  );
}
