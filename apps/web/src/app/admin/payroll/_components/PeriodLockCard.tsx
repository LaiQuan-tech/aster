"use client";

/**
 * 薪資作業頁的「月結與發薪鎖定」卡（2026-10-11 業主拍板：**每個月一個月結開關，HR 按「完成本月發薪」就鎖住該月**）。
 *
 * 最近 12 個月一列（GET /payroll-periods），每列顯示月份與狀態（開放中／已結算（誰、何時）／已重新開放
 * （誰、何時、理由）），按鈕依角色與狀態顯示（規則在 lib/payroll-periods-api.ts 的 periodActionsOf）：
 *   • HR：開放中或已重新開放的月份 →「完成 YYYY-MM 發薪並鎖定」。按下去先載入該月檢查清單（四項各自「完成數/應完成數」，
 *     通過綠、未通過紅，未完成的逐筆列出誰／哪張，最多 10 筆，其餘寫「還有 N 筆」）；待簽核的申請單只用琥珀色提醒、
 *     **不擋**。**四項全過（ready=true）才啟用「確認鎖定」，沒有任何強制略過。**
 *   • 老闆或老闆指定的人：已結算的月份 →「重新開放」。對話框必填理由（至少 5 個字），並**一定**顯示
 *     PRIOR_PERIOD_CORRECTION_HINT（薪資已匯款就別重新開放，改用前期更正）。
 *   • 已結算、但呼叫者不能重新開放（例如 HR 不在名單上）→ 顯示「只有老闆或老闆指定的人可以重新開放」。
 * 誰能重新開放的名單在 設定 → 進階功能（只有老闆能改）。錯誤一律顯示友善中文（lib/payroll-periods-api.ts 的
 * payrollPeriodErrorMessage；已結算的 409 是「YYYY-MM 已結算，請洽管理者」）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BottomSheet, Button, Card, ErrorText, Field, Pill, Skeleton, Textarea } from "@/components/admin-ui";
import {
  PRIOR_PERIOD_CORRECTION_HINT,
  PRIOR_PERIOD_CORRECTION_HREF,
  REOPEN_EFFECT_NOTE,
  REOPEN_REASON_MAX,
  REOPEN_REASON_MIN,
  canConfirmClose,
  checklistSummary,
  checklistViews,
  closeButtonLabel,
  closePayrollPeriod,
  closeSuccessMessage,
  getPeriodChecklist,
  isForbiddenError,
  isValidReopenReason,
  listPayrollPeriods,
  payrollPeriodErrorMessage,
  pendingEntryText,
  periodActionsOf,
  periodStatusText,
  reopenPayrollPeriod,
  reopenReasonError,
  reopenSuccessMessage,
  type PayrollPeriodRow,
  type PayrollPeriodsResponse,
  type PeriodChecklist,
  type PeriodStatus,
} from "@/lib/payroll-periods-api";
import { listPayrollAdjustments, relatedAdjustmentsNote, type PayrollAdjustmentWithState } from "@/lib/payroll-adjustments-api";

/** 狀態文字的顏色：開放中灰、已結算綠、已重新開放琥珀（文字本身已寫明狀態，顏色只是輔助）。 */
const STATUS_TEXT_CLASS: Record<PeriodStatus, string> = {
  open: "text-gray-500",
  closed: "text-green-700",
  reopened: "text-amber-700",
};

export function PeriodLockCard() {
  const [data, setData] = useState<PayrollPeriodsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 列表 403：不是 HR、也不是可重新開放的人。 */
  const [forbidden, setForbidden] = useState(false);
  /** 上一個動作成功的提示（綠字，留到下一次動作）。 */
  const [notice, setNotice] = useState<string | null>(null);

  // 「完成發薪並鎖定」對話框
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<PeriodChecklist | null>(null);
  const [checklistStatus, setChecklistStatus] = useState<PeriodStatus | null>(null);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  /** 清單請求的序號：換月份或關掉對話框後，還在途的舊回應直接丟掉。 */
  const checklistSeq = useRef(0);

  // 「重新開放」對話框
  const [reopenTarget, setReopenTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await listPayrollPeriods();
      setData(res);
      setLoadError(null);
      setForbidden(false);
    } catch (err) {
      if (isForbiddenError(err)) {
        setForbidden(true);
        setLoadError(null);
      } else {
        setLoadError(payrollPeriodErrorMessage(err, "載入月結狀態失敗"));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /* ------------------------------------------------------------- 鎖定 --- */

  const loadChecklist = useCallback(async (period: string) => {
    checklistSeq.current += 1;
    const seq = checklistSeq.current;
    setChecklistLoading(true);
    setCloseError(null);
    try {
      const res = await getPeriodChecklist(period);
      if (seq !== checklistSeq.current) return;
      setChecklist(res.checklist);
      setChecklistStatus(res.status);
      if (res.status === "closed") setCloseError(`${period} 已經完成發薪並鎖定`);
    } catch (err) {
      if (seq !== checklistSeq.current) return;
      setChecklist(null);
      setCloseError(payrollPeriodErrorMessage(err, "載入檢查清單失敗"));
    } finally {
      if (seq === checklistSeq.current) setChecklistLoading(false);
    }
  }, []);

  function openClose(period: string) {
    setNotice(null);
    setCloseTarget(period);
    setChecklist(null);
    setChecklistStatus(null);
    void loadChecklist(period);
  }

  function dismissClose() {
    if (closing) return;
    checklistSeq.current += 1; // 丟掉還在途的清單回應
    setCloseTarget(null);
    setChecklist(null);
    setChecklistStatus(null);
    setChecklistLoading(false);
    setCloseError(null);
  }

  async function confirmClose() {
    const period = closeTarget;
    if (!period) return;
    // 與按鈕 disabled 同一條規則：清單沒全過就算被硬打也不送。
    if (!canConfirmClose({ checklist, loading: checklistLoading, submitting: closing, periodStatus: checklistStatus })) return;
    setClosing(true);
    setCloseError(null);
    try {
      const outcome = await closePayrollPeriod(period);
      if (outcome.ok) {
        checklistSeq.current += 1;
        setCloseTarget(null);
        setChecklist(null);
        setNotice(closeSuccessMessage(period));
        await reload();
        return;
      }
      if (outcome.error === "already_closed") {
        checklistSeq.current += 1;
        setCloseTarget(null);
        setChecklist(null);
        setNotice(`${period} 已經完成發薪並鎖定（剛剛已有人鎖定了）`);
        await reload();
        return;
      }
      // 409 checklist_incomplete：用伺服器回的整份清單更新面板（沒附就重抓一次）。
      if (outcome.checklist) {
        setChecklist(outcome.checklist);
      } else {
        await loadChecklist(period);
      }
      setCloseError("檢查清單還沒全部通過，請先處理未完成的項目");
    } catch (err) {
      setCloseError(payrollPeriodErrorMessage(err, "鎖定失敗"));
    } finally {
      setClosing(false);
    }
  }

  /* --------------------------------------------------------- 重新開放 --- */

  function openReopen(period: string) {
    setNotice(null);
    setReopenTarget(period);
    setReason("");
    setReopenError(null);
  }

  // 重新開放對話框打開時，查一下這個月是不是已經在後續月份被「前期更正」過（補發／扣回）：重算它可能重複入帳，要提醒。
  // 查不到（沒權限、網路）就當沒有——提醒是輔助，不擋重新開放。
  const [relatedAdjustments, setRelatedAdjustments] = useState<PayrollAdjustmentWithState[] | null>(null);
  useEffect(() => {
    if (!reopenTarget) {
      setRelatedAdjustments(null);
      return;
    }
    let active = true;
    listPayrollAdjustments({ relatedPeriod: reopenTarget })
      .then((res) => {
        if (active) setRelatedAdjustments(res.adjustments);
      })
      .catch(() => {
        if (active) setRelatedAdjustments(null);
      });
    return () => {
      active = false;
    };
  }, [reopenTarget]);

  function dismissReopen() {
    if (reopening) return;
    setReopenTarget(null);
    setReason("");
    setReopenError(null);
  }

  async function confirmReopen() {
    const period = reopenTarget;
    if (!period || reopening || !isValidReopenReason(reason)) return;
    setReopening(true);
    setReopenError(null);
    try {
      const res = await reopenPayrollPeriod(period, reason);
      setReopenTarget(null);
      setReason("");
      setNotice(reopenSuccessMessage(res));
      await reload();
    } catch (err) {
      setReopenError(payrollPeriodErrorMessage(err, "重新開放失敗"));
      // 這個月份的狀態可能剛被別人改掉（已重新開放、或根本沒鎖）：把列表重抓一次讓畫面對上，對話框留著顯示原因。
      const code = (err as { code?: string }).code;
      if (code === "period_not_closed" || code === "already_reopened") void reload();
    } finally {
      setReopening(false);
    }
  }

  /* ------------------------------------------------------------- 畫面 --- */

  const views = checklist ? checklistViews(checklist) : [];
  const reasonError = reason.trim().length > 0 ? reopenReasonError(reason) : null;

  return (
    <Card>
      <div className="mb-1 flex items-start justify-between gap-3">
        <h2 className="text-sm font-medium text-gray-500">月結與發薪鎖定</h2>
        <button
          type="button"
          onClick={() => void reload()}
          className="shrink-0 text-xs font-medium hover:underline"
          style={{ color: "var(--brand)" }}
        >
          重新整理
        </button>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-gray-500">
        每個月一個月結開關：HR 按「完成 YYYY-MM 發薪並鎖定」後，該月的打卡、申請單、出勤月表、假單核銷、報銷、預支扣回、
        薪資作業與遲到說明決定都不能再改。只有老闆或老闆指定的人可以重新開放。
      </p>

      {notice && (
        <p role="status" className="mb-3 text-sm text-green-700" data-testid="period-lock-notice">
          {notice}
        </p>
      )}
      {loadError && (
        <div className="mb-3">
          <ErrorText>{loadError}</ErrorText>
        </div>
      )}

      {loading ? (
        <Skeleton lines={4} />
      ) : forbidden ? (
        <p className="text-sm text-gray-500">只有 HR 與老闆指定的人可以查看月結狀態。</p>
      ) : data ? (
        <ul className="divide-y divide-gray-100" data-testid="period-lock-list">
          {data.periods.map((row: PayrollPeriodRow) => {
            const actions = periodActionsOf(row.status, data);
            return (
              <li
                key={row.period}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                data-testid={`period-row-${row.period}`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium tabular-nums text-gray-900">{row.period}</span>
                    {row.period === data.currentPeriod && <Pill tone="blue">本月</Pill>}
                  </div>
                  <p className={`mt-0.5 break-words text-sm ${STATUS_TEXT_CLASS[row.status] ?? "text-gray-500"}`}>
                    {periodStatusText(row)}
                  </p>
                  {row.status === "closed" && (
                    <p className="mt-0.5 text-xs text-gray-400">
                      出勤月表 {row.lockedCount}/{row.sheetCount} 張已鎖定
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {actions.showClose && (
                    <Button size="sm" onClick={() => openClose(row.period)} data-testid="period-close-btn">
                      {closeButtonLabel(row.period)}
                    </Button>
                  )}
                  {actions.showReopen && (
                    <Button size="sm" variant="secondary" onClick={() => openReopen(row.period)} data-testid="period-reopen-btn">
                      重新開放
                    </Button>
                  )}
                  {actions.reopenForbiddenHint && (
                    <span className="text-xs text-gray-400" data-testid="period-reopen-forbidden">
                      {actions.reopenForbiddenHint}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* 完成發薪並鎖定：先看檢查清單，四項全過才能確認。 */}
      <BottomSheet
        open={closeTarget !== null}
        onClose={dismissClose}
        title={closeTarget ? closeButtonLabel(closeTarget) : "完成發薪並鎖定"}
      >
        <div className="space-y-4 text-sm text-gray-700" data-testid="period-close-dialog">
          <p className="text-xs leading-relaxed text-gray-500">
            鎖定前要先通過下面的檢查，沒有強制略過。鎖定後這個月的打卡、申請單、出勤月表、假單核銷、報銷、預支扣回、
            薪資作業與遲到說明決定都不能再改，要改只能由老闆或老闆指定的人重新開放。
          </p>

          {checklistLoading && <p className="text-gray-500">載入檢查清單中…</p>}
          {closeError && <ErrorText>{closeError}</ErrorText>}

          {checklist && (
            <>
              <p
                className={`font-medium ${checklist.ready ? "text-green-700" : "text-red-700"}`}
                data-testid="period-checklist-summary"
              >
                {checklistSummary(checklist)}
              </p>
              <ul className="space-y-2.5">
                {views.map((v) => (
                  <li
                    key={v.key}
                    className={`rounded-xl border px-3 py-2.5 ${
                      v.passed ? "border-green-200 bg-green-50/60" : "border-red-200 bg-red-50/60"
                    }`}
                    data-testid={`period-checklist-${v.key}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-900">{v.label}</span>
                      <span className={`shrink-0 text-xs font-semibold tabular-nums ${v.passed ? "text-green-700" : "text-red-700"}`}>
                        {v.progress}　{v.passed ? "已通過" : "未通過"}
                      </span>
                    </div>
                    {!v.passed && (
                      <>
                        <ul className="mt-2 space-y-0.5 text-xs leading-relaxed text-red-800">
                          {v.shown.map((entry, index) => (
                            <li key={`${entry.refId ?? entry.employeeId ?? "row"}-${index}`}>{pendingEntryText(entry)}</li>
                          ))}
                          {v.moreLabel && <li className="text-red-600">{v.moreLabel}</li>}
                        </ul>
                        {v.fixHref && (
                          <Link
                            href={v.fixHref}
                            className="mt-2 inline-block text-xs font-medium hover:underline"
                            style={{ color: "var(--brand)" }}
                          >
                            前往處理
                          </Link>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>

              {checklist.warnings.length > 0 && (
                <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800" role="status">
                  {checklist.warnings.map((w) => (
                    <li key={w.code}>提醒（不影響鎖定）：{w.message}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div className="mt-5 grid grid-cols-3 gap-3">
            <Button
              variant="secondary"
              onClick={() => closeTarget && void loadChecklist(closeTarget)}
              disabled={closing || checklistLoading}
            >
              重新檢查
            </Button>
            <Button variant="secondary" onClick={dismissClose} disabled={closing}>
              取消
            </Button>
            <Button
              onClick={() => void confirmClose()}
              loading={closing}
              disabled={!canConfirmClose({ checklist, loading: checklistLoading, submitting: closing, periodStatus: checklistStatus })}
              data-testid="period-close-confirm"
            >
              確認鎖定
            </Button>
          </div>
        </div>
      </BottomSheet>

      {/* 重新開放：必填理由，並一定顯示「已匯款就別重新開放」的提示。 */}
      <BottomSheet
        open={reopenTarget !== null}
        onClose={dismissReopen}
        title={reopenTarget ? `重新開放 ${reopenTarget}` : "重新開放"}
      >
        <div className="space-y-4 text-sm text-gray-700" data-testid="period-reopen-dialog">
          <div
            role="note"
            className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 leading-relaxed text-amber-900"
            data-testid="prior-period-correction-hint"
          >
            <p className="font-medium">{PRIOR_PERIOD_CORRECTION_HINT}</p>
            {PRIOR_PERIOD_CORRECTION_HREF && (
              <Link
                href={PRIOR_PERIOD_CORRECTION_HREF}
                // 連結在同一頁：先關掉對話框，才看得到後面那張「薪資加減項（前期更正）」卡。
                onClick={dismissReopen}
                className="mt-1 inline-block text-xs font-medium underline"
                data-testid="prior-period-correction-link"
              >
                前往前期更正
              </Link>
            )}
          </div>

          {reopenTarget && relatedAdjustmentsNote(reopenTarget, relatedAdjustments) && (
            <div
              role="note"
              className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900"
              data-testid="reopen-related-adjustments"
            >
              <p className="font-medium">{relatedAdjustmentsNote(reopenTarget, relatedAdjustments)?.title}</p>
              <ul className="mt-1 list-disc pl-4">
                {relatedAdjustmentsNote(reopenTarget, relatedAdjustments)?.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs leading-relaxed text-gray-500">{REOPEN_EFFECT_NOTE}</p>

          <Field
            label="重新開放的理由"
            required
            htmlFor="period-reopen-reason"
            hint={`至少 ${REOPEN_REASON_MIN} 個字；會記錄是誰、何時、為什麼重新開放，並通知老闆與 HR`}
            error={reasonError ?? undefined}
          >
            <Textarea
              id="period-reopen-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REOPEN_REASON_MAX}
              rows={3}
              disabled={reopening}
              aria-invalid={reasonError ? true : undefined}
            />
          </Field>

          {reopenError && <ErrorText>{reopenError}</ErrorText>}

          <div className="mt-5 grid grid-cols-2 gap-3">
            <Button variant="secondary" size="lg" onClick={dismissReopen} disabled={reopening}>
              取消
            </Button>
            <Button
              variant="danger"
              size="lg"
              onClick={() => void confirmReopen()}
              loading={reopening}
              disabled={!isValidReopenReason(reason)}
              data-testid="period-reopen-confirm"
            >
              確認重新開放
            </Button>
          </div>
        </div>
      </BottomSheet>
    </Card>
  );
}
