"use client";

/**
 * 請假／申請 `/ess/requests?kind=…&date=…&id=…`
 *
 * 由上而下：①種類切換（請假｜補卡｜加班｜公出｜預支）②該種類的表單卡（只顯示該種類欄位；
 * HR 另有收合的「代同仁申請」）③送出後成功畫面取代表單（等待誰簽核＋摘要＋再填一張／查看我的申請）
 * ④「我的申請」清單（`GET /requests?scope=mine`）。
 *
 * 送出流程：`createRequest(body)` → 逐檔 `uploadAttachment` → `invalidateEssState()` → 成功畫面 → 列表重載。
 * 純函式（時數規則、body 組裝、清單文案）在 `@/lib/leave-hours` 與 `@/lib/request-forms`，有單元測試。
 * 頁框（頂部列／底列／gate／Toast）由 `ess/layout.tsx` 提供，本頁只回內容。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, Skeleton } from "@/components/ess-ui";
import {
  createRequest,
  getExpenseSettingsForMe,
  getLeaveBalances,
  getLeaveTypes,
  getRequests,
  getShifts,
  uploadAttachment,
  type CreateRequestBody,
  type LeaveBalance,
  type LeaveRequest,
  type LeaveType,
  type RequestKind,
  type Shift,
} from "@/lib/ess-api";
import { todayKey } from "@/lib/ess-format";
import { invalidateEssState, useEssState } from "@/lib/ess-state";
import { DEFAULT_SHIFT, type ShiftLike } from "@/lib/leave-hours";
import { KIND_LABEL, isRequestKind } from "@/lib/request-forms";
import { FixPunchForm } from "./_components/FixPunchForm";
import { KindSwitcher } from "./_components/KindSwitcher";
import { LeaveForm } from "./_components/LeaveForm";
import { MyRequests } from "./_components/MyRequests";
import { OvertimeForm } from "./_components/OvertimeForm";
import { PettyCashForm } from "./_components/PettyCashForm";
import { SubmitSuccess } from "./_components/SubmitSuccess";
import { TripForm } from "./_components/TripForm";
import { describeError, useProxy } from "./_components/form-shared";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SuccessInfo {
  approverName: string | null;
  summary: string;
  uploadWarning: string | null;
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

  const { isAdmin, me } = useEssState();
  const proxy = useProxy(isAdmin, me?.id);

  const [kind, setKind] = useState<RequestKind>(isRequestKind(urlKind) ? urlKind : "leave");
  // 外部改了網址（例如通知深連結）就跟著切；本頁自己切換時已先 setKind，這裡不會再觸發。
  useEffect(() => {
    if (isRequestKind(urlKind)) setKind(urlKind);
  }, [urlKind]);

  // 參考資料（best-effort：任何一支失敗都退化，不擋表單）
  const [leaveTypes, setLeaveTypes] = useState<LeaveType[] | null>(null);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [advanceThreshold, setAdvanceThreshold] = useState<number | null>(null);
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

  const loadRequests = useCallback(async () => {
    try {
      const res = await getRequests({ scope: "mine" });
      setRequests(res.requests ?? []);
      setListError(null);
    } catch (err) {
      setListError(describeError(err, "載入申請失敗"));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const [lt, bal, sh, cfg] = await Promise.allSettled([
        getLeaveTypes(),
        getLeaveBalances(),
        getShifts(),
        getExpenseSettingsForMe(),
      ]);
      if (!active) return;
      setLeaveTypes(lt.status === "fulfilled" ? (lt.value.leaveTypes ?? []) : []);
      if (bal.status === "fulfilled") setBalances(bal.value.balances ?? []);
      if (sh.status === "fulfilled") setShifts(sh.value.shifts ?? []);
      if (cfg.status === "fulfilled") setAdvanceThreshold(cfg.value.settings?.advanceThreshold ?? null);
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

  const submit = useCallback(
    async (body: CreateRequestBody, files: File[], summary: string) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const created = await createRequest(body);
        let uploadWarning: string | null = null;
        for (const file of files) {
          try {
            await uploadAttachment(created.requestId, file);
          } catch (err) {
            uploadWarning = `申請已送出，但附件「${file.name}」上傳失敗（${describeError(err, "上傳失敗")}）。請在下方「我的申請」補傳憑證。`;
            break;
          }
        }
        invalidateEssState();
        const steps = [...(created.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder);
        setSuccess({ approverName: steps[0]?.approverName ?? null, summary, uploadWarning });
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
        void loadRequests();
      } catch (err) {
        setSubmitError(describeError(err, "送出失敗，請稍後再試"));
      } finally {
        setSubmitting(false);
      }
    },
    [loadRequests],
  );

  const common = { initialDate, submitting, submitError, onSubmit: submit, proxy };

  function renderForm() {
    switch (kind) {
      case "leave":
        return (
          <LeaveForm
            key={`leave-${formKey}`}
            {...common}
            leaveTypes={leaveTypes}
            balances={balances}
            shifts={shifts}
            defaultShift={defaultShift}
            employeeId={me?.id}
          />
        );
      case "fix_punch":
        return <FixPunchForm key={`fix-${formKey}`} {...common} defaultShift={defaultShift} />;
      case "ot":
        return <OvertimeForm key={`ot-${formKey}`} {...common} />;
      case "business_trip":
        return <TripForm key={`trip-${formKey}`} {...common} advanceThreshold={advanceThreshold} />;
      case "petty_cash":
        return <PettyCashForm key={`pc-${formKey}`} {...common} advanceThreshold={advanceThreshold} />;
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
