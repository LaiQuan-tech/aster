"use client";

import { Fragment, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { GridCell, StatementGrid } from "@/lib/statements-api";
import { columnPx, coveredPositions, gridGeometry, gridRowCount, rowPx } from "@/lib/statement-layout";
import { cellTheme, THEME, type ThemedTitle } from "@/lib/bonus-sheet-theme";
import {
  MEMBER_ROLE_LABEL,
  moneyText,
  PAYOUT_ADJUSTMENT_LABEL,
  payoutDateText,
  payoutTimeline,
  RUN_STATUS_LABEL,
  stickyOffsets,
  type ProjectPayoutRun,
  type ProjectPayoutsResult,
  type ShareRevision,
} from "@/lib/bonus-sheet-api";

/**
/**
 * 專案獎金總表（公司格式）：照 API 的格線（StatementGrid）畫 HTML table——欄寬、列高、多列表頭與合併、千分位與 %
 * （API 已格式化）照原 Excel；配色與字體照後台風格（lib/bonus-sheet-theme.ts：無襯線、gray-200 細框、表頭 gray-50、
 * 本輪欄品牌色淡底、紅字只給警示）。抬頭（標誌＋公司名＋表名＋本期）由頁面拿出來畫成卡片標題（title）。
 * Excel 下載是 API 產生的原格式，不受這裡影響。
 *
 * 表很寬，表頭列與前幾欄用 position: sticky 固定（grid.freeze），橫向捲動時對得上是哪一案。sticky 在
 * border-collapse 下框線會掉，這裡用 border-collapse: separate，每格只畫右／下框線（外框在容器上）。
 * 表頭列放在 <thead>，列印時每頁重複。
 */

function cellStyle(cell: GridCell, header: boolean, warn: boolean, sticky: { top: number | null; left: number | null }): CSSProperties {
  const t = cellTheme(cell, { header, warn });
  const style: CSSProperties = {
    borderBottom: `1px solid ${THEME.border}`,
    borderRight: `1px solid ${THEME.border}`,
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    textAlign: t.textAlign,
    background: t.background,
    color: t.color,
    fontVariantNumeric: t.numeric ? "tabular-nums" : undefined,
    // 數字格只照明確換行（「40.0 %」／「累 8,000」兩行），不在空白處折行。
    whiteSpace: t.numeric ? "pre" : cell.wrap || header ? "pre-wrap" : "nowrap",
    overflow: "hidden",
    padding: "3px 6px",
    verticalAlign: "middle",
    lineHeight: 1.4,
  };
  if (sticky.top !== null || sticky.left !== null) {
    style.position = "sticky";
    if (sticky.top !== null) style.top = sticky.top;
    if (sticky.left !== null) style.left = sticky.left;
    style.zIndex = sticky.top !== null && sticky.left !== null ? 3 : sticky.top !== null ? 2 : 1;
  }
  return style;
}

/** 公司格式抬頭：ASTER 標誌＋公司名＋表名（＋本期），後台卡片標題樣式。 */
export function BonusSheetTitle({ title }: { title: ThemedTitle }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-200 px-3 py-2.5">
      {title.logo && (
        // eslint-disable-next-line @next/next/no-img-element -- 靜態 SVG 標誌，列印也要原尺寸
        <img src="/brand/aster-logo.svg" alt="ASTER" style={{ height: 20, width: "auto" }} />
      )}
      {title.texts.map((t, i) => (
        <h2 key={i} className={i === 0 ? "text-base font-semibold text-gray-800" : t.startsWith("本期") ? "text-sm font-medium text-[var(--brand)]" : "text-base font-semibold text-gray-800"}>
          {t}
        </h2>
      ))}
    </div>
  );
}

/**
 * 點開專案列看發放歷程（2026-10-27 業主）：只在畫面上；列印時頁面不傳（不畫展開鈕與明細），Excel 由 API 產生不受影響。
 */
export type BonusSheetExpandable = {
  /** 格線列號 → 專案 id。 */
  rowProject: ReadonlyMap<number, string>;
  expanded: ReadonlySet<string>;
  onToggle: (projectId: string) => void;
  renderDetail: (projectId: string) => ReactNode;
  /** 表格外框的可視寬度（px）：明細區塊固定在可視範圍內、不跟著表格左右捲動或縮放。 */
  viewportWidth: number;
};

export function BonusSheetTable({
  grid,
  zoom = 1,
  printing = false,
  expandable,
  title,
  warnColumns,
}: {
  grid: StatementGrid;
  zoom?: number;
  printing?: boolean;
  expandable?: BonusSheetExpandable;
  /** 抬頭（webThemeGrid().title）。 */
  title?: ThemedTitle | null;
  /** 「尚未分配」欄：不為 0 才紅字。 */
  warnColumns?: ReadonlySet<number>;
}) {
  const geometry = useMemo(() => gridGeometry(grid), [grid]);
  const covered = useMemo(() => coveredPositions(grid), [grid]);
  const offsets = useMemo(() => stickyOffsets(grid), [grid]);
  const byPos = useMemo(() => new Map<string, GridCell>(grid.cells.map((c) => [`${c.row}:${c.col}`, c])), [grid]);
  const rows = gridRowCount(grid);
  const headRows = grid.freeze?.rows ?? 0;
  const freezeCols = grid.freeze?.cols ?? 0;

  const projectOf = (r: number) => (r >= headRows ? expandable?.rowProject.get(r) : undefined);

  const onRowClick = (projectId: string) => (e: MouseEvent<HTMLTableRowElement>) => {
    // 選取文字（複製數字）時不要收合／展開；按鈕自己處理。
    if ((e.target as HTMLElement).closest("button")) return;
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
    expandable?.onToggle(projectId);
  };

  const renderRow = (r: number) => {
    const projectId = projectOf(r);
    const open = !!projectId && !!expandable?.expanded.has(projectId);
    return (
    <tr
      key={r}
      className={r >= headRows ? "bs-row" : undefined}
      style={{ height: rowPx(grid.rowHeights[r] ?? 20.9), cursor: projectId ? "pointer" : undefined }}
      onClick={projectId ? onRowClick(projectId) : undefined}
      title={projectId ? (open ? "收合發放明細" : "點一下展開這個專案每一次的獎金發放明細") : undefined}
    >
      {grid.columns.map((_, c) => {
        const key = `${r}:${c}`;
        if (covered.has(key)) return null;
        const cell = byPos.get(key);
        const stickyLeft = c + (cell?.colSpan ?? 1) <= freezeCols ? offsets.left[c] : null;
        const stickyTop = r < headRows ? offsets.top[r] : null;
        if (!cell) {
          const style: CSSProperties = { padding: 0, background: "#fff" };
          if (stickyTop !== null || stickyLeft !== null) Object.assign(style, { position: "sticky", top: stickyTop ?? undefined, left: stickyLeft ?? undefined, zIndex: 1 });
          return <td key={c} style={style} />;
        }
        const Tag = r < headRows ? "th" : "td";
        return (
          <Tag key={c} rowSpan={cell.rowSpan} colSpan={cell.colSpan} style={cellStyle(cell, r < headRows, !!warnColumns?.has(c), { top: stickyTop, left: stickyLeft })}>
            {projectId && c === 0 && (
              <button
                type="button"
                aria-expanded={open}
                aria-label={open ? `收合第 ${cell.text} 列的發放明細` : `展開第 ${cell.text} 列的發放明細`}
                onClick={() => expandable?.onToggle(projectId)}
                style={{ border: 0, background: "transparent", padding: 0, marginRight: 3, cursor: "pointer", color: THEME.brand, fontSize: "10px", lineHeight: 1 }}
              >
                {open ? "▾" : "▸"}
              </button>
            )}
            {cell.logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- 靜態 SVG 標誌（沒經過 webThemeGrid 的格線才會出現）
              <img src="/brand/aster-logo.svg" alt={cell.text} style={{ display: "block", height: 20, width: "auto", margin: "0 auto" }} />
            ) : (
              cell.text
            )}
            {cell.hint && (
              <span style={{ display: "block", fontSize: "11px", color: "#6B7280", whiteSpace: "nowrap", lineHeight: 1.3 }}>{cell.hint}</span>
            )}
          </Tag>
        );
      })}
    </tr>
    );
  };

  const renderDetailRow = (r: number) => {
    const projectId = projectOf(r);
    if (!projectId || !expandable?.expanded.has(projectId)) return null;
    const z = zoom > 0 ? zoom : 1;
    const width = Math.max(320, Math.min(expandable.viewportWidth, geometry.width * z));
    return (
      <tr key={`detail-${r}`} data-detail-for={projectId}>
        <td colSpan={grid.columns.length} style={{ padding: 0, background: "#F8FAFC", borderBottom: `1px solid ${THEME.border}` }}>
          {/* 抵銷表格縮放（zoom 1/z）＋sticky：明細固定在可視寬度內、維持正常字級。 */}
          <div style={{ position: "sticky", left: 0, width, zoom: 1 / z }}>{expandable.renderDetail(projectId)}</div>
        </td>
      </tr>
    );
  };

  return (
    <div className="bonus-sheet-print overflow-hidden rounded-lg border border-gray-300 bg-white" data-printing={printing ? "1" : "0"}>
      {/* 列 hover：整列淡灰（品牌淡底欄也一起變灰，方便對列）。 */}
      <style>{`.bonus-sheet-print tr.bs-row:hover > td { background-color: ${THEME.headerBg} !important; }`}</style>
      {title && <BonusSheetTitle title={title} />}
      <div className="bonus-sheet-scroll max-h-[75vh] overflow-auto">
      <table
        aria-label={grid.title}
        style={{
          tableLayout: "fixed",
          borderCollapse: "separate",
          borderSpacing: 0,
          width: geometry.width,
          zoom,
          background: "#fff",
          color: THEME.text,
          fontFamily: "inherit",
          ["--bonus-sheet-width" as string]: `${geometry.width}px`,
        }}
      >
        <colgroup>
          {grid.columns.map((w, i) => (
            <col key={i} style={{ width: columnPx(w) }} />
          ))}
        </colgroup>
        <thead>{Array.from({ length: Math.min(headRows, rows) }, (_, r) => renderRow(r))}</thead>
        <tbody>
          {Array.from({ length: Math.max(0, rows - headRows) }, (_, i) => (
            <Fragment key={i + headRows}>
              {renderRow(i + headRows)}
              {renderDetailRow(i + headRows)}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** 列印：只印目前這張表，橫式 A3／A4，表格縮到一頁寬；sticky 取消。 */
export function bonusSheetPrintCss(paper: "A3" | "A4", tableWidth: number): string {
  const printableMm = paper === "A3" ? 400 : 277; // 橫式寬扣 10mm 邊界
  const zoom = Math.min(1, ((printableMm / 25.4) * 96) / Math.max(1, tableWidth));
  return `
@media print {
  @page { size: ${paper} landscape; margin: 10mm; }
  body * { visibility: hidden !important; }
  .bonus-sheet-print[data-printing="1"], .bonus-sheet-print[data-printing="1"] * { visibility: visible !important; }
  .bonus-sheet-print[data-printing="1"] { position: absolute; left: 0; top: 0; max-height: none !important; overflow: visible !important; }
  .bonus-sheet-print[data-printing="1"] .bonus-sheet-scroll { max-height: none !important; overflow: visible !important; }
  .bonus-sheet-print[data-printing="1"] * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .bonus-sheet-print[data-printing="1"] table { zoom: ${zoom.toFixed(4)} !important; }
  .bonus-sheet-print[data-printing="1"] th, .bonus-sheet-print[data-printing="1"] td { position: static !important; }
  .bonus-sheet-print[data-printing="1"] thead { display: table-header-group; }
  .bonus-sheet-print[data-printing="1"] tr { break-inside: avoid; }
}
`;
}

/* ──────────────────────────────────────────────────────────────────
 * 展開的發放歷程
 * ────────────────────────────────────────────────────────────────── */

export type PayoutsState = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; data: ProjectPayoutsResult };

const STATUS_TONE: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  approved: "bg-sky-50 text-sky-700 ring-sky-200",
  pending_approval: "bg-amber-50 text-amber-700 ring-amber-200",
  draft: "bg-gray-50 text-gray-600 ring-gray-200",
};

function Badge({ children, tone }: { children: ReactNode; tone: string }) {
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ring-1 ring-inset ${tone}`}>{children}</span>;
}

function shareText(m: { shareMode: string; sharePct: number | null; shareAmount: number | null }): string {
  if (m.shareMode === "pool_pct") return m.sharePct === null ? "—" : `${m.sharePct}%`;
  return m.shareAmount === null ? "—" : `固定 ${moneyText(m.shareAmount)}`;
}

function RevisionEntry({ revision }: { revision: ShareRevision }) {
  return (
    <li className="rounded border-l-4 border-amber-400 bg-amber-50/60 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-gray-600">
        <span className="font-semibold text-amber-800">分潤調整</span>
        <span>{payoutDateText(revision.at)}</span>
        <span>操作者：{revision.changedByName ?? "—"}</span>
      </div>
      <ul className="mt-1 space-y-0.5 text-sm text-gray-800">
        {revision.items.map((item, i) => (
          <li key={i}>{item.text}</li>
        ))}
      </ul>
      {revision.reason && <p className="mt-1 text-xs text-gray-600">原因：{revision.reason}</p>}
    </li>
  );
}

function RunEntry({ run }: { run: ProjectPayoutRun }) {
  const reversal = run.kind === "reversal";
  return (
    <li className={`rounded border px-3 py-2 ${reversal ? "border-red-200 bg-red-50/40" : "border-gray-200 bg-white"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-semibold text-gray-900">{run.label}</span>
        <Badge tone={STATUS_TONE[run.status] ?? STATUS_TONE.draft}>{RUN_STATUS_LABEL[run.status] ?? run.status}</Badge>
        {reversal && <Badge tone="bg-red-50 text-red-700 ring-red-200">沖銷{run.reversesLabel ? `「${run.reversesLabel}」` : ""}</Badge>}
        {run.reversedByStatus && (
          <Badge tone="bg-red-50 text-red-700 ring-red-200">{run.reversedByStatus === "paid" ? "已被沖銷" : "沖銷中"}</Badge>
        )}
        <span className="text-xs text-gray-500">核准：{payoutDateText(run.approvedAt)}</span>
        <span className="text-xs text-gray-500">發放日：{payoutDateText(run.paidOn)}</span>
        <span className="text-xs text-gray-500">基準日：{payoutDateText(run.asOf)}</span>
        <span className="ml-auto text-sm">
          本次合計 <b className={run.total < 0 ? "text-red-600" : "text-gray-900"}>{moneyText(run.total)}</b>
          <span className="ml-3 text-xs text-gray-500">
            {run.countsTowardPaid ? `累計已發放 ${moneyText(run.cumulativePaid)}` : "尚未發放，不計入累計"}
          </span>
        </span>
      </div>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-gray-500">
            <th className="py-1 pr-3 font-normal">角色</th>
            <th className="py-1 pr-3 font-normal">姓名</th>
            <th className="py-1 pr-3 font-normal">分潤</th>
            <th className="py-1 pr-3 text-right font-normal">本次金額</th>
            <th className="py-1 font-normal">差額調整</th>
          </tr>
        </thead>
        <tbody>
          {run.members.map((m) => (
            <tr key={m.employeeId} className="border-b border-gray-100 last:border-0">
              <td className="py-1 pr-3 text-gray-600">{(m.role && MEMBER_ROLE_LABEL[m.role]) ?? m.role ?? "—"}</td>
              <td className="py-1 pr-3 text-gray-900">{m.name ?? "—"}</td>
              <td className="py-1 pr-3 text-gray-600">{shareText(m)}</td>
              <td className={`py-1 pr-3 text-right tabular-nums ${m.amount < 0 ? "text-red-600" : "text-gray-900"}`}>{moneyText(m.amount)}</td>
              <td className="py-1 text-xs">
                {m.adjustment ? (
                  <span className={m.adjustment === "top_up" ? "text-emerald-700" : "text-red-600"}>
                    {PAYOUT_ADJUSTMENT_LABEL[m.adjustment]}
                    {m.adjustment === "overpaid" && m.overpaidBy > 0 ? ` ${moneyText(m.overpaidBy)}` : ""}
                  </span>
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </li>
  );
}

/** 展開區塊：發放紀錄（時間序）與分潤調整穿插，最後一列累計已發放。 */
export function ProjectPayoutDetail({ state, onRetry }: { state: PayoutsState | undefined; onRetry: () => void }) {
  if (!state || state.status === "loading") return <p className="px-4 py-3 font-sans text-sm text-gray-500">載入發放明細…</p>;
  if (state.status === "error")
    return (
      <div className="flex items-center gap-3 px-4 py-3 font-sans text-sm text-red-700">
        {state.message}
        <button type="button" className="rounded border border-red-300 px-2 py-0.5 text-xs hover:bg-red-50" onClick={onRetry}>重試</button>
      </div>
    );
  const d = state.data;
  const timeline = payoutTimeline(d);
  return (
    <div className="space-y-2 px-4 py-3 font-sans text-gray-800" style={{ whiteSpace: "normal", textAlign: "left" }}>
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-semibold">發放歷程：{[d.project.code, d.project.name].filter(Boolean).join(" ")}</span>
        <span className="text-xs text-gray-500">依時間排序；草稿批次不列{d.draftCount > 0 ? `（另有 ${d.draftCount} 個草稿，金額會隨入帳重算）` : ""}。</span>
      </div>
      {d.warnings.length > 0 && (
        <ul className="list-disc rounded bg-amber-50 px-6 py-1 text-xs text-amber-800">
          {d.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {timeline.length === 0 ? (
        <p className="text-sm text-gray-500">這個專案還沒有任何獎金發放紀錄或分潤調整。</p>
      ) : (
        <ol className="space-y-2">
          {timeline.map((e) => (e.type === "run" ? <RunEntry key={`run-${e.run.runId}`} run={e.run} /> : <RevisionEntry key={`rev-${e.revision.key}`} revision={e.revision} />))}
        </ol>
      )}
      <div className="flex flex-wrap items-baseline justify-end gap-x-4 border-t pt-2 text-sm">
        {d.pendingTotal !== 0 && <span className="text-xs text-gray-500">已核准／送審中未發放 {moneyText(d.pendingTotal)}（不計入）</span>}
        <span>
          累計已發放 <b className="text-base">{moneyText(d.paidTotal)}</b>
        </span>
      </div>
      <p className="text-right text-xs text-gray-400">累計已發放＝已發放批次（含沖銷）本專案金額合計，也就是下一批試算時扣掉的「已發放」。</p>
    </div>
  );
}
