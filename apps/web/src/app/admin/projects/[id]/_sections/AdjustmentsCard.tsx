"use client";

import { Card, Empty } from "@/components/admin-ui";
import type { ShareAdjustment } from "@/lib/projects-api";
import { fmtMoney } from "./shared";

interface AdjustmentsCardProps {
  adjustments: ShareAdjustment[];
}

/** 分潤異動紀錄（唯讀）。 */
export function AdjustmentsCard({ adjustments }: AdjustmentsCardProps) {
  const groups = adjustments.reduce<Array<{ key: string; items: ShareAdjustment[] }>>((result, adjustment) => {
    const key = adjustment.changeSetId ?? `legacy:${adjustment.id}`;
    const existing = result.find((group) => group.key === key);
    if (existing) existing.items.push(adjustment);
    else result.push({ key, items: [adjustment] });
    return result;
  }, []);

  function fieldLabel(field: string): string {
    return ({ pct: "成員比例", amount: "固定金額", pool: "獎金池", bonus_rate: "獎金比例", role: "專案角色", member_added: "加入成員", member_removed: "移除成員" } as Record<string, string>)[field] ?? field;
  }

  function valueText(value: number | string | null): string {
    if (value == null || value === "") return "—";
    return typeof value === "number" ? fmtMoney(value) : value;
  }

  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">分潤版本歷程</h2>
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
                {items.map((item) => <tr key={item.id} className="border-b last:border-0"><td className="px-3 py-2 text-gray-700">{item.name ?? (item.employeeId ? item.employeeId : "專案")}</td><td className="px-3 py-2 text-gray-600">{fieldLabel(item.field)}</td><td className="px-3 py-2 text-gray-500">{valueText(item.oldValue)}</td><td className="px-3 py-2 font-medium text-gray-800">{valueText(item.newValue)}</td></tr>)}
              </tbody></table></div>
            </section>;
          })}
        </div>
      )}
    </Card>
  );
}
