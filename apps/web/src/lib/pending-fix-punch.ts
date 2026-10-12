/**
 * 待核准的上班補卡 → 首頁的「暫定上班卡」（2026-10-12 業主拍板）——純函式，不碰 React／DOM／API，
 * 單元測試在 __tests__/pending-fix-punch.test.ts。
 *
 * 動機：忘了打上班卡的員工送出補卡後，以前要等主管核准（核准才補一筆人工上班卡），首頁才會變成「下班打卡」，
 * 等於逼主管馬上核准。現在：今天有本人「待簽核」的補上班卡、而今天沒有真的上班卡，首頁就當作已上班——
 * 狀態「上班中・補卡待核准（08:52）」、按鈕「下班打卡」（送 type=out）、「上班」欄「08:52（待核准）」。
 * 主管晚點核准時照舊補一筆人工上班卡（API services/ledger.ts materializeFixPunch），跟下班卡自然配對；
 * 被駁回的話那天就是有下班卡、沒有上班卡，月表顯示「缺上班卡」——預期行為。
 *
 * 做法：把補卡單轉成一筆**沒有 id** 的 in（`ProvisionalPunch`）併進 `/punch/today` 的紀錄，再交給
 * lib/punch-state.ts 現有的 summarizePunches／precheckPunch／shouldApplyPolledPunches，不改它們：
 *   - 沒有 id：主管核准後補進來的人工上班卡（同一天同一分鐘）在打卡前預檢時以「種類＋時刻」比對成同一張，
 *     不會被當成「多了畫面上沒有的卡」而擋下這次打卡。
 *   - 打卡前預檢拿最新的「真的」紀錄比：今天還沒有任何真的 in／out 不算新證據，照畫面送下班卡。
 *   - 背景輪詢比的是「併過暫定上班卡」的紀錄：加班過午夜（補卡日期已不是今天）照舊維持「上班中」，
 *     上班卡超過 16 小時才翻回「上班打卡」，跟真的上班卡同一套規則。
 */
import { summarizePunches, type PunchLike, type PunchSummary } from "./punch-state";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 補卡段的時間：`HH:MM`（表單一律送這種；容許尾巴帶秒）。 */
const HM_RE = /^(\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * `GET /requests?scope=mine&status=pending&kind=fix_punch` 的一列，只用到這幾欄（ess-api 的 LeaveRequest 符合）。
 * 補卡表單送的 `segments`：`[{ date: "YYYY-MM-DD", startTime: "HH:MM", type: "in" | "out", ... }]`。
 */
export interface PendingFixPunchRequestLike {
  id: string;
  kind: string;
  status: string;
  segments?: ReadonlyArray<{ date?: string | null; startTime?: string | null; type?: string | null } | null> | null;
}

/** 今天待核准的補上班卡。 */
export interface PendingFixPunchIn {
  /** 補卡單 id。 */
  requestId: string;
  /** 補卡日期 `YYYY-MM-DD`。 */
  date: string;
  /** 補卡單上的時間 `HH:MM`（狀態文字與「上班」欄照這個顯示）。 */
  hm: string;
  /** 同一刻的 ISO 時間：以瀏覽器時區解讀 date＋hm，跟補卡表單算 startAt 的方式相同（request-forms.ts localIso）。 */
  punchAt: string;
}

/** 首頁紀錄裡的暫定上班卡：沒有 id（理由見檔頭），多帶它來自哪張補卡單。 */
export interface ProvisionalPunch extends PunchLike {
  type: "in";
  pendingFixPunch: PendingFixPunchIn;
}

export function isProvisionalPunch(r: PunchLike): r is ProvisionalPunch {
  const p = (r as Partial<ProvisionalPunch>).pendingFixPunch;
  return typeof p === "object" && p !== null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function normalizeHm(raw: string): string | null {
  const m = HM_RE.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

/**
 * 從待簽核單挑出「本人、待簽核、補上班卡、日期是今天」的補卡（kind=fix_punch、status=pending、
 * 某一段 type=in 且 date=today）。好幾張就取時間最早的一張；沒有、或拿不到清單（null）→ null。
 * 補下班卡、補別天的卡、已核准／駁回／撤回的單都不算。`today`＝`YYYY-MM-DD`（呼叫端用 todayKey()）。
 */
export function pendingFixPunchInFor(
  requests: ReadonlyArray<PendingFixPunchRequestLike> | null | undefined,
  today: string,
): PendingFixPunchIn | null {
  if (!requests || !DATE_RE.test(today)) return null;
  let best: { item: PendingFixPunchIn; at: number } | null = null;
  for (const r of requests) {
    if (!r || r.kind !== "fix_punch" || r.status !== "pending" || !Array.isArray(r.segments)) continue;
    for (const s of r.segments) {
      if (!s || s.type !== "in" || s.date !== today || typeof s.startTime !== "string") continue;
      const hm = normalizeHm(s.startTime);
      if (!hm) continue;
      const at = Date.parse(`${today}T${hm}:00`); // 沒有時區後綴＝瀏覽器時區
      if (!Number.isFinite(at)) continue;
      if (!best || at < best.at) {
        best = { item: { requestId: r.id, date: today, hm, punchAt: new Date(at).toISOString() }, at };
      }
    }
  }
  return best ? best.item : null;
}

/**
 * 把待核准的上班補卡併進今天的打卡紀錄：先拿掉紀錄裡舊的暫定上班卡，再看要不要放一張新的。全部成立才放：
 *   ① 有今天、待簽核的補上班卡（pendingFixPunchInFor）。拿不到待簽核單（null：例如沒開「請假」分頁的員工
 *      GET /requests 回 403）→ 不放，照舊行為。
 *   ② 今天沒有真的上班卡——有了就以真的為準（照舊）。
 *   ③ 補卡時間早於今天每一張真的 in／out：暫定上班卡只當「今天的第一張卡」。補卡時間填得比已打的下班卡還晚
 *      （填錯）時放進去，最後一張又會是 in、按鈕又變回「下班打卡」，所以不放。
 * 不改原陣列，回傳新陣列；可以重複呼叫（結果相同）。
 */
export function withPendingFixPunch(
  records: ReadonlyArray<PunchLike>,
  requests: ReadonlyArray<PendingFixPunchRequestLike> | null | undefined,
  today: string,
): PunchLike[] {
  const real = records.filter((r) => !isProvisionalPunch(r));
  const pending = pendingFixPunchInFor(requests, today);
  if (!pending) return real;
  if (real.some((r) => r.type === "in")) return real;
  const at = Date.parse(pending.punchAt);
  // 時間解析不了的真卡也當成「不晚於補卡時間」：寧可照舊，不冒按鈕翻來翻去的險。
  const notFirst = real.some((r) => r.type === "out" && !(Date.parse(r.punch_at) > at));
  if (notFirst) return real;
  const provisional: ProvisionalPunch = { type: "in", punch_at: pending.punchAt, pendingFixPunch: pending };
  return [...real, provisional];
}

export interface PendingAwareSummary extends PunchSummary {
  /** 紀錄裡套用中的暫定上班卡；沒有 → null。 */
  pendingIn: PendingFixPunchIn | null;
  /**
   * 「上班中」是因為暫定上班卡：statusLabel 已換成「上班中・補卡待核准（HH:MM）」，畫面不要再接「· 自 HH:MM」。
   */
  workingOnPending: boolean;
  /** 「上班」欄（firstInAt）是暫定上班卡：顯示「HH:MM（待核准）」。 */
  firstInPending: boolean;
}

/**
 * summarizePunches 加上暫定上班卡的顯示資訊。按鈕（nextType／nextLabel）照 summarizePunches：
 * 暫定上班卡是最後一張 → 「下班打卡」、送 out。`inOutCount` 只算真的卡（首頁「今日共 N 筆」連到打卡紀錄頁，
 * 那裡只有真的卡）。
 */
export function summarizeWithPendingFixPunch(records: ReadonlyArray<PunchLike>): PendingAwareSummary {
  const base = summarizePunches(records);
  const provisional = records.find(isProvisionalPunch);
  if (!provisional) return { ...base, pendingIn: null, workingOnPending: false, firstInPending: false };
  const pending = provisional.pendingFixPunch;
  const workingOnPending = base.phase === "working" && base.workingSince === provisional.punch_at;
  return {
    ...base,
    inOutCount: Math.max(0, base.inOutCount - 1),
    statusLabel: workingOnPending ? pendingFixPunchStatusLabel(pending.hm) : base.statusLabel,
    pendingIn: pending,
    workingOnPending,
    firstInPending: base.firstInAt === provisional.punch_at,
  };
}

/** 狀態文字：「上班中・補卡待核准（08:52）」，時間是補卡單上的時間。 */
export function pendingFixPunchStatusLabel(hm: string): string {
  return `上班中・補卡待核准（${hm}）`;
}

/** 「上班」欄時間後面接的字：「08:52（待核准）」。 */
export const PENDING_FIX_PUNCH_CELL_SUFFIX = "（待核准）";

/**
 * 遲到理由視窗「早上有到，只是忘了打卡」導去的補卡單：預選「上班」、日期是今天
 * （請假頁讀 kind／date／type，見 app/ess/requests/page.tsx）。
 */
export function forgotPunchInHref(today: string): string {
  return `/ess/requests?kind=fix_punch&date=${encodeURIComponent(today)}&type=in`;
}
