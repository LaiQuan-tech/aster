"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getAnnouncements,
  getPunchToday,
  getRequests,
  isPunchTooSoon,
  lateReasonRequiredOf,
  postPunch,
  type LateReasonRequired,
  type PunchResult,
} from "@/lib/ess-api";
import { fmtHm, todayKey, weekdayLabel } from "@/lib/ess-format";
import { LATE_REASON_MAX, lateReasonError, lateReasonPrompt } from "@/lib/late-reason";
import {
  PENDING_FIX_PUNCH_CELL_SUFFIX,
  forgotPunchInHref,
  pendingFixPunchWithdrawn,
  precheckPendingFixPunch,
  summarizeWithPendingFixPunch,
  withPendingFixPunch,
  type PendingAwareSummary,
  type PendingFixPunchRequestLike,
} from "@/lib/pending-fix-punch";
import { describePeriodClosed } from "@/lib/period-closed";
import {
  needsAnnouncementHint,
  precheckPunch,
  shouldApplyPolledPunches,
  summarizePunches,
  type PunchLike,
  type PunchPrecheck,
} from "@/lib/punch-state";
import { runWhileVisible } from "@/lib/visible-interval";
import { getMeCached, peekMeCached } from "@/lib/ess-state";
import { WFH_SUFFIX, browserStorage, hasWfhPunch, readWfhChoice, wfhPunchEnabled, writeWfhChoice } from "@/lib/wfh-punch";
import { BottomSheet, Button, Card, Icon, InlineError, Textarea, useToast } from "@/components/ess-ui";
import { OvertimeCapCard } from "./_components/OvertimeCapCard";
import { DutyTodayCard } from "./_components/DutyTodayCard";

/**
 * 打卡首頁 `/ess`：日期時鐘、大打卡鈕、今日上下班時間、本月加班累計（M1，WP1 填）、
 * 今日值日／總機（M8，WP8 填）、需簽收公告提示。
 * 頁框（頂部列、底部分頁、登入守門、ToastProvider）由 `ess/layout.tsx` 提供，這裡不再包。
 *
 * 載入順序：`GET /punch/today` 最先且獨立（失敗 → InlineError＋重試，鈕 disabled）；
 * 公告是加分項，在打卡狀態之後才抓、失敗不影響。GPS 在 mount 時預抓存 ref，
 * 按下時 ≤2 分鐘的定位直接用，否則最多再等 3 秒，沒有就 `source:"web"`——來源不顯示。
 *
 * 遲到理由（2026-10-11）：當天第一張上班卡遲到（沒排班的工作日晚於 10:00、有排班晚於班別上班時間）
 * 伺服器回 400 late_reason_required、不寫打卡 → 底部彈出對話框「你今天 HH:MM 上班，超過 10:00
 * （遲到 N 分鐘），請填寫原因（主管與老闆會看到）」＋多行輸入；送出時沿用剛才取得的定位、帶
 * `lateReason` 重送；取消就不打卡。
 *
 * 畫面過期防呆（2026-10-12）：伺服器照前端送的 type 寫入，畫面停在舊狀態（例如主管剛核准補上班卡，
 * 按鈕還是「上班打卡」）就會寫出第二張 in，而打卡紀錄不能硬刪。所以
 *   ① 畫面可見時每 60 秒安靜重抓 `/punch/today`，隱藏就停，回到前景先立刻對齊再恢復計時；
 *      打卡送出中與成功後鎖定期不發，晚到的舊回應用序號丟掉，不會蓋掉樂觀更新。
 *   ② 按下打卡時跟定位並行再抓一次（最多等 3 秒），用 `precheckPunch`（lib/punch-state.ts）跟按下當時的畫面比對：
 *      種類變了、或多了畫面上沒有的 in／out（例如主管同時核准補上班＋補下班）就不送、畫面換成最新狀態並提示、
 *      短暫鎖鈕；抓不到就照畫面送，不擋打卡。遲到理由對話框的「送出並打卡」重送前也照樣確認一次（對話框可能
 *      開了一陣子），比對的是當初按下時的畫面（pendingScreenRef）。
 *   ①② 都只認「正面證據」：今天還沒有任何 in／out（例如加班過午夜，`/punch/today` 已換到新的一天）不算
 *      新證據——輪詢不把「上班中」蓋成空的、預檢照畫面送 out（伺服器照收，結算把過午夜的下班卡歸到上班那天）。
 *      但畫面上的上班卡已超過 16 小時（STALE_WORKING_MS）就當成已換日：輪詢的空紀錄照常套用、預檢不送下班卡
 *      （按鈕改回「上班打卡」並提示另送補卡；查不到最新狀態就整個重新載入）。進頁與回到前景的重抓照舊整個套用。
 *
 * 待核准的上班補卡（2026-10-12 業主拍板）：忘了打上班卡的人送出補卡後，不用等主管核准就能照常打下班卡。
 * 每次抓 `/punch/today` 時並行抓 `GET /requests?scope=mine&status=pending&kind=fix_punch`（最多等 3 秒）；今天有
 * 本人待簽核的補上班卡、今天又沒有真的上班卡，就把它當成一張「暫定上班卡」併進畫面紀錄（lib/pending-fix-punch.ts，
 * 再交給上面同一套 punch-state 函式）→ 狀態「上班中・補卡待核准（08:52）」、按鈕「下班打卡」送 type=out、
 * 「上班」欄「08:52（待核准）」。抓不到待簽核單：403（沒開「請假」分頁）→ 這次進頁不再抓、照舊行為；
 * 斷線／逾時 → 沿用上次抓到的結果（一開始＝沒有）。主管核准後照舊補一筆人工上班卡（打卡前預檢以種類＋時刻
 * 認得是同一張）；駁回的話那天有下班卡、沒上班卡，月表顯示「缺上班卡」（預期行為）。
 * 遲到理由對話框多一顆「早上有到，只是忘了打卡」：不打卡、關掉對話框，帶去補卡單（預選上班、日期今天）；
 * 待簽核單回過 403（沒開「請假」分頁、送不了補卡單）就不顯示這顆。
 * 審查回饋（同日）：①輪詢這次有抓到待簽核單、今天那張補卡已撤回／駁回 → 直接套用新紀錄回到「上班打卡」（過午夜照舊保留）；
 * ②送上班卡前一併重抓待簽核單，今天已有待核准的上班補卡就不送、畫面換成「上班中・補卡待核准」並提示按下班打卡；
 * ③今天另有更晚的待核准補下班卡 → 不當成上班中（lib/pending-fix-punch.ts）。
 */

/* ------------------------------------------------------------ 定位 --- */

interface GeoFix {
  lat: number;
  lng: number;
  /** 取得時間（ms since epoch），判斷新不新鮮用。 */
  at: number;
}

/**
 * 定位失敗原因；沒拿到座標時隨打卡送給後端記錄（punch_records.geo_status，
 * migrations/0051），後台打卡紀錄的「地點」欄靠這個顯示「—（原因）」
 * （lib/punch-location-reason.ts）而不是只顯示一個「—」。
 */
type GeoStatus = "denied" | "unavailable" | "timeout" | "unsupported";

/** GeolocationPositionError.code → GeoStatus：1 拒絕權限｜3 逾時｜其餘（含 2）歸「裝置拿不到位置」。 */
function geoErrorStatus(err: GeolocationPositionError): GeoStatus {
  if (err.code === err.PERMISSION_DENIED) return "denied";
  if (err.code === err.TIMEOUT) return "timeout";
  return "unavailable";
}

/** 按下打卡時，ref 裡 ≤2 分鐘的定位直接用，不再等。 */
const FIX_FRESH_MS = 2 * 60_000;
/** 沒有新鮮定位時，按下後最多再等這麼久；逾時就以 web 來源送出。 */
const PUNCH_FIX_WAIT_MS = 3_000;
/**
 * 成功後鎖住按鈕的時間，擋手抖連按。伺服器另有冷卻（預設 1 秒，env PUNCH_COOLDOWN_SECONDS 可調；
 * apps/api/src/services/punch-guard.ts），冷卻內重按回 409 punch_too_soon。
 */
const AFTER_SUCCESS_LOCK_MS = 3_000;
/** 畫面可見時，每隔這麼久安靜重抓一次今日打卡（主管核准補卡後按鈕才跟得上）。 */
const PUNCH_POLL_MS = 60_000;
/** 按下打卡時確認最新狀態最多等這麼久（跟定位並行）；逾時或失敗就照畫面上的種類送出。 */
const PUNCH_PRECHECK_WAIT_MS = 3_000;
/** 預檢發現狀態變了（沒送出、按鈕換了種類）後鎖鈕的時間：擋連點把另一種卡直接送出去，也讓人看一下提示。 */
const AFTER_PRECHECK_LOCK_MS = 2_000;
/** 抓待簽核補卡單最多等這麼久（跟 `/punch/today` 並行）；逾時就沿用上次的結果，不讓它拖住打卡鈕。 */
const PENDING_FIX_WAIT_MS = 3_000;

const PREFETCH_OPTS: PositionOptions = { maximumAge: 60_000, timeout: 8_000, enableHighAccuracy: false };
const ON_PUNCH_OPTS: PositionOptions = { maximumAge: FIX_FRESH_MS, timeout: PUNCH_FIX_WAIT_MS, enableHighAccuracy: false };

/**
 * 要一次定位；拿不到（無 API、拒絕、逾時）→ null，絕不 reject。
 * `hardTimeoutMs`：瀏覽器的 `timeout` 在使用者還沒回答權限提示前不會起算，
 * 按下打卡時另外用自己的計時器保證最多只等這麼久；預抓不設。
 * `onFix`：任何一次成功定位（包含逾時後才到的）都會呼叫，讓晚到的結果仍能存進 ref 供下次用。
 * `onFail`：拿不到定位時回報一次原因（2026-09-30 起打卡要把原因存進
 * punch_records.geo_status）；純粹是多一個 side-channel，「絕不 reject」的契約不變，
 * resolve 值仍然只有 fix 或 null。
 */
function requestFix(
  opts: PositionOptions,
  hardTimeoutMs?: number,
  onFix?: (fix: GeoFix) => void,
  onFail?: (status: GeoStatus) => void,
): Promise<GeoFix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      onFail?.("unsupported");
      resolve(null);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fix: GeoFix | null, status?: GeoStatus) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!fix) onFail?.(status ?? "unavailable");
      resolve(fix);
    };
    if (hardTimeoutMs && hardTimeoutMs > 0) timer = setTimeout(() => finish(null, "timeout"), hardTimeoutMs);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const fix: GeoFix = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            at: pos.timestamp || Date.now(),
          };
          onFix?.(fix);
          finish(fix);
        },
        (err) => finish(null, geoErrorStatus(err)),
        opts,
      );
    } catch {
      finish(null, "unavailable");
    }
  });
}

/* ------------------------------------------------------ 打卡前確認 --- */

/**
 * 按下打卡時確認最新狀態：抓 `GET /punch/today` 的紀錄；失敗或超過 `waitMs` → null，絕不 reject
 * （呼叫端交給 precheckPunch：null＝照畫面上的種類送出，不因為查不到就擋打卡；只有畫面「上班中」而上班卡
 * 已超過 16 小時例外，改成重新載入）。
 */
function fetchTodayRecords(waitMs: number): Promise<PunchLike[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (records: PunchLike[] | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(records);
    };
    timer = setTimeout(() => finish(null), waitMs);
    getPunchToday().then(
      (today) => finish(Array.isArray(today?.records) ? today.records : null),
      () => finish(null),
    );
  });
}

/**
 * 抓本人待簽核的補卡單（`GET /requests?scope=mine&status=pending&kind=fix_punch`），首頁拿來判斷「今天有沒有
 * 待核准的上班補卡」（lib/pending-fix-punch.ts）。成功 → 清單；403（沒開「請假」分頁，API essTabGuard 擋）→
 * "forbidden"；其他失敗或超過 `waitMs` → null。絕不 reject。
 */
function fetchPendingFixPunches(waitMs: number): Promise<PendingFixPunchRequestLike[] | "forbidden" | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: PendingFixPunchRequestLike[] | "forbidden" | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish(null), waitMs);
    getRequests({ scope: "mine", status: "pending", kind: "fix_punch" }).then(
      (res) => finish(Array.isArray(res?.requests) ? res.requests : null),
      (err: unknown) => finish((err as { status?: unknown } | null)?.status === 403 ? "forbidden" : null),
    );
  });
}

/**
 * useState＋同步更新的 ref：計時器／事件 callback 讀 `ref.current` 一定是最新值，不用等重新渲染。
 * 背景輪詢靠它判斷「現在能不能動畫面」（載入中、打卡送出中、鎖定期都不行）。
 */
function useStateRef<T>(initial: T): [T, (next: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, set, ref];
}

/* ------------------------------------------------------------ 文案 --- */

const PUNCH_ERROR_MESSAGES: Record<string, string> = {
  not_an_employee: "此帳號尚未對應到員工資料，無法打卡",
  unauthorized: "登入已逾期，請重新登入",
  invalid_body: "送出的內容格式不正確",
  wfh_punch_not_enabled: "你尚未開通「在家上班」打卡，請取消勾選或洽管理員",
};

/**
 * apiFetch 的錯誤訊息是 `[status] code`；認得的 code 轉中文，網路斷線另外講，其餘照原文。
 * 當下所在的月份已發薪鎖定（提早結算的特例）→ POST /punch 回 409 period_closed →
 * 「YYYY-MM 已結算，請洽管理者」，不顯示 `[409] period_closed`。
 */
function punchErrorMessage(err: unknown, fallback: string): string {
  const closed = describePeriodClosed(err);
  if (closed) return closed;
  if (err instanceof TypeError) return "連線失敗，請確認網路後再試一次";
  if (err instanceof Error && err.message) {
    const code = err.message.replace(/^\[\d+\]\s*/, "").trim();
    return PUNCH_ERROR_MESSAGES[code] ?? err.message;
  }
  return fallback;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/* ------------------------------------------------------------ Clock --- */

/** 「9月18日（四）」＋秒級時鐘。mount 後才渲染，避免 SSR 與瀏覽器時區／秒數對不上。 */
function Clock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(id);
  }, []);

  let dateLabel = " ";
  let timeLabel = " ";
  if (now) {
    const key = todayKey(undefined, now);
    const [, m = "0", d = "0"] = key.split("-");
    dateLabel = `${Number(m)}月${Number(d)}日（${weekdayLabel(key)}）`;
    timeLabel = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  }

  return (
    <div className="pt-2 text-center">
      <p className="min-h-6 text-base text-gray-500">{dateLabel}</p>
      <p className="mt-1 min-h-12 text-5xl font-semibold tabular-nums tracking-tight text-gray-900">{timeLabel}</p>
    </div>
  );
}

/* -------------------------------------------------------- PunchCard --- */

function PunchCard({
  summary,
  loading,
  loadError,
  punching,
  locked,
  punchError,
  notice,
  onPunch,
  onRetryLoad,
  wfhEnabled,
  wfh,
  todayWfh,
  onWfhChange,
}: {
  summary: PendingAwareSummary;
  loading: boolean;
  loadError: string | null;
  punching: boolean;
  locked: boolean;
  punchError: string | null;
  /** 預檢發現狀態變了、沒送出時的提示（不是錯誤，不給重試鈕：要員工看清楚新按鈕再按）。 */
  notice: string | null;
  onPunch: () => void;
  onRetryLoad: () => void;
  /** 2026-10-13：本人有開通在家上班打卡（/me features.wfhPunch）才顯示勾選框。 */
  wfhEnabled: boolean;
  wfh: boolean;
  /** 今天已有在家上班的打卡 → 狀態列加「（在家）」。 */
  todayWfh: boolean;
  onWfhChange: (checked: boolean) => void;
}) {
  const disabled = loading || !!loadError || punching || locked;
  const label = loading ? "載入中…" : punching ? "打卡中…" : summary.nextLabel;
  // 待核准的上班補卡撐起的「上班中」：statusLabel 已是「上班中・補卡待核准（08:52）」，不再接「· 自 HH:MM」。
  const baseStatus = loading
    ? " "
    : summary.phase === "working" && summary.workingSince && !summary.workingOnPending
      ? `${summary.statusLabel} · 自 ${fmtHm(summary.workingSince)}`
      : summary.statusLabel;
  const status = !loading && todayWfh ? `${baseStatus}${WFH_SUFFIX}` : baseStatus;

  return (
    <Card>
      <Button
        size="lg"
        block
        variant={summary.phase === "done" ? "secondary" : "primary"}
        className="py-4"
        disabled={disabled}
        loading={punching}
        onClick={onPunch}
      >
        <span className="text-2xl font-bold">{label}</span>
      </Button>
      {wfhEnabled && (
        <label className="mt-3 flex items-center justify-center gap-2 text-base text-gray-700">
          <input
            type="checkbox"
            className="h-5 w-5"
            checked={wfh}
            disabled={punching}
            onChange={(e) => onWfhChange(e.target.checked)}
          />
          在家上班
        </label>
      )}
      <p className="mt-3 min-h-5 text-center text-sm text-gray-500" aria-live="polite">
        {status}
      </p>
      {!loadError && notice && (
        <p role="status" className="mt-2 text-center text-sm font-medium text-amber-700">
          {notice}
        </p>
      )}
      {loadError && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <InlineError>{loadError}</InlineError>
          <Button variant="secondary" size="sm" onClick={onRetryLoad}>
            重試
          </Button>
        </div>
      )}
      {!loadError && punchError && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <InlineError>{punchError}</InlineError>
          <Button variant="secondary" size="sm" onClick={onPunch} disabled={punching || locked}>
            重試
          </Button>
        </div>
      )}
      {/* 告知：打卡會存座標（GPS）與來源 IP（後端 POST /punch 記 punch_records.ip_address），IP 只有 HR 看得到。 */}
      <p className="mt-2 text-center text-xs text-gray-500">打卡時會記錄位置與網路 IP，供公司查核出勤</p>
    </Card>
  );
}

/* ------------------------------------------------------- TodayTimes --- */

function TodayTimes({ summary, loading }: { summary: PendingAwareSummary; loading: boolean }) {
  const cell = (iso: string | null) => (loading ? "…" : iso ? fmtHm(iso) : "—");
  // 「上班」是待核准的上班補卡：顯示補卡單上的時間＋「（待核准）」。
  const pendingIn = !loading && summary.firstInPending ? summary.pendingIn : null;
  return (
    <Card title="今日">
      <dl className="grid grid-cols-2 divide-x divide-gray-100 text-center">
        <div className="px-2">
          <dt className="text-xs font-medium text-gray-400">上班</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
            {pendingIn ? (
              <>
                {pendingIn.hm}
                <span className="ml-0.5 align-middle text-sm font-medium text-amber-700">{PENDING_FIX_PUNCH_CELL_SUFFIX}</span>
              </>
            ) : (
              cell(summary.firstInAt)
            )}
          </dd>
        </div>
        <div className="px-2">
          <dt className="text-xs font-medium text-gray-400">下班</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{cell(summary.lastOutAt)}</dd>
        </div>
      </dl>
      {summary.inOutCount > 2 && (
        <Link
          href="/ess/punches"
          className="mt-3 block text-center text-sm text-gray-500 underline-offset-2 hover:underline"
        >
          今日共 {summary.inOutCount} 筆 · 查看打卡紀錄 →
        </Link>
      )}
    </Card>
  );
}

/* ------------------------------------------------- AnnouncementHint --- */

function AnnouncementHint({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Link
      href="/ess/announcements"
      className="flex min-h-12 items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 active:bg-amber-100"
    >
      <span className="flex items-center gap-2">
        <Icon name="bell" className="h-5 w-5 shrink-0" />
        有 {count} 則需簽收的公告，請前往查看
      </span>
      <Icon name="chevron" className="h-5 w-5 shrink-0 text-amber-700" />
    </Link>
  );
}

/* --------------------------------------------------- LateReasonSheet --- */

/**
 * 遲到理由對話框（手機從底部滑出）：說明＋多行輸入＋「送出並打卡」／「早上有到，只是忘了打卡」／「取消」。
 * 「早上有到，只是忘了打卡」（2026-10-12）：不打卡、關掉對話框，帶去補卡單（預選上班、日期今天）；送出補卡回到
 * 首頁就是「下班打卡」（待核准的上班補卡當作已上班，見檔頭）。
 */
function LateReasonSheet({
  info,
  value,
  error,
  submitting,
  onChange,
  onSubmit,
  onForgotPunch,
  onCancel,
}: {
  info: LateReasonRequired | null;
  value: string;
  error: string | null;
  submitting: boolean;
  onChange: (next: string) => void;
  onSubmit: () => void;
  /** 沒給（沒開「請假」分頁、送不了補卡單）就不顯示「早上有到，只是忘了打卡」。 */
  onForgotPunch?: () => void;
  onCancel: () => void;
}) {
  const length = value.trim().length;
  return (
    <BottomSheet open={info !== null} onClose={submitting ? () => undefined : onCancel} title="請填寫遲到原因">
      {info && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <p className="text-base leading-relaxed text-gray-800">{lateReasonPrompt(info)}</p>
          <div>
            <label htmlFor="late-reason" className="sr-only">
              遲到原因
            </label>
            <Textarea
              id="late-reason"
              rows={4}
              value={value}
              maxLength={LATE_REASON_MAX + 50}
              placeholder="例如：捷運延誤、送小孩看醫生"
              onChange={(event) => onChange(event.target.value)}
              aria-invalid={error ? true : undefined}
              className="text-base"
            />
            <p className="mt-1 text-right text-xs tabular-nums text-gray-400">
              {length}／{LATE_REASON_MAX}
            </p>
          </div>
          {error && <InlineError>{error}</InlineError>}
          <div className="flex flex-col gap-2 pt-1">
            <Button type="submit" size="lg" block loading={submitting} disabled={submitting}>
              送出並打卡
            </Button>
            {onForgotPunch && (
              <Button type="button" variant="secondary" size="lg" block disabled={submitting} onClick={onForgotPunch}>
                早上有到，只是忘了打卡
              </Button>
            )}
            <Button type="button" variant="secondary" size="lg" block disabled={submitting} onClick={onCancel}>
              取消（不打卡）
            </Button>
          </div>
        </form>
      )}
    </BottomSheet>
  );
}

/* ---------------------------------------------------------- EssHome --- */

export default function EssHome() {
  const toast = useToast();
  const router = useRouter();
  /** 今天的打卡紀錄；有待核准的上班補卡時多一張暫定上班卡（withPendingFixPunch，沒有 id）。 */
  const [records, setRecords] = useState<PunchLike[]>([]);
  // loading／punching／locked／lateSubmitting 另有同步的 ref：背景輪詢在計時器裡讀，判斷現在能不能動畫面。
  const [loading, setLoading, loadingRef] = useStateRef(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [punching, setPunching, punchingRef] = useStateRef(false);
  const [locked, setLocked, lockedRef] = useStateRef(false);
  const [punchError, setPunchError] = useState<string | null>(null);
  /** 預檢發現狀態變了、沒送出時的提示（下一次按打卡時清掉）。 */
  const [punchNotice, setPunchNotice] = useState<string | null>(null);
  const [hintCount, setHintCount] = useState(0);
  // 遲到理由對話框：伺服器回 late_reason_required 時打開；pendingBody＝剛才那次打卡的內容（含定位），
  // 送出理由時原樣重送。
  const [lateInfo, setLateInfo] = useState<LateReasonRequired | null>(null);
  const [lateReason, setLateReason] = useState("");
  const [lateError, setLateError] = useState<string | null>(null);
  const [lateSubmitting, setLateSubmitting, lateSubmittingRef] = useStateRef(false);
  const pendingBodyRef = useRef<Parameters<typeof postPunch>[0] | null>(null);
  /** 送出 pendingBodyRef 那次按下當時畫面上的紀錄：遲到理由重送前的預檢跟它比（對話框開著時輪詢可能已改了畫面）。 */
  const pendingScreenRef = useRef<readonly PunchLike[]>([]);

  const fixRef = useRef<GeoFix | null>(null);
  /** 最近一次定位失敗的原因；預抓或按下打卡任一次失敗都會覆蓋，送出打卡時撈最新值。 */
  const geoStatusRef = useRef<GeoStatus | null>(null);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  /**
   * 今日打卡的載入序號：每次抓 `/punch/today` +1；打卡流程自己改畫面時（按下打卡、送出遲到理由、
   * 樂觀更新、預檢抓到新狀態）也 +1。回應回來時序號不是最新的就丟掉——按下打卡前發出、晚到的
   * 背景輪詢回應不能把樂觀更新蓋回「上班打卡」。
   */
  const loadSeqRef = useRef(0);
  /**
   * 最近一次抓到的本人待簽核補卡單（抓不到就沿用上次的；一開始 null＝沒有）。每次把紀錄放進畫面前都用它併上
   * 暫定上班卡（mergePending）。
   */
  const pendingFixRef = useRef<readonly PendingFixPunchRequestLike[] | null>(null);
  /** GET /requests 回過 403（沒開「請假」分頁）：這次進頁不再抓，照舊行為。 */
  const pendingForbiddenRef = useRef(false);
  /** 同上（給畫面用）：沒開「請假」分頁就送不了補卡單，遲到對話框不顯示「早上有到，只是忘了打卡」。 */
  const [fixPunchForbidden, setFixPunchForbidden] = useState(false);

  const summary = useMemo(() => summarizeWithPendingFixPunch(records), [records]);

  // 在家上班打卡（2026-10-13）：只有 /me features.wfhPunch 開通的員工看得到勾選框；勾選狀態記住「今天」。
  const [wfhEnabled, setWfhEnabled] = useState(() => wfhPunchEnabled(peekMeCached()));
  const [wfh, setWfh] = useState(false);
  useEffect(() => {
    setWfh(readWfhChoice(browserStorage(), todayKey()));
    getMeCached()
      .then((me) => {
        if (activeRef.current) setWfhEnabled(wfhPunchEnabled(me));
      })
      .catch(() => {
        /* 抓不到 /me 就不顯示勾選框（照一般打卡） */
      });
  }, []);
  const onWfhChange = useCallback((checked: boolean) => {
    setWfh(checked);
    writeWfhChoice(browserStorage(), todayKey(), checked);
  }, []);
  const todayWfh = useMemo(() => hasWfhPunch(records), [records]);

  /** 今天的真紀錄＋（有的話）待核准的上班補卡 → 畫面紀錄（lib/pending-fix-punch.ts）。 */
  const mergePending = useCallback(
    (list: ReadonlyArray<PunchLike>) => withPendingFixPunch(list, pendingFixRef.current, todayKey()),
    [],
  );

  /**
   * 送上班卡前一併重抓待簽核單（最多等 3 秒，不會 reject）：抓到就更新 pendingFixRef（403 → 不再抓），
   * 回傳這次抓到的清單；沒抓到 → null（預檢照常送，不擋打卡）。
   */
  const refetchPendingForPunch = useCallback(async (): Promise<readonly PendingFixPunchRequestLike[] | null> => {
    if (pendingForbiddenRef.current) return null;
    const pending = await fetchPendingFixPunches(PUNCH_PRECHECK_WAIT_MS);
    if (pending === "forbidden") {
      pendingForbiddenRef.current = true;
      pendingFixRef.current = null;
      setFixPunchForbidden(true);
      return null;
    }
    if (pending) pendingFixRef.current = pending;
    return pending;
  }, []);


  /**
   * 抓 `/punch/today`。`quiet`＝背景對齊（不動 loading、失敗不顯示）。只有最後發出的那次能改畫面（loadSeqRef）。
   * `poll`＝每 60 秒的背景輪詢（隱含 quiet）：只認正面證據——拿到空紀錄而畫面正在上班中（加班過午夜）就維持畫面，
   * 上班卡已超過 16 小時才照常套用（shouldApplyPolledPunches）；進頁、回到前景、打卡後的對齊照舊整個套用。
   */
  const loadPunch = useCallback(
    async (opts?: { quiet?: boolean; poll?: boolean }) => {
      const poll = opts?.poll === true;
      const quiet = opts?.quiet === true || poll;
      const seq = ++loadSeqRef.current;
      if (!quiet) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        // 待簽核補卡單跟今日打卡並行抓（不會 reject、最多等 3 秒）：今天的上班補卡還沒核准也當作已上班。
        const [today, pending] = await Promise.all([
          getPunchToday(),
          pendingForbiddenRef.current ? Promise.resolve(null) : fetchPendingFixPunches(PENDING_FIX_WAIT_MS),
        ]);
        if (!activeRef.current || seq !== loadSeqRef.current) return;
        if (pending === "forbidden") {
          pendingForbiddenRef.current = true;
          pendingFixRef.current = null;
          setFixPunchForbidden(true);
        } else if (pending) {
          pendingFixRef.current = pending;
        }
        const next = mergePending(today.records);
        // 輪詢比的是併過暫定上班卡的紀錄：補卡撐起的「上班中」跟真的上班卡一樣，空紀錄（過午夜）不蓋掉。
        // 例外：這次有抓到待簽核單、今天的那張補卡已不在（撤回／駁回）→ 直接套用，回到「上班打卡」。
        const pendingFresh = pending !== null;
        const day = todayKey();
        if (poll) {
          setRecords((prev) =>
            shouldApplyPolledPunches(prev, next, Date.now()) || (pendingFresh && pendingFixPunchWithdrawn(prev, next, day))
              ? next
              : prev,
          );
        } else setRecords(next);
        setLoadError(null);
      } catch (err) {
        if (!activeRef.current || quiet || seq !== loadSeqRef.current) return;
        setLoadError(punchErrorMessage(err, "載入打卡狀態失敗"));
      } finally {
        // 非 quiet 的載入只會被另一次非 quiet 載入取代（載入中不發背景對齊、也不能打卡），由最新那次收尾。
        if (activeRef.current && !quiet && seq === loadSeqRef.current) setLoading(false);
      }
    },
    [setLoading, mergePending],
  );

  /**
   * 背景對齊：`poll`＝每 60 秒輪詢（只認正面證據）、`visible`＝回到前景（照舊整個套用）。載入中、打卡送出中
   * （含帶遲到理由重送）、成功或預檢後的鎖定期都不發——這段期間畫面只由打卡流程自己更新。
   */
  const refreshQuietly = useCallback(
    (mode: "poll" | "visible") => {
      if (loadingRef.current || punchingRef.current || lockedRef.current || lateSubmittingRef.current) return;
      void loadPunch(mode === "poll" ? { poll: true } : { quiet: true });
    },
    [loadPunch, loadingRef, punchingRef, lockedRef, lateSubmittingRef],
  );

  /** 短暫鎖住打卡鈕（成功後擋手抖連按；預檢中止後擋連點把另一種卡直接送出去）。 */
  const lockFor = useCallback(
    (ms: number) => {
      setLocked(true);
      if (lockTimer.current) clearTimeout(lockTimer.current);
      lockTimer.current = setTimeout(() => {
        lockTimer.current = null;
        if (activeRef.current) setLocked(false);
      }, ms);
    },
    [setLocked],
  );

  /**
   * 預檢沒送出（precheckPunch 回 send:false）：顯示提示、短暫鎖鈕，畫面換成最新紀錄；查不到最新紀錄而畫面又
   * 過期（unverified：上班卡已超過 16 小時）就整個重新載入（載入中鈕會鎖住，失敗給重試）。
   * 序號 +1：在這之前發出的背景抓取作廢，不會把最新紀錄蓋回去。
   */
  const abortStalePunch = useCallback(
    (check: Extract<PunchPrecheck, { send: false }>) => {
      loadSeqRef.current += 1;
      setPunchNotice(check.notice);
      lockFor(AFTER_PRECHECK_LOCK_MS);
      if (check.latest) setRecords(mergePending(check.latest));
      else void loadPunch();
    },
    [lockFor, loadPunch, mergePending],
  );

  /**
   * 送上班卡前的補卡預檢沒過（今天已有待核准的上班補卡）：不送，畫面換成「上班中・補卡待核准」並提示按下班打卡。
   * 回傳 true＝已中止。
   */
  const abortForPendingFixPunch = useCallback(
    (
      type: "in" | "out",
      screen: ReadonlyArray<PunchLike>,
      latest: ReadonlyArray<PunchLike> | null,
      pending: readonly PendingFixPunchRequestLike[] | null,
    ): boolean => {
      const hit = precheckPendingFixPunch(type, screen, latest, pending, todayKey());
      if (!hit) return false;
      loadSeqRef.current += 1;
      setPunchNotice(hit.notice);
      lockFor(AFTER_PRECHECK_LOCK_MS);
      setRecords(hit.records);
      return true;
    },
    [lockFor],
  );

  useEffect(() => {
    activeRef.current = true;
    // GPS 預抓：結果（含晚到的）直接進 ref，按下時就不用等；失敗原因也記下來。
    void requestFix(
      PREFETCH_OPTS,
      undefined,
      (fix) => {
        fixRef.current = fix;
      },
      (status) => {
        geoStatusRef.current = status;
      },
    );
    (async () => {
      await loadPunch();
      // 公告是加分項：在打卡狀態之後才抓，失敗不影響首頁。
      try {
        const res = await getAnnouncements();
        if (activeRef.current) setHintCount(needsAnnouncementHint(res.announcements));
      } catch {
        /* 沒有提示就是了 */
      }
    })();
    return () => {
      activeRef.current = false;
      if (lockTimer.current) {
        clearTimeout(lockTimer.current);
        lockTimer.current = null;
      }
    };
  }, [loadPunch]);

  // 背景對齊：畫面可見時每 60 秒安靜重抓一次今日狀態（主管核准補卡後按鈕才會跟上；空紀錄不蓋掉上班中）；
  // 收到背景就停，回到前景（PWA 放隔夜是常態）先立刻照舊對齊一次，再重新起算。卸載時清掉計時器與監聽
  // （lib/visible-interval.ts）。
  useEffect(
    () =>
      runWhileVisible(
        document,
        PUNCH_POLL_MS,
        () => refreshQuietly("poll"),
        () => refreshQuietly("visible"),
      ),
    [refreshQuietly],
  );

  /** 打卡成功（含帶理由重送成功）：樂觀更新、Toast、震動、短暫鎖鈕、背景對齊。 */
  const afterPunchSuccess = useCallback(
    async (res: PunchResult) => {
      // 先用回傳的 record 樂觀更新，再背景抓 /punch/today 對齊。序號先 +1：在這之前發出、晚到的
      // 抓取回應一律丟掉，不會把這筆樂觀更新蓋回去。
      const rec: PunchLike = res.record ?? { type: res.type, punch_at: res.punchAt };
      loadSeqRef.current += 1;
      // 重新併一次暫定上班卡：補卡撐起的上班中按了下班 → 今日已下班（上班欄仍顯示待核准的時間）。
      setRecords((prev) => mergePending([...prev, rec]));
      const lateNote = res.lateReport ? "（已送出遲到說明）" : "";
      const wfhNote = res.wfh ? WFH_SUFFIX : "";
      toast.show(`${rec.type === "in" ? "上班" : "下班"}打卡成功 ${fmtHm(rec.punch_at)}${wfhNote}${lateNote}`, "success");
      try {
        navigator.vibrate?.(30);
      } catch {
        /* 不支援就算了 */
      }
      lockFor(AFTER_SUCCESS_LOCK_MS);
      await loadPunch({ quiet: true });
    },
    [toast, loadPunch, lockFor, mergePending],
  );

  const onPunch = useCallback(async () => {
    if (punching || locked || loading || loadError) return;
    // 一律送明確 type，伺服器不猜：由按下當時畫面上的紀錄推出，送出前先跟最新紀錄比對（precheckPunch）
    const screen = records;
    loadSeqRef.current += 1; // 按下前發出、還沒回來的背景抓取作廢：打卡流程期間畫面只由這裡更新
    setPunching(true);
    setPunchError(null);
    setPunchNotice(null);
    try {
      const cached = fixRef.current;
      const fixPromise: Promise<GeoFix | null> =
        cached && Date.now() - cached.at <= FIX_FRESH_MS
          ? Promise.resolve(cached)
          : requestFix(
              ON_PUNCH_OPTS,
              PUNCH_FIX_WAIT_MS,
              (late) => {
                fixRef.current = late;
              },
              (status) => {
                geoStatusRef.current = status;
              },
            );
      // 打卡前確認最新狀態：跟定位並行抓 /punch/today（最多等 3 秒）。畫面過期（例如主管剛核准補卡、
      // 隔夜的「上班中」）就不送，畫面換成最新狀態＋提示＋短暫鎖鈕；抓不到（null）照畫面上的種類送，不擋打卡
      // （畫面「上班中」而上班卡已超過 16 小時例外：重新載入）。
      // 畫面要送上班卡時一併重抓待簽核單：今天已送出上班補卡（例如剛在別的分頁送）就不送，避免多一張上班卡。
      const wantsIn = summarizePunches(screen).nextType === "in";
      const [fix, latest, freshPending] = await Promise.all([
        fixPromise,
        fetchTodayRecords(PUNCH_PRECHECK_WAIT_MS),
        wantsIn ? refetchPendingForPunch() : Promise.resolve(null),
      ]);
      if (!activeRef.current) return;
      const check = precheckPunch(screen, latest, Date.now());
      if (!check.send) {
        abortStalePunch(check);
        return;
      }
      const type = check.type;
      if (abortForPendingFixPunch(type, screen, latest, freshPending)) return;

      // 沒拿到座標才帶 geoStatus；沒有新結果（這次也失敗）就用最近一次記下的原因。
      const body: Parameters<typeof postPunch>[0] = {
        ...(fix
          ? { type, source: "gps" as const, lat: fix.lat, lng: fix.lng }
          : { type, source: "web" as const, geoStatus: geoStatusRef.current ?? undefined }),
        // 在家上班：只有開通且勾了才帶（遲到理由重送沿用同一個 body）。
        ...(wfhEnabled && wfh ? { wfh: true } : {}),
      };
      pendingBodyRef.current = body;
      pendingScreenRef.current = screen;
      const res = await postPunch(body);
      if (!activeRef.current) return;
      pendingBodyRef.current = null;
      await afterPunchSuccess(res);
    } catch (err) {
      if (!activeRef.current) return;
      const late = lateReasonRequiredOf(err);
      if (late) {
        // 遲到：伺服器沒寫打卡，打開理由對話框（定位沿用 pendingBodyRef）。
        setLateInfo(late);
        setLateError(null);
        return;
      }
      pendingBodyRef.current = null;
      if (isPunchTooSoon(err)) {
        // 409 不帶 body 給前端，時間從 /punch/today 重抓（最後一筆 in/out 的時間）。
        let when = "";
        try {
          const today = await getPunchToday();
          if (!activeRef.current) return;
          setRecords(mergePending(today.records));
          const s = summarizePunches(today.records); // 時間看真的卡，不拿待核准的補卡時間
          const last = s.phase === "working" ? s.workingSince : s.lastOutAt;
          if (last) when = `（${fmtHm(last)}）`;
        } catch {
          /* 拿不到時間就不顯示 */
        }
        toast.show(`剛剛已打過卡${when}`, "info");
      } else {
        setPunchError(punchErrorMessage(err, "打卡失敗，請再試一次"));
      }
    } finally {
      if (activeRef.current) setPunching(false);
    }
  }, [punching, locked, loading, loadError, records, toast, afterPunchSuccess, setPunching, abortStalePunch, mergePending, refetchPendingForPunch, abortForPendingFixPunch, wfhEnabled, wfh]);

  /** 遲到理由送出：驗證 1–500 字 → 確認最新狀態（precheckPunch）→ 帶 lateReason 原樣重送剛才那次打卡。 */
  const submitLateReason = useCallback(async () => {
    const body = pendingBodyRef.current;
    if (!body || lateSubmitting) return;
    const invalid = lateReasonError(lateReason);
    if (invalid) {
      setLateError(invalid);
      return;
    }
    loadSeqRef.current += 1; // 同 onPunch：送出前發出、晚到的背景抓取作廢
    setLateSubmitting(true);
    setLateError(null);
    try {
      // 對話框可能開了一陣子（這期間主管可能核准了今天的補上班卡、或本人在別的裝置打過卡）：重送前同樣
      // 確認最新狀態，比對的是當初按下時的畫面（body.type 由它推出；對話框開著時輪詢可能已改了畫面）。
      // 狀態變了就不送、關掉對話框、畫面換成最新狀態並提示，抓不到照送。
      // 也一併重抓待簽核單：對話框開著時若已送出今天的上班補卡，就不送這張上班卡。
      const [latest, freshPending] = body.type
        ? await Promise.all([fetchTodayRecords(PUNCH_PRECHECK_WAIT_MS), refetchPendingForPunch()])
        : [null, null];
      const check = body.type ? precheckPunch(pendingScreenRef.current, latest, Date.now()) : null;
      if (!activeRef.current) return;
      if (check && !check.send) {
        pendingBodyRef.current = null;
        setLateInfo(null);
        abortStalePunch(check);
        return;
      }
      if (check && abortForPendingFixPunch(check.type, pendingScreenRef.current, latest, freshPending)) {
        pendingBodyRef.current = null;
        setLateInfo(null);
        return;
      }
      const res = await postPunch({ ...body, lateReason: lateReason.trim() });
      if (!activeRef.current) return;
      pendingBodyRef.current = null;
      setLateInfo(null);
      setLateReason("");
      await afterPunchSuccess(res);
    } catch (err) {
      if (!activeRef.current) return;
      const late = lateReasonRequiredOf(err);
      if (late) {
        // 伺服器仍認為缺理由（例如只有空白）：更新遲到分鐘、留在對話框。
        setLateInfo(late);
        setLateError("請填寫遲到原因");
      } else {
        setLateError(punchErrorMessage(err, "送出失敗，請再試一次"));
      }
    } finally {
      if (activeRef.current) setLateSubmitting(false);
    }
  }, [lateReason, lateSubmitting, afterPunchSuccess, setLateSubmitting, abortStalePunch, refetchPendingForPunch, abortForPendingFixPunch]);

  /** 取消：不打卡，關掉對話框（理由草稿保留，再按一次打卡可以接著寫）。 */
  const cancelLateReason = useCallback(() => {
    if (lateSubmitting) return;
    pendingBodyRef.current = null;
    setLateInfo(null);
    setLateError(null);
  }, [lateSubmitting]);

  /**
   * 「早上有到，只是忘了打卡」：不打卡、關掉對話框，帶去補卡單（預選上班、日期今天）。送出補卡回到首頁，
   * 待核准的上班補卡就當作已上班 →「下班打卡」。
   */
  const forgotPunchIn = useCallback(() => {
    if (lateSubmitting) return;
    pendingBodyRef.current = null;
    setLateInfo(null);
    setLateError(null);
    router.push(forgotPunchInHref(todayKey()));
  }, [lateSubmitting, router]);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <Clock />
      <PunchCard
        summary={summary}
        loading={loading}
        loadError={loadError}
        punching={punching}
        locked={locked}
        punchError={punchError}
        notice={punchNotice}
        onPunch={onPunch}
        onRetryLoad={() => void loadPunch()}
        wfhEnabled={wfhEnabled}
        wfh={wfh}
        todayWfh={todayWfh}
        onWfhChange={onWfhChange}
      />
      <TodayTimes summary={summary} loading={loading} />
      <OvertimeCapCard />
      <DutyTodayCard />
      <AnnouncementHint count={hintCount} />
      <LateReasonSheet
        info={lateInfo}
        value={lateReason}
        error={lateError}
        submitting={lateSubmitting}
        onChange={(next) => {
          setLateReason(next);
          if (lateError) setLateError(null);
        }}
        onSubmit={() => void submitLateReason()}
        onForgotPunch={fixPunchForbidden ? undefined : forgotPunchIn}
        onCancel={cancelLateReason}
      />
    </div>
  );
}
