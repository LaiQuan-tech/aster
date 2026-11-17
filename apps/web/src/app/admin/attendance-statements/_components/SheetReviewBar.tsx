"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Empty, ErrorText, Pill } from "@/components/admin-ui";
import { AttendanceSheetTable, SheetMonthAnomalies } from "@/components/AttendanceSheetTable";
import {
  approveAttendanceSheet,
  dayAnomalyText,
  exportAttendanceSheetXlsx,
  friendlyError,
  getAttendanceSheet,
  mergeDayPatch,
  patchAttendanceSheetDay,
  recomputeAttendanceSheet,
  reopenAttendanceSheet,
  returnAttendanceSheet,
  SHEET_STATUS_LABEL,
  type AnomalySeverity,
  type SheetDayPatch,
  type SheetView,
} from "@/lib/attendance-sheets-api";
import { getRuleConfigVersions, type RuleConfigVersion } from "@/lib/admin-api";
import { sheetActions } from "@/lib/attendance-statements-page";
import { SheetSnapshots } from "./SheetSnapshots";
import {
  SHEET_FOCUS_EVENT,
  anomalyPills,
  approveHint,
  filterBySeverity,
  monthAnomalyHref,
  parseSheetFocusHash,
  requestSheetFocus,
  severityFilterOf,
  sheetDayRowId,
  statusPillFocus,
  type SheetFocus,
} from "@/lib/sheet-focus";

/** 可點藥丸的共用樣式（hover、游標、底線、鍵盤焦點框）。 */
const PILL_LINK =
  "cursor-pointer rounded-full px-2 py-0.5 text-xs underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1";

/** 等 React 把剛展開的區塊畫出來再捲動（兩個 frame）。 */
function afterPaint(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * 出勤統計表合併頁的「月表狀態列」（2026-11-09；原 /admin/attendance-sheets/[id] 詳細頁的功能搬到這裡）：
 *   - 狀態、送出／經理審／核准／鎖定時間、本月適用規則版本、退回原因；
 *   - 異常清單（可展開：月份級異常＋逐日異常，文字與詳細頁相同）；
 *   - 核准／退回（原因必填）／重開（原因必填）／重算／匯出單張 xlsx——API、可按條件、錯誤訊息與原詳細頁相同；
 *     動作成功後重新 GET 月表並呼叫 onChanged（頁面重抓清單與統計表）；
 *   - 「逐日月表」（可展開）：原詳細頁的可編輯逐日表格（加班覆寫、內容、備註、晚餐、異常說明）、列印月表、歷次核准快照。
 * 權限：跟原詳細頁一樣不在前端分角色，交給 API（approve／reopen／recompute＝requireFinance；return＝主管或 HR；
 * 快照＝requireHrAdmin，讀不到就不顯示）。
 */

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_TONE: Record<string, "gray" | "blue" | "green" | "amber" | "red"> = {
  draft: "gray",
  submitted: "blue",
  manager_reviewed: "amber",
  approved: "green",
  locked: "green",
  returned: "red",
};

export function SheetReviewBar({
  sheetId,
  reloadKey = 0,
  listLoading = false,
  onChanged,
  onPrintSheet,
}: {
  /** 變動＝重新 GET 月表（例如統計表開畫面時重算了月表）。 */
  reloadKey?: number;
  /** 月表清單還在載入（還不知道有沒有月表）。 */
  listLoading?: boolean;
  /** 這位員工這個月的月表 id；null＝尚無月表。 */
  sheetId: string | null;
  /** 簽核動作／逐日修改成功後：頁面重抓月表清單與統計表。 */
  onChanged: () => void;
  /** 列印「逐日月表」（頁面切換列印目標後呼叫 window.print）。 */
  onPrintSheet: () => void;
}) {
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showAnomalies, setShowAnomalies] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [ruleVersions, setRuleVersions] = useState<RuleConfigVersion[] | null>(null);
  /** 異常清單篩選（藥丸「需處理／提醒」點進來時）；null＝全部。 */
  const [severity, setSeverity] = useState<AnomalySeverity | null>(null);
  const anomaliesRef = useRef<HTMLDivElement | null>(null);
  const approveRef = useRef<HTMLDivElement | null>(null);

  /**
   * 2026-11-17 狀態藥丸可點：#anomalies(-error|-warn) 展開異常清單（並篩選）捲過去；#approve 捲到核准區、
   * 焦點移到第一顆可按的按鈕。同頁由 requestSheetFocus 廣播事件；跨頁連結靠載入月表時讀 hash。
   */
  const applyFocus = useCallback((focus: SheetFocus) => {
    if (focus === "approve") {
      afterPaint(() => {
        approveRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        const first = approveRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
        first?.focus({ preventScroll: true });
      });
      return;
    }
    setShowAnomalies(true);
    setSeverity(severityFilterOf(focus));
    afterPaint(() => {
      anomaliesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      anomaliesRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    const onFocus = (e: Event) => {
      const f = (e as CustomEvent<SheetFocus>).detail;
      if (f) applyFocus(f);
    };
    const onHash = () => {
      const f = parseSheetFocusHash(window.location.hash);
      if (f) applyFocus(f);
    };
    window.addEventListener(SHEET_FOCUS_EVENT, onFocus);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener(SHEET_FOCUS_EVENT, onFocus);
      window.removeEventListener("hashchange", onHash);
    };
  }, [applyFocus]);

  // 跨頁連結（…?employee=&period=#anomalies-error）：月表載入後套用一次。
  const loadedSheetId = sheet?.id ?? null;
  useEffect(() => {
    if (!loadedSheetId) return;
    const f = parseSheetFocusHash(window.location.hash);
    if (f) applyFocus(f);
  }, [loadedSheetId, applyFocus]);

  /** 逐日異常 → 展開逐日月表、捲到那一天並短暫醒目。 */
  function goToDay(date: string) {
    setShowDetail(true);
    afterPaint(() => {
      const row = document.getElementById(sheetDayRowId(date));
      if (!row) return;
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("ring-2", "ring-amber-400");
      window.setTimeout(() => row.classList.remove("ring-2", "ring-amber-400"), 2400);
    });
  }

  const load = useCallback(async () => {
    if (!sheetId) {
      setSheet(null);
      return;
    }
    setLoading(true);
    try {
      const res = await getAttendanceSheet(sheetId);
      setSheet(res.sheet);
      setError(null);
    } catch (err) {
      setError(friendlyError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, [sheetId]);

  useEffect(() => {
    setMessage(null);
    setError(null);
    setSeverity(null);
  }, [sheetId]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    // 生效日資訊非關鍵路徑：拿不到就跳過顯示。
    getRuleConfigVersions()
      .then(setRuleVersions)
      .catch(() => null);
  }, []);

  /** 共用：跑動作 → 重新 GET 月表 → 通知頁面；錯誤訊息照原詳細頁（friendlyError）。 */
  async function run(fn: () => Promise<{ warnings?: string[] } | unknown>, okText: string, failText: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = (await fn()) as { warnings?: string[] } | undefined;
      await load(); // 這些端點只回 {id,status,…}，重新 GET 換回完整 SheetView
      const warnings = res?.warnings ?? [];
      setMessage(warnings.length > 0 ? `${okText}。${warnings.join("；")}` : okText);
      onChanged();
    } catch (err) {
      setError(friendlyError(err, failText));
    } finally {
      setBusy(false);
    }
  }

  function onApprove() {
    if (!sheet) return;
    void run(() => approveAttendanceSheet(sheet.id), "已核准", "核准失敗");
  }

  function onReturn() {
    if (!sheet) return;
    const reason = window.prompt("請輸入退回原因：");
    if (!reason || !reason.trim()) return;
    void run(() => returnAttendanceSheet(sheet.id, reason.trim()), "已退回", "退回失敗");
  }

  function onReopen() {
    if (!sheet) return;
    const reason = window.prompt("請輸入重開原因（將退回草稿重新填報）：");
    if (!reason || !reason.trim()) return;
    void run(() => reopenAttendanceSheet(sheet.id, reason.trim()), "已重開為草稿", "重開失敗");
  }

  function onRecompute() {
    if (!sheet) return;
    void run(() => recomputeAttendanceSheet(sheet.id), "已重新計算", "重算失敗");
  }

  async function onExport() {
    if (!sheet) return;
    setError(null);
    try {
      await exportAttendanceSheetXlsx(sheet.id, `出勤月表_${sheet.period}_${sheet.employeeName}.xlsx`);
    } catch (err) {
      setError(friendlyError(err, "匯出失敗"));
    }
  }

  async function handlePatchDay(date: string, patch: SheetDayPatch) {
    if (!sheet) return;
    try {
      const res = await patchAttendanceSheetDay(sheet.id, date, patch);
      if (patch.dinnerTaken !== undefined) {
        // 晚餐改的是結算輸入：伺服器已重算當天加班與整月異常，重新抓整張表。
        const fresh = await getAttendanceSheet(sheet.id);
        setSheet(fresh.sheet);
      } else {
        setSheet((prev) =>
          prev ? { ...prev, days: prev.days.map((d) => (d.date === date ? mergeDayPatch(d, res.day) : d)) } : prev,
        );
      }
      setError(null);
      onChanged();
    } catch (err) {
      setError(friendlyError(err, "更新失敗"));
      throw err;
    }
  }

  if (!sheetId && listLoading) {
    return (
      <Card className="print:hidden">
        <Empty>月表載入中…</Empty>
      </Card>
    );
  }

  if (!sheetId) {
    return (
      <Card className="print:hidden">
        <p className="text-sm text-gray-500">
          這個月份尚無出勤月表（未產生或不在職）：無法簽核。可在上方按「產生月表」。
        </p>
      </Card>
    );
  }

  if (!sheet) {
    return (
      <Card className="print:hidden">
        {loading ? <Empty>月表載入中…</Empty> : <ErrorText>{error ?? "查無月表"}</ErrorText>}
      </Card>
    );
  }

  const can = sheetActions(sheet.status);
  const authoritativeVersion = sheet.ruleConfigVersion;
  const matchedRuleVersion =
    authoritativeVersion != null && ruleVersions ? (ruleVersions.find((v) => v.version === authoritativeVersion) ?? null) : null;
  const ruleVersionLabel =
    !ruleVersions || authoritativeVersion == null
      ? null
      : matchedRuleVersion
        ? matchedRuleVersion.effectiveFrom
          ? `本月適用規則 v${matchedRuleVersion.version}（生效 ${matchedRuleVersion.effectiveFrom}）`
          : `本月適用規則 v${matchedRuleVersion.version}（系統預設）`
        : "本月適用規則：預設規則";

  const allDayAnomalies = sheet.days.flatMap((d) =>
    d.anomalies.map((a, i) => ({ date: d.date, a, severity: a.severity, key: `${d.date}-${a.code}-${i}` })),
  );
  const dayAnomalies = filterBySeverity(allDayAnomalies, severity);
  const pills = anomalyPills(sheet.anomalyCount);
  const statusFocus = statusPillFocus(sheet.status);
  const hint = approveHint(sheet.status, sheet.anomalyCount.error);
  const btn = "rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <Card className="sheet-review-card">
      <div className="no-print">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-gray-900">出勤月表</span>
        {statusFocus ? (
          <button
            type="button"
            onClick={() => requestSheetFocus(statusFocus)}
            aria-label={`月表狀態：${SHEET_STATUS_LABEL[sheet.status]}，前往送出／核准操作區`}
            className="cursor-pointer rounded-full hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            data-testid="sheet-status-pill"
          >
            <Pill tone={STATUS_TONE[sheet.status] ?? "gray"}>{SHEET_STATUS_LABEL[sheet.status]} ›</Pill>
          </button>
        ) : (
          <Pill tone={STATUS_TONE[sheet.status] ?? "gray"}>{SHEET_STATUS_LABEL[sheet.status]}</Pill>
        )}
        {pills.map((p) => (
          <button
            key={p.focus}
            type="button"
            onClick={() => requestSheetFocus(p.focus)}
            aria-label={p.ariaLabel}
            data-testid={`sheet-pill-${p.focus}`}
            className={`${PILL_LINK} ${
              p.focus === "anomalies-error"
                ? "bg-red-100 text-red-700 hover:bg-red-200 focus-visible:ring-red-400"
                : "bg-amber-100 text-amber-700 hover:bg-amber-200 focus-visible:ring-amber-400"
            }`}
          >
            {p.label} ›
          </button>
        ))}
        {loading && <span className="text-xs text-gray-400">更新中…</span>}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
        <span>送出 {fmtDateTime(sheet.submittedAt)}</span>
        <span>經理審 {fmtDateTime(sheet.managerReviewedAt)}</span>
        <span>核准 {fmtDateTime(sheet.approvedAt)}</span>
        <span>鎖定 {fmtDateTime(sheet.lockedAt)}</span>
        {ruleVersionLabel && <span>{ruleVersionLabel}</span>}
        {sheet.returnReason && <span className="text-red-600">退回原因：{sheet.returnReason}</span>}
      </div>

      {message && <p className="mt-2 text-sm text-green-600">{message}</p>}
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      <div ref={approveRef} id="approve" className="mt-3 flex scroll-mt-24 flex-wrap gap-2" aria-label="月表簽核操作">
        <button
          type="button"
          onClick={onApprove}
          disabled={busy || !can.approve}
          className={`${btn} text-white`}
          style={{ backgroundColor: "var(--brand)" }}
        >
          核准
        </button>
        <button type="button" onClick={onReturn} disabled={busy || !can.return} className={`${btn} border border-red-300 text-red-700`}>
          退回
        </button>
        <button type="button" onClick={onReopen} disabled={busy || !can.reopen} className={`${btn} border border-gray-300 text-gray-700`}>
          重開
        </button>
        <button
          type="button"
          onClick={onRecompute}
          disabled={busy || !can.recompute}
          className={`${btn} border border-gray-300 text-gray-700`}
        >
          重算
        </button>
        <button type="button" onClick={() => void onExport()} className={`${btn} border border-gray-300 text-gray-700`}>
          匯出月表 xlsx
        </button>
      </div>
      {hint && (
        <p className="mt-2 text-xs text-amber-800" data-testid="approve-hint">
          {hint.focus ? (
            <button
              type="button"
              onClick={() => requestSheetFocus(hint.focus!)}
              className="cursor-pointer text-left underline hover:text-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              {hint.text} → 查看異常清單
            </button>
          ) : (
            hint.text
          )}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-3">
        <button
          type="button"
          aria-expanded={showAnomalies}
          onClick={() => setShowAnomalies((v) => !v)}
          className="text-sm font-medium hover:underline"
          style={{ color: "var(--brand)" }}
        >
          {showAnomalies ? "▾" : "▸"} 異常清單（本月 {sheet.monthAnomalies.length}、逐日 {allDayAnomalies.length}）
        </button>
        <button
          type="button"
          aria-expanded={showDetail}
          onClick={() => setShowDetail((v) => !v)}
          className="text-sm font-medium hover:underline sm:ml-4"
          style={{ color: "var(--brand)" }}
        >
          {showDetail ? "▾" : "▸"} 逐日月表（可編輯）與核准快照
        </button>
      </div>

      {showAnomalies && (
        <div ref={anomaliesRef} id="anomalies" tabIndex={-1} className="mt-3 scroll-mt-24 space-y-3 focus:outline-none" aria-label="異常清單">
          {severity && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-gray-600" data-testid="anomaly-filter">
              <span>只看{severity === "error" ? "需處理" : "提醒"}項目</span>
              <button type="button" onClick={() => setSeverity(null)} className="underline hover:text-gray-900">
                顯示全部
              </button>
            </p>
          )}
          <SheetMonthAnomalies
            anomalies={sheet.monthAnomalies}
            audience="admin"
            severity={severity}
            hrefFor={(code) => monthAnomalyHref(code, sheet.employeeId)}
          />
          {dayAnomalies.length > 0 ? (
            <section aria-label="逐日異常" className="rounded-xl border border-gray-100 p-3">
              <p className="mb-2 text-xs font-medium text-gray-500">逐日異常</p>
              <ul className="space-y-1">
                {dayAnomalies.map(({ date, a, key }) => (
                  <li key={key} className="flex flex-wrap items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => goToDay(date)}
                      aria-label={`到逐日月表 ${date}：${dayAnomalyText(a)}`}
                      className="cursor-pointer tabular-nums text-gray-600 underline hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                    >
                      {date.slice(5)} ›
                    </button>
                    <span
                      className={`rounded-full px-2 py-0.5 font-medium ${
                        a.severity === "error"
                          ? "bg-red-100 text-red-700"
                          : a.severity === "warn"
                            ? "bg-amber-100 text-amber-700"
                            : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {dayAnomalyText(a)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            filterBySeverity(sheet.monthAnomalies, severity).length === 0 && (
              <p className="text-xs text-gray-400">{severity ? "沒有符合篩選的異常" : "本月沒有異常"}</p>
            )
          )}
        </div>
      )}

      </div>

      {showDetail && (
        <div className="mt-3 space-y-4">
          <div className="no-print flex justify-end">
            <button type="button" onClick={onPrintSheet} className={`${btn} border border-gray-300 text-gray-700`}>
              列印月表
            </button>
          </div>
          {/* 列印：平常整張卡（.sheet-review-card）不印；按「列印月表」時頁面在 body 加 print-attendance-sheet，
              只印這張逐日表、統計表藏起來（globals.css）。 */}
          <div className="overflow-x-auto">
            <AttendanceSheetTable
              sheet={sheet}
              editable={sheet.status !== "locked"}
              showMoney
              onPatchDay={handlePatchDay}
              preferenceScope="admin"
              showMonthAnomalies="admin"
            />
          </div>
          <div className="no-print">
            <SheetSnapshots sheetId={sheet.id} reloadKey={sheet.approvedAt ?? ""} />
          </div>
        </div>
      )}
    </Card>
  );
}
