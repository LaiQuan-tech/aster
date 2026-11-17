"use client";

import { useEffect, useState } from "react";
import { getIncompleteSalaries, type IncompleteSalaryEntry } from "@/lib/admin-api";
import { incompleteSalarySummary, salarySettingsHref } from "@/lib/salary-completeness";

/**
 * 「薪資設定不完整」提示（2026-11-17）：員工列表（可展開名單）與月結發薪頁（執行薪資前，預設展開）共用。
 * 只給 HR／平台管理員／會計（呼叫端判斷角色；API 也是 requireFinance，其他角色 403 → 不顯示）。
 * 會計看得到名單但進不了員工「薪資」分頁 → `linkable=false` 只顯示姓名。
 * 名單為空、讀取失敗 → 什麼都不畫（提示不該擋主畫面）。
 */
export function IncompleteSalaryNotice({
  variant,
  reloadKey = 0,
  period,
  linkable = true,
}: {
  /** employees＝員工列表（收合）；payroll＝執行薪資前提醒（展開）。 */
  variant: "employees" | "payroll";
  reloadKey?: number;
  /** 薪資月份（YYYY-MM）：只列該月仍在職的人；省略＝當月。 */
  period?: string;
  /** 名字連到員工「薪資」分頁（只有 HR／平台管理員進得去）。 */
  linkable?: boolean;
}) {
  const [rows, setRows] = useState<IncompleteSalaryEntry[] | null>(null);
  const [open, setOpen] = useState(variant === "payroll");

  useEffect(() => {
    let active = true;
    getIncompleteSalaries(period)
      .then((r) => {
        if (active) setRows(r.employees);
      })
      .catch(() => {
        if (active) setRows(null);
      });
    return () => {
      active = false;
    };
  }, [reloadKey, period]);

  if (!rows || rows.length === 0) return null;
  const summary = incompleteSalarySummary(rows, variant);

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status" data-testid={`incomplete-salary-${variant}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-words">{summary}</span>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-900 underline hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起名單" : `查看名單（${rows.length}）`}
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1" data-testid="incomplete-salary-list">
          {rows.map((r) => (
            <li key={r.employeeId} className="flex flex-wrap items-center gap-x-2">
              {linkable ? (
                <a href={salarySettingsHref(r.employeeId)} className="font-medium underline hover:text-amber-700">
                  {r.empNo ? `${r.empNo} · ${r.name}` : r.name}
                </a>
              ) : (
                <span className="font-medium">{r.empNo ? `${r.empNo} · ${r.name}` : r.name}</span>
              )}
              <span className="text-xs text-amber-800">
                {r.label}
                {r.skippedByPayroll ? "（執行薪資時會被跳過）" : "（本俸會算成 0）"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
