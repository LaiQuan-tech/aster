"use client";

/**
 * 請假／申請 `/ess/requests?kind=…&date=…&id=…`
 *
 * 由上而下：①種類切換（請假｜補卡｜加班｜公出）②該種類的表單卡（只顯示該種類欄位）
 * ③送出後成功畫面取代表單（等待誰簽核＋摘要＋再填一張／查看我的申請）
 * ④「我的申請」清單（`GET /requests?scope=mine`）。
 * 申請人一律是登入者本人（沒有代為申請；API 對代申請欄位且對象非本人回 400 filing_on_behalf_removed）。
 *
 * 送出流程：先準備附件（壓縮＋大小檢查，不過就不建單）→ `createRequest(body)` → 逐檔 `uploadAttachment`
 * （某檔失敗其餘照傳）→ `invalidateEssState()` → 成功畫面 → 列表重載（lib/upload-prep.ts createThenUploadAll）。
 * 純函式（時數規則、body 組裝、清單文案）在 `@/lib/leave-hours` 與 `@/lib/request-forms`，有單元測試。
 * 頁框（頂部列／底列／gate／Toast）由 `ess/layout.tsx` 提供，本頁只回內容。
 *
 * 公出／出差自行墊付（2026-10-16）：表單內當場填的報銷明細走 `submitTripWithExpenses`（先建公出單、再逐筆建報銷，
 * lib/trip-expense.ts fileTripWithExpenses）；公出單建好就換成功畫面，報銷失敗只在成功畫面說明、不會重送公出單。
 * 成功畫面與「我的申請」對自行墊付的公出／出差單給「填報銷單」（連到報銷頁 `?trip=`），並顯示已報銷幾筆
 * （`GET /expenses?scope=mine`，best-effort，失敗就不顯示）。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, Skeleton } from "@/components/ess-ui";
import { useEssPageTitle } from "@/components/ess-page-title";
import {
  cancelExpense,
  createRequest,
  fileExpense,
  getExpenseSettingsForMe,
  getLeaveBalances,
  getLeaveTypes,
  getMyExpenseCategories,
  getMyExpenses,
  getRequests,
  getShifts,
  uploadAttachment,
  uploadExpenseReceipt,
  type CreateRequestBody,
  type MyExpenseCategory,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
  type RequestKind,
  type Shift,
} from "@/lib/ess-api";
import { todayKey } from "@/lib/ess-format";
import { invalidateEssState, useEssState } from "@/lib/ess-state";
import { DEFAULT_SHIFT, type ShiftLike } from "@/lib/leave-hours";
import { KIND_LABEL, KIND_ORDER, approvalChainSummary, attachmentUploadWarning, isRequestKind } from "@/lib/request-forms";
import { createThenUploadAll, withFileName } from "@/lib/upload-prep";
import {
  RECEIPT_AUTO_CANCEL_REASON,
  expenseErrorMessage,
  expenseErrorReason,
  readLeftoverClaim,
  saveLeftoverClaim,
  type StorageLike,
} from "@/lib/advance-view";
import {
  fileTripWithExpenses,
  isSelfPaidTrip,
  summarizeTripClaims,
  tripExpenseHref,
  tripExpenseOutcome,
  type FailedExpense,
  type ReadyExpense,
  type TripClaimSummary,
} from "@/lib/trip-expense";
import { FixPunchForm } from "./_components/FixPunchForm";
import { KindSwitcher } from "./_components/KindSwitcher";
import { LeaveForm } from "./_components/LeaveForm";
import { MyRequests } from "./_components/MyRequests";
import { OvertimeForm } from "./_components/OvertimeForm";
import { SubmitSuccess } from "./_components/SubmitSuccess";
import { TripForm } from "./_components/TripForm";
import { describeError } from "./_components/form-shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 只切到切換列上有的表單；舊的「預支」（petty_cash）深連結落回請假，下方「我的申請」照常顯示舊單。 */
function isFormKind(k: string | null): k is RequestKind {
  return isRequestKind(k) && KIND_ORDER.includes(k);
}

interface SuccessInfo {
  approverName: string | null;
  summary: string;
  uploadWarning: string | null;
  expenseOutcome?: { tone: "success" | "warning"; text: string } | null;
  fillExpenseHref?: string | null;
}

/** 這個分頁的 sessionStorage（報銷頁「留下的單」用同一格）；被擋就 null。 */
function sessionStore(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** 自行墊付的公出／出差單（送出時沒帶 advanceRequested）→ 成功畫面給「填報銷單」。 */
function fillExpenseHrefFor(body: CreateRequestBody, requestId: string): string | null {
  return body.kind === "business_trip" && isSelfPaidTrip({ kind: "business_trip", advance_requested: body.advanceRequested ?? null })
    ? tripExpenseHref(requestId)
    : null;
}

/** 成功畫面列出沒送成的報銷時，每筆的原因（中文）。`savedLeftover`＝留下的單已記給報銷頁，下次送出會先撤回。 */
function failedExpenseReason(f: FailedExpense<unknown>, savedLeftover: boolean): string {
  if (f.stage === "create") return expenseErrorMessage(f.error, "建立失敗，請稍後再試", "create");
  const why = expenseErrorReason(f.error, "upload");
  const head = `憑證沒傳上${why ? `（${why}）` : ""}`;
  if (f.rolledBack) return `${head}，這筆已自動撤回`;
  return savedLeftover
    ? `${head}，自動撤回也沒成功；到報銷頁重新送出時會先撤回那一筆，不會重複`
    : `${head}，自動撤回也沒成功，這筆目前沒有憑證；請到報銷頁撤回後重填`;
}

/** 租戶的預設班別＝ created_at 最早的 shift；沒有 shift → DEFAULT_SHIFT。 */
function pickDefaultShift(shifts: Shift[]): ShiftLike {
  if (shifts.length === 0) return DEFAULT_SHIFT;
  const sorted = [...shifts].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  return sorted[0];
}

function RequestsView() {
  const searchParams = useSearchParams();
  const urlKind = searchParams.get("kind");
  const urlDate = searchParams.get("date");
  const urlId = searchParams.get("id");
  const initialDate = urlDate && DATE_RE.test(urlDate) ? urlDate : todayKey();
  // 補卡預設卡別：打卡紀錄頁「申請補卡」帶 `type=in|out`（lib/punch-history 的 fixPunchHref）；其他值忽略。
  const urlPunchType = searchParams.get("type");
  const initialPunchType = urlPunchType === "in" || urlPunchType === "out" ? urlPunchType : undefined;

  // 進頁時確保 ESS 狀態新鮮（ensureFresh）；本頁不再需要 me（請假表單原本用它篩班表，班表功能已移除）。
  useEssState();

  const [kind, setKind] = useState<RequestKind>(isFormKind(urlKind) ? urlKind : "leave");
  // 外部改了網址（例如通知深連結）就跟著切；本頁自己切換時已先 setKind，這裡不會再觸發。
  useEffect(() => {
    if (isFormKind(urlKind)) setKind(urlKind);
  }, [urlKind]);
  // 手機頂部標題跟著種類走（補卡申請、加班申請…；同下方卡片標題），離開本頁自動還原路由表的標題。
  useEssPageTitle(`${KIND_LABEL[kind]}申請`);

  // 參考資料（best-effort：任何一支失敗都退化，不擋表單）
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[] | null>(null);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  // 1 天 ＝ 幾小時（規則 payroll.dailyRegularHours，隨 GET /leave-balances 回；缺席＝8）：只用在把請假時數顯示成天＋時。
  const [hoursPerDay, setHoursPerDay] = useState<number | undefined>(undefined);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [advanceThreshold, setAdvanceThreshold] = useState<number | null>(null);
  // 報銷類別（公出自行墊付當場填明細）；null＝載入中或失敗 → 表單不顯示明細區。
  const [expenseCategories, setExpenseCategories] = useState<MyExpenseCategory[] | null>(null);
  // 每張出差單已報銷幾筆（「我的申請」顯示）；載入失敗＝空，不擋清單。
  const [tripClaims, setTripClaims] = useState<Map<string, TripClaimSummary>>(() => new Map());
  const defaultShift = useMemo(() => pickDefaultShift(shifts), [shifts]);

  // 我的申請
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // 送出
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessInfo | null>(null);
  const [formKey, setFormKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const loadTripClaims = useCallback(async () => {
    try {
      const res = await getMyExpenses();
      setTripClaims(summarizeTripClaims(res.claims ?? []));
    } catch (err) {
      console.warn("[申請] 載入已報銷筆數失敗（不影響清單）", err);
    }
  }, []);

  const loadRequests = useCallback(async () => {
    void loadTripClaims();
    try {
      const res = await getRequests({ scope: "mine" });
      setRequests(res.requests ?? []);
      setListError(null);
    } catch (err) {
      setListError(describeError(err, "載入申請失敗"));
    } finally {
      setListLoading(false);
    }
  }, [loadTripClaims]);

  useEffect(() => {
    let active = true;
    (async () => {
      const [lt, bal, sh, cfg, cats] = await Promise.allSettled([
        getLeaveTypes(),
        getLeaveBalances(),
        getShifts(),
        getExpenseSettingsForMe(),
        getMyExpenseCategories(),
      ]);
      if (!active) return;
      setLeaveTypes(lt.status === "fulfilled" ? (lt.value.leaveTypes ?? []) : []);
      if (bal.status === "fulfilled") {
        setBalances(bal.value.balances ?? []);
        setHoursPerDay(bal.value.dailyRegularHours);
      }
      if (sh.status === "fulfilled") setShifts(sh.value.shifts ?? []);
      if (cfg.status === "fulfilled") setAdvanceThreshold(cfg.value.settings?.advanceThreshold ?? null);
      if (cats.status === "fulfilled") setExpenseCategories(cats.value.categories ?? []);
    })();
    void loadRequests();
    return () => {
      active = false;
    };
  }, [loadRequests]);

  function changeKind(next: RequestKind) {
    if (next === kind) return;
    setKind(next);
    setSuccess(null);
    setSubmitError(null);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.set("kind", next);
      params.delete("id");
      window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
    }
  }

  // 成功畫面（只用 setState，依賴為空）。
  const showSuccess = useCallback(
    (
      created: Awaited<ReturnType<typeof createRequest>>,
      summary: string,
      extra: Pick<SuccessInfo, "uploadWarning" | "expenseOutcome" | "fillExpenseHref">,
    ) => {
      const steps = [...(created.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder);
      // 第一關可能有多位候選（任一人簽即過）：有 candidateNames 就用「／」串，舊 API 退回 approverName
      const firstNames = (steps[0]?.candidateNames ?? []).map((n) => n.trim()).filter(Boolean);
      setSuccess({
        approverName: firstNames.length > 0 ? firstNames.join("／") : (steps[0]?.approverName ?? null),
        // 兩關以上（零用金與出差／公出一律主管 → 老闆）把整條鏈附在摘要後，
        // 讓申請人一眼看到「還要誰簽」，不必等列表載入。
        summary: [summary, approvalChainSummary(steps)].filter(Boolean).join("｜"),
        ...extra,
      });
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [],
  );

  const submit = useCallback(
    async (body: CreateRequestBody, files: File[], summary: string) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        // 順序（2026-10-12）：先準備每個附件（照片壓縮＋3 MB 檢查）→ 建單 → 逐檔上傳（lib/upload-prep.ts）。
        // 以前先建單才壓縮：桌機 Chrome 選 HEIC 壓不了，假單已建好卻缺憑證，同批其他檔也沒傳。
        // 現在任一附件準備不過就不建單、訊息指出是哪個檔；建單後某個檔上傳失敗，其餘照傳，成功畫面列出沒傳上的檔。
        const result = await createThenUploadAll({
          files,
          create: () => createRequest(body),
          upload: (created, file) => uploadAttachment(created.requestId, file),
        });
        if (!result.ok) {
          setSubmitError(
            result.stage === "prepare"
              ? withFileName(result.file.name, describeError(result.error, "附件無法使用，請換一個檔案"), files.length > 1)
              : describeError(result.error, "送出失敗，請稍後再試"),
          );
          return;
        }
        const created = result.created;
        const uploadWarning = attachmentUploadWarning(
          result.failed.map(({ file, error }) => ({ name: file.name, reason: describeError(error, "上傳失敗") })),
          files.length,
        );
        invalidateEssState();
        showSuccess(created, summary, { uploadWarning, fillExpenseHref: fillExpenseHrefFor(body, created.requestId) });
        void loadRequests();
      } catch (err) {
        setSubmitError(describeError(err, "送出失敗，請稍後再試"));
      } finally {
        setSubmitting(false);
      }
    },
    [loadRequests, showSuccess],
  );

  // 自行墊付＋當場填的報銷明細：先準備憑證 → 建公出單 → 逐筆建報銷（綁公出單）＋傳憑證。
  // 公出單建立失敗才留在表單（什麼都沒建）；建好了就一律換成功畫面，報銷沒送成的在成功畫面說明、用「填報銷單」補——
  // 不會因為報銷失敗讓員工再按一次送出、多建一張公出單。
  const submitTripWithExpenses = useCallback(
    async (body: CreateRequestBody, summary: string, expenses: ReadyExpense[]) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const result = await fileTripWithExpenses({
          expenses,
          createTrip: () => createRequest(body),
          tripId: (created) => created.requestId,
          fileExpense: (expense) => fileExpense(expense),
          upload: (claim, file) => uploadExpenseReceipt(claim.id, file),
          rollback: (claim) => cancelExpense(claim.id, RECEIPT_AUTO_CANCEL_REASON),
        });
        if (!result.ok) {
          setSubmitError(
            result.stage === "prepare"
              ? `報銷第 ${result.index + 1} 筆的憑證無法使用：${expenseErrorMessage(result.error, "請換一個檔案", "upload")}（申請還沒送出）`
              : describeError(result.error, "送出失敗，請稍後再試"),
          );
          return;
        }
        if (result.failed.length > 0) console.warn("[申請] 公出單已建立，部分報銷沒送成", result.failed);
        // 憑證沒傳上、撤回也失敗而留下的報銷單：報銷頁只有一格「留下的單」，空著才記（下次在報銷頁送出會先撤回它）。
        let savedLeftover = false;
        const leftover = result.failed.find((f) => f.leftover)?.leftover;
        if (leftover) {
          const store = sessionStore();
          if (store && !readLeftoverClaim(store)) {
            saveLeftoverClaim(store, { id: leftover.id, period: leftover.period });
            savedLeftover = true;
          }
        }
        invalidateEssState();
        showSuccess(result.trip, summary, {
          uploadWarning: null,
          expenseOutcome: tripExpenseOutcome(result.filed, result.failed, (f) => failedExpenseReason(f, savedLeftover && f.leftover === leftover)),
          fillExpenseHref: tripExpenseHref(result.trip.requestId),
        });
        void loadRequests();
      } catch (err) {
        setSubmitError(describeError(err, "送出失敗，請稍後再試"));
      } finally {
        setSubmitting(false);
      }
    },
    [loadRequests, showSuccess],
  );

  const common = { initialDate, submitting, submitError, onSubmit: submit };

  function renderForm() {
    switch (kind) {
      case "leave":
        return (
          <LeaveForm
            key={`leave-${formKey}`}
            {...common}
            leaveTypes={leaveTypes}
            balances={balances}
            defaultShift={defaultShift}
            hoursPerDay={hoursPerDay}
          />
        );
      case "fix_punch":
        return <FixPunchForm key={`fix-${formKey}`} {...common} defaultShift={defaultShift} initialPunchType={initialPunchType} />;
      case "ot":
        return <OvertimeForm key={`ot-${formKey}`} {...common} />;
      case "business_trip":
        return (
          <TripForm
            key={`trip-${formKey}`}
            {...common}
            advanceThreshold={advanceThreshold}
            expenseCategories={expenseCategories}
            onSubmitWithExpenses={submitTripWithExpenses}
          />
        );
      default:
        return null;
    }
  }

  return (
    <div className="space-y-4">
      <KindSwitcher value={kind} onChange={changeKind} />

      {success ? (
        <SubmitSuccess
          approverName={success.approverName}
          summary={success.summary}
          uploadWarning={success.uploadWarning}
          expenseOutcome={success.expenseOutcome}
          fillExpenseHref={success.fillExpenseHref}
          onAgain={() => {
            setSuccess(null);
            setSubmitError(null);
            setFormKey((k) => k + 1);
          }}
          onViewList={() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        />
      ) : (
        <Card title={`${KIND_LABEL[kind]}申請`}>{renderForm()}</Card>
      )}

      <div ref={listRef} className="scroll-mt-20">
        <MyRequests
          requests={requests}
          loading={listLoading}
          error={listError}
          highlightId={urlId}
          defaultShift={defaultShift}
          hoursPerDay={hoursPerDay}
          tripClaims={tripClaims}
          onReload={loadRequests}
        />
      </div>
    </div>
  );
}

export default function RequestsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4">
          <Card>
            <Skeleton lines={5} />
          </Card>
          <Card title="我的申請">
            <Skeleton lines={4} />
          </Card>
        </div>
      }
    >
      <RequestsView />
    </Suspense>
  );
}
