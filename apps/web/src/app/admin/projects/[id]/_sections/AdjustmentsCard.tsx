"use client";

import { Card, Empty } from "@/components/admin-ui";
import type { ShareAdjustment } from "@/lib/projects-api";
import { fmtMoney } from "./shared";

interface AdjustmentsCardProps {
  adjustments: ShareAdjustment[];
}

/** 分潤異動紀錄（唯讀）。 */
export function AdjustmentsCard({ adjustments }: AdjustmentsCardProps) {
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">分潤異動紀錄</h2>
      {adjustments.length === 0 ? (
        <Empty>尚無異動</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-2 pr-3">時間</th>
                <th className="py-2 pr-3">對象</th>
                <th className="py-2 pr-3">項目</th>
                <th className="py-2 pr-3">變更</th>
                <th className="py-2 pr-3">原因</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 text-gray-500">{new Date(a.createdAt).toLocaleString("zh-TW")}</td>
                  <td className="py-2 pr-3 text-gray-700">{a.name ?? (a.field === "pool" ? "獎金池" : "—")}</td>
                  <td className="py-2 pr-3 text-gray-600">{a.field === "pct" ? "百分比" : a.field === "amount" ? "金額" : "獎金池"}</td>
                  <td className="py-2 pr-3 text-gray-700">{fmtMoney(a.oldValue)} → {fmtMoney(a.newValue)}</td>
                  <td className="py-2 pr-3 text-gray-500">{a.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
