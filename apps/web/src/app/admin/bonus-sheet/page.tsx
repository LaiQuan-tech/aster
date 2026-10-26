"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import type { ApiError } from "@/lib/api-client";
import {
  downloadBonusSheetXlsx,
  getBonusSheet,
  runOptionLabel,
  RUN_STATUS_LABEL,
  type BonusSheetResult,
  type BonusSheetSelection,
} from "@/lib/bonus-sheet-api";
import { gridGeometry } from "@/lib/statement-layout";
import { BonusSheetTable, bonusSheetPrintCss } from "./_components";

/**
 * 獎金分潤總表（2026-10-27 業主）：版面同公司現行 Excel「專案獎金總表」（未結案／已結案兩張表），
 * 讓老闆一眼對得上原本的表。「本次」欄依所選的獎金批次（預設最新一般批次）或基準日即時試算。
 * 只開放給看得到集團財務的人（老闆／platform_admin／授權 HR）；API 403 時顯示說明。
 */

function errorText(err: unknown): string {
  const e = err as ApiError | undefined;
  if (e?.status === 403) return "獎金分潤總表只開放給老闆與被授權的人員，這個帳號沒有權限。";
  if (e?.status === 404) return "找不到這個獎金批次（可能已刪除），請改選其他批次。";
  return err instanceof Error ? err.message : "載入失敗";
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const ZOOMS = [1, 0.85, 0.7, 0.55];

export default function BonusSheetPage() {
  const [sel, setSel] = useState<BonusSheetSelection>({ mode: "run", runId: null });
  const [data, setData] = useState<BonusSheetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [zoom, setZoom] = useState(1);
  const [paper, setPaper] = useState<"A3" | "A4">("A3");
  const [printing, setPrinting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await getBonusSheet(sel);
      if (mine === seq.current) setData(r);
    } catch (err) {
      if (mine === seq.current) {
        // 換了批次／基準日卻載入失敗：不留上一份資料，免得表格與選單對不起來。
        setData(null);
        setError(errorText(err));
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [sel]);

  useEffect(() => {
    void load();
  }, [load]);

  const grid = data ? (tab === "open" ? data.sheets.open : data.sheets.closed) : null;
  const tableWidth = useMemo(() => (grid ? gridGeometry(grid).width : 0), [grid]);

  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    const t = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [printing]);

  const sourceValue = sel.mode === "asOf" ? "__asof" : (sel.runId ?? "");
  const onSource = (v: string) => {
    if (v === "__asof") setSel({ mode: "asOf", asOf: data?.asOf && sel.mode === "asOf" ? sel.asOf : todayLocal() });
    else setSel({ mode: "run", runId: v || null });
  };

  const download = async () => {
    if (!data) return;
    setDownloading(true);
    try {
      await downloadBonusSheetXlsx(sel, data.asOf);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 只在按「列印」時掛列印樣式：平常用瀏覽器列印就印整頁，不會印出空白頁。 */}
      {grid && printing && <style>{bonusSheetPrintCss(paper, tableWidth)}</style>}
      <Card className="no-print">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-72">
            <label className={labelCls} htmlFor="bonus-sheet-source">本次（獎金批次）</label>
            <select id="bonus-sheet-source" className={inputCls} value={sourceValue} onChange={(e) => onSource(e.target.value)}>
              <option value="">最新批次（預設）</option>
              {(data?.runs ?? []).map((r) => (
                <option key={r.id} value={r.id}>{runOptionLabel(r)}</option>
              ))}
              <option value="__asof">依基準日即時試算…</option>
            </select>
          </div>
          {sel.mode === "asOf" && (
            <div>
              <label className={labelCls} htmlFor="bonus-sheet-asof">基準日</label>
              <input
                id="bonus-sheet-asof"
                type="date"
                className={inputCls}
                value={sel.asOf}
                onChange={(e) => e.target.value && setSel({ mode: "asOf", asOf: e.target.value })}
              />
            </div>
          )}
          <div>
            <label className={labelCls} htmlFor="bonus-sheet-zoom">縮放</label>
            <select id="bonus-sheet-zoom" className={inputCls} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
              {ZOOMS.map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
            </select>
          </div>
          <div className="ml-auto flex flex-wrap items-end gap-2">
            <select aria-label="列印紙張" className={inputCls} value={paper} onChange={(e) => setPaper(e.target.value as "A3" | "A4")}>
              <option value="A3">A3 橫式</option>
              <option value="A4">A4 橫式</option>
            </select>
            <Button onClick={() => setPrinting(true)} disabled={!grid}>列印</Button>
            <PrimaryButton onClick={download} disabled={!data || downloading}>{downloading ? "下載中…" : "下載 Excel"}</PrimaryButton>
          </div>
        </div>
        {data && (
          <p className="mt-3 text-xs text-gray-500">
            {data.source === "run" && data.run
              ? `本次＝獎金批次 ${data.run.label}（基準日 ${data.run.asOf}，${RUN_STATUS_LABEL[data.run.status] ?? data.run.status}）。`
              : data.source === "preview"
                ? `本次＝依 ${data.asOf} 即時試算（不寫入，尚未建立批次）。`
                : "目前沒有可顯示的資料。"}
            含稅＝系統未稅金額 ×（1＋營業稅 {Math.round(data.vatRate * 1000) / 10}%）；已收款＝上一個已發放批次時的累計入帳，本次請款＝之後到基準日的入帳；
            本次獎金與總獎金依系統獎金規則（毛利制：毛利 × 獎金比例）。
          </p>
        )}
        {data && data.warnings.length > 0 && (
          <ul className="mt-2 list-disc rounded bg-amber-50 px-6 py-2 text-xs text-amber-800">
            {data.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
        {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
      </Card>

      {data && (
        <div className="no-print flex gap-2" role="tablist" aria-label="工作表">
          {(["open", "closed"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`rounded-t border px-4 py-1.5 text-sm ${tab === k ? "border-b-white bg-white font-semibold text-gray-900" : "bg-gray-50 text-gray-500 hover:text-gray-800"}`}
            >
              {k === "open" ? "未結案" : "已結案"}（{data.counts[k]}）
            </button>
          ))}
        </div>
      )}

      {loading && !data && <p className="text-sm text-gray-500">載入中…</p>}
      {grid && (
        <div className={loading ? "opacity-60" : undefined}>
          <BonusSheetTable grid={grid} zoom={zoom} printing={printing} />
        </div>
      )}
    </div>
  );
}
