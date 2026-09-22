"use client";

import { useMemo } from "react";
import { diffConfigs, type RuleConfigVersionFull } from "@/lib/rule-config-api";

/**
 * 規則兩版比對（M9 歷史版本檢視）。
 *
 * 客戶原本要的是「保留舊版 UI 好回頭看以前怎麼設定」；業主拍板不做第二套畫面，
 * 改成「看得到每一版的內容、兩版差在哪」。這裡把兩版的規則 DSL 攤平成
 * `路徑 → 值`（lib/rule-config-api.ts 的 flattenConfig），只列不一樣的路徑——
 * 整包 JSON 並排給人看等於沒給，真正有用的是「這次改動動到哪幾個鍵」。
 */

const KIND_META: Record<"changed" | "added" | "removed", { label: string; cls: string }> = {
  changed: { label: "已修改", cls: "bg-amber-50 text-amber-700" },
  added: { label: "新增", cls: "bg-green-50 text-green-700" },
  removed: { label: "移除", cls: "bg-red-50 text-red-700" },
};

function Value({ value }: { value: string | null }) {
  if (value === null) return <span className="text-xs text-gray-300">（無此設定）</span>;
  return <span className="font-mono text-xs break-all text-gray-800">{value}</span>;
}

export function RuleConfigDiff({ base, target }: { base: RuleConfigVersionFull; target: RuleConfigVersionFull }) {
  const diff = useMemo(() => diffConfigs(base.config, target.config), [base, target]);

  if (base.version === target.version) {
    return <p className="text-sm text-gray-500">請選兩個不同的版本才能比對。</p>;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span>
          基準 v{base.version}（{base.effectiveFrom ? `生效 ${base.effectiveFrom}` : "系統預設"}）→ 比較 v{target.version}（{target.effectiveFrom ? `生效 ${target.effectiveFrom}` : "系統預設"}）
        </span>
        {(!base.configValid || !target.configValid) && (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700" title="該版內容已不合目前的規則格式（欄位改過），仍照原樣列出供查閱">
            含舊格式版本
          </span>
        )}
      </div>

      {diff.rows.length === 0 ? (
        <p className="text-sm text-gray-500">兩版內容完全相同（{diff.sameCount} 個設定項）。</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-100">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500">
                  <th className="py-1.5 pl-3">設定項</th>
                  <th className="py-1.5">v{base.version}</th>
                  <th className="py-1.5">v{target.version}</th>
                  <th className="py-1.5 pr-3">狀態</th>
                </tr>
              </thead>
              <tbody>
                {diff.rows.map((row) => (
                  <tr key={row.path} className="border-t border-gray-50 align-top">
                    <td className="py-1.5 pl-3 font-mono text-xs break-all text-gray-600">{row.path}</td>
                    <td className="py-1.5 pr-3">
                      <Value value={row.a} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <Value value={row.b} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${KIND_META[row.kind].cls}`}>{KIND_META[row.kind].label}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            共 {diff.rows.length} 項差異，其餘 {diff.sameCount} 項相同。
          </p>
        </>
      )}
    </div>
  );
}
