"use client";

import { Card } from "@/components/admin-ui";
import type { ProjectMoney } from "@/lib/projects-ext-api";
import { fmtMoney } from "./shared";

interface MoneyCardProps {
  money: ProjectMoney;
}

/** 金額（模組五）：未稅／稅／含稅／未收與請款、收款進度。純顯示，finance 權限才由 page.tsx 掛上。 */
export function MoneyCard({ money }: MoneyCardProps) {
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-gray-700">金額</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-gray-500">
            未稅金額
            {money.amountSource && (
              <span className="ml-1 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500">
                {money.amountSource === "contract" ? "合約" : "報價單"}
              </span>
            )}
          </p>
          <p className="text-lg font-semibold text-gray-900">{fmtMoney(money.amountUntaxed)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">營業稅</p>
          <p className="text-lg font-semibold text-gray-900">{fmtMoney(money.taxAmount)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">含稅總額</p>
          <p className="text-lg font-semibold text-gray-900">{fmtMoney(money.amountTotal)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">未收</p>
          <p className="text-lg font-semibold text-red-600">{fmtMoney(money.unreceived)}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        <div><p className="text-xs text-gray-500">已請款</p><p className="font-medium text-gray-800">{fmtMoney(money.billedTotal)}</p></div>
        <div><p className="text-xs text-gray-500">已開票</p><p className="font-medium text-gray-800">{fmtMoney(money.invoicedTotal)}</p></div>
        <div><p className="text-xs text-gray-500">已入帳</p><p className="font-medium text-gray-800">{fmtMoney(money.receivedTotal)}</p></div>
      </div>
      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
            <span>請款進度</span><span>{money.billingProgressPct ?? "—"}{money.billingProgressPct != null && "%"}</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100">
            <div className="h-2 rounded-full bg-blue-400" style={{ width: `${Math.max(0, Math.min(100, money.billingProgressPct ?? 0))}%` }} />
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
            <span>收款進度</span><span>{money.receiptProgressPct ?? "—"}{money.receiptProgressPct != null && "%"}</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100">
            <div className="h-2 rounded-full bg-green-400" style={{ width: `${Math.max(0, Math.min(100, money.receiptProgressPct ?? 0))}%` }} />
          </div>
        </div>
      </div>
    </Card>
  );
}
