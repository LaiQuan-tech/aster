"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  getAnnouncements,
  getPunchToday,
  isPunchTooSoon,
  lateReasonRequiredOf,
  postPunch,
  type LateReasonRequired,
  type PunchResult,
} from "@/lib/ess-api";
import { fmtHm, todayKey, weekdayLabel } from "@/lib/ess-format";
import { LATE_REASON_MAX, lateReasonError, lateReasonPrompt } from "@/lib/late-reason";
import { describePeriodClosed } from "@/lib/period-closed";
import {
  needsAnnouncementHint,
  summarizePunches,
  type PunchLike,
  type PunchSummary,
} from "@/lib/punch-state";
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
/** 成功後鎖住按鈕的時間，擋手抖連按（伺服器另有 60 秒冷卻）。 */
const AFTER_SUCCESS_LOCK_MS = 3_000;

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

/* ------------------------------------------------------------ 文案 --- */

const PUNCH_ERROR_MESSAGES: Record<string, string> = {
  not_an_employee: "此帳號尚未對應到員工資料，無法打卡",
  unauthorized: "登入已逾期，請重新登入",
  invalid_body: "送出的內容格式不正確",
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
  onPunch,
  onRetryLoad,
}: {
  summary: PunchSummary;
  loading: boolean;
  loadError: string | null;
  punching: boolean;
  locked: boolean;
  punchError: string | null;
  onPunch: () => void;
  onRetryLoad: () => void;
}) {
  const disabled = loading || !!loadError || punching || locked;
  const label = loading ? "載入中…" : punching ? "打卡中…" : summary.nextLabel;
  const status = loading
    ? " "
    : summary.phase === "working" && summary.workingSince
      ? `${summary.statusLabel} · 自 ${fmtHm(summary.workingSince)}`
      : summary.statusLabel;

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
      <p className="mt-3 min-h-5 text-center text-sm text-gray-500" aria-live="polite">
        {status}
      </p>
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

function TodayTimes({ summary, loading }: { summary: PunchSummary; loading: boolean }) {
  const cell = (iso: string | null) => (loading ? "…" : iso ? fmtHm(iso) : "—");
  return (
    <Card title="今日">
      <dl className="grid grid-cols-2 divide-x divide-gray-100 text-center">
        <div className="px-2">
          <dt className="text-xs font-medium text-gray-400">上班</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{cell(summary.firstInAt)}</dd>
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

/** 遲到理由對話框（手機從底部滑出）：說明＋多行輸入＋「送出並打卡」／「取消」。 */
function LateReasonSheet({
  info,
  value,
  error,
  submitting,
  onChange,
  onSubmit,
  onCancel,
}: {
  info: LateReasonRequired | null;
  value: string;
  error: string | null;
  submitting: boolean;
  onChange: (next: string) => void;
  onSubmit: () => void;
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
  const [records, setRecords] = useState<PunchLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [punching, setPunching] = useState(false);
  const [locked, setLocked] = useState(false);
  const [punchError, setPunchError] = useState<string | null>(null);
  const [hintCount, setHintCount] = useState(0);
  // 遲到理由對話框：伺服器回 late_reason_required 時打開；pendingBody＝剛才那次打卡的內容（含定位），
  // 送出理由時原樣重送。
  const [lateInfo, setLateInfo] = useState<LateReasonRequired | null>(null);
  const [lateReason, setLateReason] = useState("");
  const [lateError, setLateError] = useState<string | null>(null);
  const [lateSubmitting, setLateSubmitting] = useState(false);
  const pendingBodyRef = useRef<Parameters<typeof postPunch>[0] | null>(null);

  const fixRef = useRef<GeoFix | null>(null);
  /** 最近一次定位失敗的原因；預抓或按下打卡任一次失敗都會覆蓋，送出打卡時撈最新值。 */
  const geoStatusRef = useRef<GeoStatus | null>(null);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);

  const summary = useMemo(() => summarizePunches(records), [records]);

  /** 抓 `/punch/today`。`quiet`＝背景對齊（不動 loading、失敗不顯示）。 */
  const loadPunch = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = opts?.quiet === true;
    if (!quiet) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const today = await getPunchToday();
      if (!activeRef.current) return;
      setRecords(today.records);
      setLoadError(null);
    } catch (err) {
      if (!activeRef.current || quiet) return;
      setLoadError(punchErrorMessage(err, "載入打卡狀態失敗"));
    } finally {
      if (activeRef.current && !quiet) setLoading(false);
    }
  }, []);

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

  // 頁面被收到背景（PWA 放隔夜是常態）再回來時，靜靜地對齊一次今日狀態。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadPunch({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadPunch]);

  /** 打卡成功（含帶理由重送成功）：樂觀更新、Toast、震動、短暫鎖鈕、背景對齊。 */
  const afterPunchSuccess = useCallback(
    async (res: PunchResult) => {
      // 先用回傳的 record 樂觀更新，再背景抓 /punch/today 對齊。
      const rec: PunchLike = res.record ?? { type: res.type, punch_at: res.punchAt };
      setRecords((prev) => [...prev, rec]);
      const lateNote = res.lateReport ? "（已送出遲到說明）" : "";
      toast.show(`${rec.type === "in" ? "上班" : "下班"}打卡成功 ${fmtHm(rec.punch_at)}${lateNote}`, "success");
      try {
        navigator.vibrate?.(30);
      } catch {
        /* 不支援就算了 */
      }
      setLocked(true);
      if (lockTimer.current) clearTimeout(lockTimer.current);
      lockTimer.current = setTimeout(() => {
        lockTimer.current = null;
        if (activeRef.current) setLocked(false);
      }, AFTER_SUCCESS_LOCK_MS);
      await loadPunch({ quiet: true });
    },
    [toast, loadPunch],
  );

  const onPunch = useCallback(async () => {
    if (punching || locked || loading || loadError) return;
    const type = summary.nextType; // 一律送明確 type，伺服器不猜
    setPunching(true);
    setPunchError(null);
    try {
      const cached = fixRef.current;
      const fix =
        cached && Date.now() - cached.at <= FIX_FRESH_MS
          ? cached
          : await requestFix(
              ON_PUNCH_OPTS,
              PUNCH_FIX_WAIT_MS,
              (late) => {
                fixRef.current = late;
              },
              (status) => {
                geoStatusRef.current = status;
              },
            );

      // 沒拿到座標才帶 geoStatus；沒有新結果（這次也失敗）就用最近一次記下的原因。
      const body: Parameters<typeof postPunch>[0] = fix
        ? { type, source: "gps", lat: fix.lat, lng: fix.lng }
        : { type, source: "web", geoStatus: geoStatusRef.current ?? undefined };
      pendingBodyRef.current = body;
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
          setRecords(today.records);
          const s = summarizePunches(today.records);
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
  }, [punching, locked, loading, loadError, summary.nextType, toast, afterPunchSuccess]);

  /** 遲到理由送出：驗證 1–500 字 → 帶 lateReason 原樣重送剛才那次打卡。 */
  const submitLateReason = useCallback(async () => {
    const body = pendingBodyRef.current;
    if (!body || lateSubmitting) return;
    const invalid = lateReasonError(lateReason);
    if (invalid) {
      setLateError(invalid);
      return;
    }
    setLateSubmitting(true);
    setLateError(null);
    try {
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
  }, [lateReason, lateSubmitting, afterPunchSuccess]);

  /** 取消：不打卡，關掉對話框（理由草稿保留，再按一次打卡可以接著寫）。 */
  const cancelLateReason = useCallback(() => {
    if (lateSubmitting) return;
    pendingBodyRef.current = null;
    setLateInfo(null);
    setLateError(null);
  }, [lateSubmitting]);

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
        onPunch={onPunch}
        onRetryLoad={() => void loadPunch()}
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
        onCancel={cancelLateReason}
      />
    </div>
  );
}
