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
import {
  isCarryOverPunch,
  precheckForcedPunch,
  summarizePunches,
  type PunchLike,
  type PunchPrecheck,
  type PunchSummary,
  type PunchType,
} from "./punch-state";

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

/** 待簽核補卡單裡「日期是 today、卡別是 type」的每一段 → 補卡單 id、時間 HH:MM、時刻（ms，瀏覽器時區）。 */
function pendingSegments(
  requests: ReadonlyArray<PendingFixPunchRequestLike> | null | undefined,
  today: string,
  type: "in" | "out",
): Array<{ requestId: string; hm: string; at: number }> {
  const out: Array<{ requestId: string; hm: string; at: number }> = [];
  if (!requests || !DATE_RE.test(today)) return out;
  for (const r of requests) {
    if (!r || r.kind !== "fix_punch" || r.status !== "pending" || !Array.isArray(r.segments)) continue;
    for (const s of r.segments) {
      if (!s || s.type !== type || s.date !== today || typeof s.startTime !== "string") continue;
      const hm = normalizeHm(s.startTime);
      if (!hm) continue;
      const at = Date.parse(`${today}T${hm}:00`); // 沒有時區後綴＝瀏覽器時區
      if (!Number.isFinite(at)) continue;
      out.push({ requestId: r.id, hm, at });
    }
  }
  return out;
}

/**
 * 從待簽核單挑出「本人、待簽核、補上班卡、日期是今天」的補卡（kind=fix_punch、status=pending、
 * 某一段 type=in 且 date=today）。好幾張就取時間最早的一張；沒有、或拿不到清單（null）→ null。
 * 補下班卡、補別天的卡、已核准／駁回／撤回的單都不算。`today`＝`YYYY-MM-DD`（呼叫端用 todayKey()）。
 * 今天另外有待核准的補下班卡、時間又晚於這張補上班卡（一次補整天：主管核准後上下班都會補齊）→ null，
 * 不當成「上班中」，維持現有行為。
 */
export function pendingFixPunchInFor(
  requests: ReadonlyArray<PendingFixPunchRequestLike> | null | undefined,
  today: string,
): PendingFixPunchIn | null {
  let best: { requestId: string; hm: string; at: number } | null = null;
  for (const seg of pendingSegments(requests, today, "in")) {
    if (!best || seg.at < best.at) best = seg;
  }
  if (!best) return null;
  const earliestIn = best.at;
  if (pendingSegments(requests, today, "out").some((o) => o.at > earliestIn)) return null;
  return { requestId: best.requestId, date: today, hm: best.hm, punchAt: new Date(best.at).toISOString() };
}

/**
 * 把待核准的上班補卡併進今天的打卡紀錄：先拿掉紀錄裡舊的暫定上班卡，再看要不要放一張新的。全部成立才放：
 *   ① 有今天、待簽核的補上班卡（pendingFixPunchInFor；同一天有更晚的待核准補下班卡就不算）。拿不到待簽核單
 *      （null：例如沒開「請假」分頁的員工 GET /requests 回 403）→ 不放，照舊行為。
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
  // 前一天還開著的上班卡（carry_over，跨午夜）不是今天的上班卡，不擋今天的暫定上班卡。
  if (real.some((r) => r.type === "in" && !isCarryOverPunch(r))) return real;
  const at = Date.parse(pending.punchAt);
  // 時間解析不了的真卡也當成「不晚於補卡時間」：寧可照舊，不冒按鈕翻來翻去的險。
  const notFirst = real.some((r) => r.type === "out" && !(Date.parse(r.punch_at) > at));
  if (notFirst) return real;
  const provisional: ProvisionalPunch = { type: "in", punch_at: pending.punchAt, pendingFixPunch: pending };
  return [...real, provisional];
}

/**
 * 背景輪詢：補卡被撤回或駁回（2026-10-12 審查回饋）。這次**有成功抓到**待簽核單、畫面上的暫定上班卡是今天的，
 * 而新紀錄裡已經沒有暫定上班卡（那張補卡不在待簽核單裡了）→ true：直接套用新紀錄，回到「上班打卡」，
 * 不要卡在「下班打卡」。暫定卡不是今天的（加班過午夜）→ false，照 shouldApplyPolledPunches 保留上班中。
 * `next`＝已經用最新待簽核單併過的紀錄。
 */
export function pendingFixPunchWithdrawn(
  screen: ReadonlyArray<PunchLike>,
  next: ReadonlyArray<PunchLike>,
  today: string,
): boolean {
  const shown = screen.find(isProvisionalPunch);
  if (!shown || shown.pendingFixPunch.date !== today) return false;
  return !next.some(isProvisionalPunch);
}

/** 預檢擋下上班卡時的提示（今天已送出上班補卡）。 */
export const PENDING_FIX_PUNCH_IN_NOTICE = "你已送出今天的上班補卡，請按下班打卡";

/**
 * 送上班卡前的補卡預檢（2026-10-12 審查回饋）：畫面還是「上班打卡」（例如在別的分頁剛送出上班補卡、
 * 首頁還沒重抓），送出去就會在補卡之外多一張上班卡（打卡紀錄不能硬刪）。所以送 in 前一併重抓待簽核單：
 * 用最新的真紀錄（抓不到就用畫面上的真卡）＋最新待簽核單併一次，出現暫定上班卡 → 中止，回傳要換上的紀錄
 * （畫面變「上班中・補卡待核准」）與提示；否則 null，照常送出。
 * `pending` 為 null（這次沒抓到待簽核單）→ null：不因為查不到就擋打卡。
 */
export function precheckPendingFixPunch(
  type: "in" | "out",
  screen: ReadonlyArray<PunchLike>,
  latest: ReadonlyArray<PunchLike> | null | undefined,
  pending: ReadonlyArray<PendingFixPunchRequestLike> | null | undefined,
  today: string,
): { records: PunchLike[]; notice: string } | null {
  if (type !== "in" || !pending) return null;
  const base = latest ?? screen.filter((r) => !isProvisionalPunch(r));
  const merged = withPendingFixPunch(base, pending, today);
  if (!merged.some(isProvisionalPunch)) return null;
  return { records: merged, notice: PENDING_FIX_PUNCH_IN_NOTICE };
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

/**
 * 狀態不明（今日打卡載入失敗）時員工自己選上班／下班（2026-10-26 驗收回饋）：按下時抓到的最新紀錄先併上待核准的
 * 上班補卡（`pending`：這次重抓到的待簽核單，抓不到就用上次的），再交給 precheckForcedPunch——補卡撐起的「上班中」
 * 選下班照送、選上班就不送（按鈕改回「下班打卡」）。`latest` 為 null（抓不到）→ 照選的送。
 * 回傳的 `latest`（中止時）是併過暫定上班卡的紀錄，呼叫端可直接放進畫面（withPendingFixPunch 可重複呼叫）。
 */
export function precheckForcedPunchWithPending(
  force: PunchType,
  latest: ReadonlyArray<PunchLike> | null | undefined,
  pending: ReadonlyArray<PendingFixPunchRequestLike> | null | undefined,
  today: string,
): PunchPrecheck<PunchLike> {
  if (!latest) return precheckForcedPunch(force, null);
  return precheckForcedPunch(force, withPendingFixPunch(latest, pending, today));
}
