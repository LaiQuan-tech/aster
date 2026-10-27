"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import type { ApiError } from "@/lib/api-client";
import {
  downloadBonusSheetXlsx,
  getBonusManage,
  getBonusSheet,
  getProjectPayouts,
  readBonusSheetView,
  writeBonusSheetView,
  type BonusManageResult,
  type BonusSheetView,
  rowProjectMap,
  runOptionLabel,
  RUN_STATUS_LABEL,
  type BonusSheetResult,
  type BonusSheetSelection,
} from "@/lib/bonus-sheet-api";
import { gridGeometry } from "@/lib/statement-layout";
import { resolveFit, useContainerWidth, useFitMode } from "@/components/FitToWidth";
import { compactOpenSheet, readShowAllMembers, writeShowAllMembers } from "@/lib/bonus-sheet-columns";
import { webThemeGrid } from "@/lib/bonus-sheet-theme";
import { ManageTable } from "./_manage";
import { BonusSheetTable, ProjectPayoutDetail, bonusSheetPrintCss, type BonusSheetExpandable, type PayoutsState } from "./_components";

/**
 * 獎金分潤總表（2026-10-27 業主）。兩種檢視：
 *   • 管理檢視（預設）：一列一案，獎金總額／已發放／未發放（可發／待收款）、成員已發未發，依今天即時計算（GET /bonus-sheet/manage）。
 *   • 公司格式：版面同公司現行 Excel「專案獎金總表」（未結案／已結案兩張表），「本次」欄依所選的獎金批次
 *     （預設最新一般批次）或基準日即時試算。列印與下載 Excel 一律是公司格式（行政申報用）。
 * 兩種檢視都能點專案展開歷次發放明細與分潤調整（展開時才載）。
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

/** 手動倍率；另有「符合寬度」（預設，記住選擇，見 components/FitToWidth.tsx）。 */
const ZOOMS = [1, 0.85, 0.7, 0.55];

export default function BonusSheetPage() {
  const [sel, setSel] = useState<BonusSheetSelection>({ mode: "run", runId: null });
  const [data, setData] = useState<BonusSheetResult | null>(null);
  const [loading, setLoading] = useState(false);
  /** 檢視：管理檢視（預設）／公司格式；記住選擇。 */
  const [view, setView] = useState<BonusSheetView>("manage");
  const [manage, setManage] = useState<BonusManageResult | null>(null);
  const [manageLoading, setManageLoading] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const loadedFor = useRef<BonusSheetSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [manualZoom, setManualZoom] = useState(1);
  const [fitMode, setFitMode] = useFitMode();
  const [sheetWrapRef, sheetWrapPx] = useContainerWidth<HTMLDivElement>();
  const [paper, setPaper] = useState<"A3" | "A4">("A4");
  const [printing, setPrinting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  /** 未結案顯示全部成員欄（預設精簡：只經理、組員1、組員2；記住選擇）。 */
  const [showAllMembers, setShowAllMembers] = useState(false);
  /** 點開的專案（發放歷程）：預設收合、可同時展開多個；明細展開時才載（快取到離開頁面）。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [payouts, setPayouts] = useState<Record<string, PayoutsState>>({});
  const seq = useRef(0);

  useEffect(() => {
    setShowAllMembers(readShowAllMembers());
    setView(readBonusSheetView());
  }, []);
  const changeView = (v: BonusSheetView) => {
    setView(v);
    writeBonusSheetView(v);
  };
  const toggleShowAll = (value: boolean) => {
    setShowAllMembers(value);
    writeShowAllMembers(value);
  };

  const load = useCallback(async () => {
    const mine = ++seq.current;
    loadedFor.current = sel;
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

  // 公司格式只在切到該檢視、或要列印時才載（管理檢視不需要它）。
  const needCompany = view === "company" || printing;
  useEffect(() => {
    if (!needCompany || loadedFor.current === sel) return;
    void load();
  }, [load, needCompany, sel]);

  const loadManage = useCallback(async () => {
    setManageLoading(true);
    setManageError(null);
    try {
      setManage(await getBonusManage());
    } catch (err) {
      setManage(null);
      setManageError(errorText(err));
    } finally {
      setManageLoading(false);
    }
  }, []);
  useEffect(() => {
    if (view === "manage" && !manage && !manageLoading && !manageError) void loadManage();
  }, [view, manage, manageLoading, manageError, loadManage]);

  const loadPayouts = useCallback(async (projectId: string) => {
    setPayouts((m) => ({ ...m, [projectId]: { status: "loading" } }));
    try {
      const r = await getProjectPayouts(projectId);
      setPayouts((m) => ({ ...m, [projectId]: { status: "ok", data: r } }));
    } catch (err) {
      const e = err as ApiError | undefined;
      const message = e?.status === 403 ? "沒有權限查看發放明細。" : e?.status === 404 ? "找不到這個專案。" : err instanceof Error ? err.message : "載入失敗";
      setPayouts((m) => ({ ...m, [projectId]: { status: "error", message } }));
    }
  }, []);

  const toggleProject = useCallback(
    (projectId: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        return next;
      });
      const st = payouts[projectId];
      if (!st || st.status === "error") void loadPayouts(projectId);
    },
    [payouts, loadPayouts],
  );

  const fullGrid = data ? (tab === "open" ? data.sheets.open : data.sheets.closed) : null;
  const manageRows = manage ? manage.rows[tab] : null;
  const counts = view === "manage" ? manage?.counts : data?.counts;
  const renderDetail = (projectId: string) => <ProjectPayoutDetail state={payouts[projectId]} onRetry={() => void loadPayouts(projectId)} />;
  // 精簡檢視只在畫面上：列印（printing）一律畫完整格線；Excel 由 API 產生，本來就是完整版。
  const themed = useMemo(() => {
    if (!fullGrid) return null;
    return webThemeGrid(tab === "open" && !showAllMembers && !printing ? compactOpenSheet(fullGrid) : fullGrid);
  }, [fullGrid, tab, showAllMembers, printing]);
  // 畫面／列印用後台風格的格線（抬頭拿出來畫卡片標題）；Excel 由 API 產生，維持原格式。
  const grid = themed?.grid ?? null;
  const rowProject = useMemo(() => {
    const raw = rowProjectMap(data?.rowProjects?.[tab]);
    const out = new Map<number, string>();
    for (const [row, id] of raw) {
      const r = themed?.rowMap.get(row);
      if (r !== undefined) out.set(r, id);
    }
    return out;
  }, [data, tab, themed]);
  const expandedHere = useMemo(() => {
    const ids = view === "manage" ? (manageRows ?? []).map((r) => r.projectId) : [...rowProject.values()];
    return ids.filter((id) => expanded.has(id)).length;
  }, [view, manageRows, rowProject, expanded]);
  const tableWidth = useMemo(() => (grid ? gridGeometry(grid).width : 0), [grid]);
  // 後台風格的內容字級固定 13px（lib/bonus-sheet-theme.ts）。
  const baseFontPx = 13;
  // 符合寬度：縮到表格外框內寬（扣左右 1px 框線）；字太小時停在最小可讀倍率、改左右捲動。
  const fit = resolveFit("fit", Math.max(0, sheetWrapPx - 2), tableWidth, baseFontPx);
  const zoom = fitMode === "fit" ? fit.zoom : manualZoom;
  const zoomValue = fitMode === "fit" ? "fit" : String(manualZoom);
  function onZoom(value: string) {
    if (value === "fit") {
      setFitMode("fit");
      return;
    }
    setManualZoom(Number(value));
    setFitMode("actual");
  }

  useEffect(() => {
    // 管理檢視按列印：等公司格式載好、畫出來再印。
    if (!printing || !grid) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    const t = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [printing, grid]);

  const sourceValue = sel.mode === "asOf" ? "__asof" : (sel.runId ?? "");
  const onSource = (v: string) => {
    if (v === "__asof") setSel({ mode: "asOf", asOf: data?.asOf && sel.mode === "asOf" ? sel.asOf : todayLocal() });
    else setSel({ mode: "run", runId: v || null });
  };

  const download = async () => {
    const asOf = view === "company" ? data?.asOf : (manage?.asOf ?? todayLocal());
    if (!asOf) return;
    setDownloading(true);
    try {
      await downloadBonusSheetXlsx(sel, asOf);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDownloading(false);
    }
  };

  const showCompany = view === "company" || printing;
  const viewBtn = (v: BonusSheetView, label: string) => (
    <button
      type="button"
      aria-pressed={view === v}
      onClick={() => changeView(v)}
      className={`px-3 py-1.5 text-sm ${view === v ? "bg-gray-900 font-semibold text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* 只在按「列印」時掛列印樣式：平常用瀏覽器列印就印整頁，不會印出空白頁。 */}
      {grid && printing && <style>{bonusSheetPrintCss(paper, tableWidth)}</style>}
      <Card className="no-print">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <span className={labelCls}>檢視</span>
            <div className="inline-flex overflow-hidden rounded border border-gray-300" role="group" aria-label="檢視">
              {viewBtn("manage", "管理檢視")}
              {viewBtn("company", "公司格式")}
            </div>
          </div>
          {view === "company" && (
            <>
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
                <select id="bonus-sheet-zoom" className={inputCls} value={zoomValue} onChange={(e) => onZoom(e.target.value)}>
                  <option value="fit">符合寬度{fitMode === "fit" && fit.overflow ? `（${Math.round(fit.zoom * 100)}%）` : ""}</option>
                  {ZOOMS.map((z) => <option key={z} value={String(z)}>{z === 1 ? "實際大小（100%）" : `${Math.round(z * 100)}%`}</option>)}
                </select>
              </div>
            </>
          )}
          {view === "manage" && (
            <Button onClick={() => void loadManage()} disabled={manageLoading}>{manageLoading ? "計算中…" : "重新計算"}</Button>
          )}
          <div className="ml-auto flex flex-wrap items-end gap-2">
            {view === "company" && tab === "open" && (
              <label className="flex min-h-10 items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={showAllMembers} onChange={(e) => toggleShowAll(e.target.checked)} />
                顯示全部成員欄
              </label>
            )}
            <select aria-label="列印紙張" className={inputCls} value={paper} onChange={(e) => setPaper(e.target.value as "A3" | "A4")}>
              <option value="A3">A3 橫式</option>
              <option value="A4">A4 橫式</option>
            </select>
            <Button onClick={() => setPrinting(true)} disabled={view === "company" ? !grid : printing}>
              {view === "manage" ? "列印（公司格式）" : "列印"}
            </Button>
            <PrimaryButton onClick={download} disabled={(view === "company" && !data) || downloading}>
              {downloading ? "下載中…" : view === "manage" ? "下載 Excel（公司格式）" : "下載 Excel"}
            </PrimaryButton>
          </div>
        </div>
        {view === "company" && grid && fitMode === "fit" && fit.clamped && (
          <p className="mt-3 text-xs text-amber-700" aria-live="polite">
            表格欄位多，已縮到最小可讀字級（{Math.round(fit.zoom * 100)}%）仍比畫面寬，可左右捲動查看。
          </p>
        )}
        {view === "manage" && manage && (
          <p className="mt-3 text-xs text-gray-500">
            依 {manage.asOf} 即時計算。含稅＝未稅 ×（1＋營業稅 {Math.round(manage.vatRate * 1000) / 10}%）；獎金總額＝含稅合約 × 獎金比例（全部收齊總共要發多少；
            舊制＝手填獎金池、固定金額＝設定金額合計、毛利制＝目前已實現毛利 × 比例，完工前會變動）。已發放＝已發放批次合計（含沖銷），已核准但還沒發的另外標示、不算已發放。
            未發放＝獎金總額 − 已發放：可發＝依目前收款各成員累計應得 − 已發（下一批會發的錢），待收款＝其餘（含尚未分配的比例）。列印與 Excel 是公司格式。
          </p>
        )}
        {view === "company" && data && (
          <p className="mt-3 text-xs text-gray-500">
            {data.source === "run" && data.run
              ? `本次＝獎金批次 ${data.run.label}（基準日 ${data.run.asOf}，${RUN_STATUS_LABEL[data.run.status] ?? data.run.status}）。`
              : data.source === "preview"
                ? `本次＝依 ${data.asOf} 即時試算（不寫入，尚未建立批次）。`
                : "目前沒有可顯示的資料。"}
            含稅＝系統未稅金額 ×（1＋營業稅 {Math.round(data.vatRate * 1000) / 10}%）；已收款＝上一個已發放批次時的累計入帳，本次請款＝之後到基準日的入帳；
            總獎金＝含稅 × 獎金比例；本次獎金＝所選批次（或試算）的金額。成員與尚未分配格：上行 %、下行金額——本期有發的列是本次金額，
            「累」＝累計應得（不在本期的列；尚未分配一律是累計）。期別寫在表頭標題區「本期：…」。備註最後列出專案進行中的分潤調整。
          </p>
        )}
        {(view === "manage" ? manage?.warnings : data?.warnings)?.length ? (
          <ul className="mt-2 list-disc rounded bg-amber-50 px-6 py-2 text-xs text-amber-800">
            {(view === "manage" ? manage!.warnings : data!.warnings).map((w) => <li key={w}>{w}</li>)}
          </ul>
        ) : null}
        {view === "manage" && manageError && <div className="mt-3"><ErrorText>{manageError}</ErrorText></div>}
        {error && (view === "company" || printing) && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
      </Card>

      {counts && (
        <div className="no-print flex gap-2" role="tablist" aria-label="工作表">
          {(["open", "closed"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={`rounded-t border px-4 py-1.5 text-sm ${tab === k ? "border-b-white bg-white font-semibold text-gray-900" : "bg-gray-50 text-gray-500 hover:text-gray-800"}`}
            >
              {k === "open" ? "未結案" : "已結案"}（{counts[k]}）
            </button>
          ))}
          <span className="ml-auto self-center text-xs text-gray-500">
            {view === "manage" ? "點專案名稱展開歷次發放明細與分潤調整" : "點專案列（或序號旁 ▸）展開每一次的獎金發放明細"}
          </span>
          {expandedHere > 0 && (
            <Button onClick={() => setExpanded(new Set())}>全部收合（{expandedHere}）</Button>
          )}
        </div>
      )}

      {view === "manage" && !printing && (
        <>
          {manageLoading && !manage && <p className="text-sm text-gray-500">計算中…</p>}
          {manage && manageRows && (
            <div className={manageLoading ? "no-print opacity-60" : "no-print"}>
              <ManageTable rows={manageRows} totals={manage.totals[tab]} expanded={expanded} onToggle={toggleProject} renderDetail={renderDetail} />
            </div>
          )}
        </>
      )}

      {showCompany && loading && !data && <p className="text-sm text-gray-500">載入中…</p>}
      {showCompany && grid && (
        <div ref={sheetWrapRef} className={loading ? "opacity-60" : undefined}>
          <BonusSheetTable
            grid={grid}
            zoom={zoom}
            printing={printing}
            title={themed?.title}
            warnColumns={themed?.warnColumns}
            expandable={
              printing || rowProject.size === 0
                ? undefined
                : ({
                    rowProject,
                    expanded,
                    onToggle: toggleProject,
                    viewportWidth: Math.max(0, sheetWrapPx - 2),
                    renderDetail,
                  } satisfies BonusSheetExpandable)
            }
          />
        </div>
      )}
    </div>
  );
}
