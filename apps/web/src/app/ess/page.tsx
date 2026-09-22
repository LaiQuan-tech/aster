"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  getAnnouncements,
  getPunchToday,
  isPunchTooSoon,
  postPunch,
} from "@/lib/ess-api";
import { fmtHm, todayKey, weekdayLabel } from "@/lib/ess-format";
import {
  needsAnnouncementHint,
  summarizePunches,
  type PunchLike,
  type PunchSummary,
} from "@/lib/punch-state";
import { Button, Card, Icon, InlineError, useToast } from "@/components/ess-ui";
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
 */

/* ------------------------------------------------------------ 定位 --- */

interface GeoFix {
  lat: number;
  lng: number;
  /** 取得時間（ms since epoch），判斷新不新鮮用。 */
  at: number;
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
 */
function requestFix(
  opts: PositionOptions,
  hardTimeoutMs?: number,
  onFix?: (fix: GeoFix) => void,
): Promise<GeoFix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fix: GeoFix | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(fix);
    };
    if (hardTimeoutMs && hardTimeoutMs > 0) timer = setTimeout(() => finish(null), hardTimeoutMs);
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
        () => finish(null),
        opts,
      );
    } catch {
      finish(null);
    }
  });
}

/* ------------------------------------------------------------ 文案 --- */

const PUNCH_ERROR_MESSAGES: Record<string, string> = {
  not_an_employee: "此帳號尚未對應到員工資料，無法打卡",
  unauthorized: "登入已逾期，請重新登入",
  invalid_body: "送出的內容格式不正確",
};

/** apiFetch 的錯誤訊息是 `[status] code`；認得的 code 轉中文，網路斷線另外講，其餘照原文。 */
function punchErrorMessage(err: unknown, fallback: string): string {
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

  const fixRef = useRef<GeoFix | null>(null);
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
    // GPS 預抓：結果（含晚到的）直接進 ref，按下時就不用等。
    void requestFix(PREFETCH_OPTS, undefined, (fix) => {
      fixRef.current = fix;
    });
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
          : await requestFix(ON_PUNCH_OPTS, PUNCH_FIX_WAIT_MS, (late) => {
              fixRef.current = late;
            });

      const res = await postPunch(
        fix ? { type, source: "gps", lat: fix.lat, lng: fix.lng } : { type, source: "web" },
      );
      if (!activeRef.current) return;

      // 先用回傳的 record 樂觀更新，再背景抓 /punch/today 對齊。
      const rec: PunchLike = res.record ?? { type: res.type, punch_at: res.punchAt };
      setRecords((prev) => [...prev, rec]);
      toast.show(`${rec.type === "in" ? "上班" : "下班"}打卡成功 ${fmtHm(rec.punch_at)}`, "success");
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
    } catch (err) {
      if (!activeRef.current) return;
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
  }, [punching, locked, loading, loadError, summary.nextType, toast, loadPunch]);

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
    </div>
  );
}
