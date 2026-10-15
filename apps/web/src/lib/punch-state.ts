/**
 * 打卡首頁的狀態機與提示計數——純函式，不碰 React／DOM／時區，方便 vitest 直接測。
 *
 * 契約（首頁 `app/ess/page.tsx` 依賴）：
 *   - `summarizePunches(records)`：只看 `type` 為 in／out 的紀錄（break_*／outing_* 一律略過），
 *     依 `punch_at` 升冪排序後推出今天的階段、上下班時間、下一步要送的 `type` 與文案。
 *     **前端一律送明確 `type`**（伺服器不再自己猜）。
 *   - `needsAnnouncementHint(list)`：需簽收且尚未查閱（`viewed_at` 為 null 或 undefined）的公告數；
 *     舊 API 沒有 `viewed_at` 欄位（undefined）時視為未查閱，首頁才會提示去公告頁補查閱。
 *   - `precheckPunch(screen, latest, now)`：按下打卡時，按下當時畫面上的紀錄 vs 剛抓到的最新紀錄 → 送出或中止
 *     （2026-10-12，見函式說明）；中止時附上給員工看的提示（`notice`）。
 *   - `shouldApplyPolledPunches(screen, polled, now)`：每 60 秒背景輪詢拿到的紀錄要不要蓋掉畫面。
 *   兩者都只認「正面證據」：`/punch/today` 是租戶的日曆日，加班過午夜時新的一天還沒有任何 in／out，
 *   但人其實還在上班（伺服器照收明確送的 out，結算再把過午夜的下班卡歸到上班那天）——空紀錄不算新證據；
 *   只是畫面上的上班卡已超過 `STALE_WORKING_MS`（16 小時）就不再當成還在上班（多半是換日了，見常數說明）。
 */

export type PunchPhase = "none" | "working" | "done";
export type PunchType = "in" | "out";

/**
 * 只要有 `type` 與 `punch_at` 就能算（`PunchRecord` 與 POST /punch 回的 `record` 都符合）；
 * `id` 有帶就拿來比對是不是同一張卡（預檢用）。
 */
export interface PunchLike {
  type: string;
  punch_at: string;
  id?: string | null;
  /**
   * 2026-10-15：`GET /punch/today` 把「前一天 16 小時內、還開著的上班卡」（跨午夜加班）放在最前面並標 true。
   * 它決定階段（上班中 → 「下班打卡」），但不算今天的上班時間、下班時間與筆數。
   */
  carry_over?: boolean | null;
}

/**
 * 「上班中」的畫面最多相信多久，從畫面上最後一張上班卡起算（2026-10-12）。
 * `/punch/today` 只回租戶今天的紀錄：今天還沒有任何 in／out 時，畫面上的「上班中」可能是加班過午夜（要讓人
 * 照常按下班），也可能是昨天忘了打下班卡——桌機分頁開了一整夜（輪詢刻意不把上班中蓋掉）、PWA 隔夜回前景還沒
 * 重抓完就按。後者照送就是隔天早上的下班卡：伺服器把 24 小時內的 in→out 配成一段（API services/punch-pairing.ts），
 * 等於多出將近一整天的工時，而打卡紀錄不能硬刪。正常工時連同延長工時一天最多 12 小時（勞基法第 32 條），
 * 加上休息與過午夜收尾的餘裕取 16 小時：這之內照舊當成還在上班（按下班照送、輪詢的空紀錄不套用）；
 * 超過就當成已換日（預檢不送、按鈕改回「上班打卡」並提示另送補卡；輪詢的空紀錄照常套用）。
 */
export const STALE_WORKING_MS = 16 * 60 * 60_000;
const STALE_WORKING_HOURS = STALE_WORKING_MS / 3_600_000;

export interface PunchSummary {
  /** none＝今天還沒有 in／out；working＝最後一筆是 in；done＝最後一筆是 out。 */
  phase: PunchPhase;
  /** 第一筆 in 的時間（ISO），沒有 → null。 */
  firstInAt: string | null;
  /** 最後一筆 out 的時間（ISO），沒有 → null。 */
  lastOutAt: string | null;
  /** 上班中時＝最後一筆 in 的時間；其他階段 → null。 */
  workingSince: string | null;
  /** 今天 in／out 的總筆數（首頁 >2 筆時加「今日共 N 筆」）。 */
  inOutCount: number;
  /** 下一次按鈕要送的 type。 */
  nextType: PunchType;
  /** 按鈕文案。 */
  nextLabel: string;
  /** 按鈕旁的狀態文案。 */
  statusLabel: string;
  /** 上班中是因為前一天還開著的上班卡（跨午夜，`carry_over`）；首頁另給「改打上班卡」的出口。 */
  workingCarriedOver: boolean;
}

/** 跨午夜仍在上班中的狀態文案（接「· 自 HH:MM」）。 */
export const CARRY_OVER_STATUS_LABEL = "上班中（跨日）";

/** 是不是 `/punch/today` 併進來的前一天上班卡。 */
export function isCarryOverPunch(r: PunchLike): boolean {
  return r.carry_over === true;
}

const PHASE_COPY: Record<PunchPhase, Pick<PunchSummary, "nextType" | "nextLabel" | "statusLabel">> = {
  none: { nextType: "in", nextLabel: "上班打卡", statusLabel: "尚未打卡" },
  working: { nextType: "out", nextLabel: "下班打卡", statusLabel: "上班中" },
  done: { nextType: "in", nextLabel: "再次上班打卡", statusLabel: "今日已下班" },
};

function isWorkPunch(r: PunchLike): r is PunchLike & { type: PunchType } {
  return r.type === "in" || r.type === "out";
}

/** 依 punch_at 升冪；能解析成時間就比時間，否則退回字串比較（ISO 字串本身可排序）。 */
function comparePunchAt(a: PunchLike, b: PunchLike): number {
  const ta = Date.parse(a.punch_at);
  const tb = Date.parse(b.punch_at);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a.punch_at < b.punch_at ? -1 : a.punch_at > b.punch_at ? 1 : 0;
}

export function summarizePunches(records: ReadonlyArray<PunchLike>): PunchSummary {
  const all = records.filter(isWorkPunch).sort(comparePunchAt);
  const last = all[all.length - 1];
  const phase: PunchPhase = !last ? "none" : last.type === "in" ? "working" : "done";
  // 上班／下班時間與筆數只算今天的卡；前一天的上班卡（carry_over）只拿來決定階段。
  const work = all.filter((r) => !isCarryOverPunch(r));
  const workingCarriedOver = phase === "working" && !!last && isCarryOverPunch(last);

  const firstIn = work.find((r) => r.type === "in");
  let lastOut: PunchLike | undefined;
  for (let i = work.length - 1; i >= 0; i--) {
    if (work[i].type === "out") {
      lastOut = work[i];
      break;
    }
  }

  const copy = PHASE_COPY[phase];
  return {
    phase,
    firstInAt: firstIn?.punch_at ?? null,
    lastOutAt: lastOut?.punch_at ?? null,
    workingSince: phase === "working" && last ? last.punch_at : null,
    inOutCount: work.length,
    ...copy,
    statusLabel: workingCarriedOver ? CARRY_OVER_STATUS_LABEL : copy.statusLabel,
    workingCarriedOver,
  };
}

/** 畫面是「上班中」而且最後一張上班卡已超過 STALE_WORKING_MS（時間解析不了 → 不算過期，照舊）。 */
function isStaleWorking(summary: PunchSummary, now: number): boolean {
  if (summary.phase !== "working" || !summary.workingSince) return false;
  const since = Date.parse(summary.workingSince);
  return Number.isFinite(since) && Number.isFinite(now) && now - since > STALE_WORKING_MS;
}

/** 打卡時刻（ms）；解析不了就退回原字串比較。 */
function instantOf(punchAt: string): number | string {
  const t = Date.parse(punchAt);
  return Number.isFinite(t) ? t : punchAt;
}

/** 同一張卡：兩邊都有 id 就比 id；否則比種類＋時刻（`Z` 與 `+08:00` 寫法不同但同一刻也算）。 */
function samePunch(a: PunchLike, b: PunchLike): boolean {
  if (typeof a.id === "string" && a.id && typeof b.id === "string" && b.id) return a.id === b.id;
  return a.type === b.type && instantOf(a.punch_at) === instantOf(b.punch_at);
}

/** 最新紀錄裡有畫面上沒有的 in／out（補卡剛核准、別的裝置打過卡…）；休息／外出卡不看。 */
function hasUnseenWorkPunch(screen: ReadonlyArray<PunchLike>, latest: ReadonlyArray<PunchLike>): boolean {
  const shown = screen.filter(isWorkPunch);
  return latest.some((r) => isWorkPunch(r) && !shown.some((s) => samePunch(s, r)));
}

export type PunchPrecheck<T extends PunchLike = PunchLike> =
  | { send: true; type: PunchType }
  | {
      send: false;
      /**
       * changed＝最新紀錄跟畫面不同（下一步種類變了，或多了畫面上沒有的 in／out）；
       * day_changed＝今天還沒有任何 in／out，而畫面的上班卡已超過 16 小時（換日了）。
       */
      reason: "changed" | "day_changed";
      /** 呼叫端拿來換掉畫面。 */
      latest: readonly T[];
      summary: PunchSummary;
      /** 給員工看的提示（為什麼沒送出、按鈕現在是什麼）。 */
      notice: string;
    }
  | {
      send: false;
      /** 查不到最新紀錄，而畫面的上班卡已超過 16 小時：不能照畫面送，呼叫端重新載入今日狀態。 */
      reason: "unverified";
      latest: null;
      summary: null;
      notice: string;
    };

/**
 * 打卡前確認最新狀態（2026-10-12）。伺服器照前端送的 type 寫入（只有沒帶 type 才自己推），
 * 首頁畫面過期——例如主管剛核准補上班卡，畫面還停在「上班打卡」——直接送就會寫出第二張 in，
 * 而打卡紀錄不能硬刪。所以按下時另抓一次 GET /punch/today，跟按下當時畫面上的紀錄（`screen`）比對。
 * 要送的種類一律由 `screen` 推出（summarizePunches 的 nextType），只認「正面證據」：
 *   - `latest` 為 null／undefined（抓失敗或逾時）→ 照畫面送：不能因為查不到就擋打卡。
 *     例外：畫面「上班中」而上班卡已超過 STALE_WORKING_MS → 不送（unverified），呼叫端重新載入再讓人按。
 *   - 最新紀錄沒有任何 in／out（空的；例如加班過午夜，新的一天還沒打卡）→ 沒有新證據，照畫面送
 *     （畫面「下班打卡」就送 out，結算會把它歸到上班那天）。
 *     例外：畫面「上班中」而上班卡已超過 STALE_WORKING_MS → 已換日，不送（day_changed）：呼叫端把畫面換成
 *     `latest`（按鈕變「上班打卡」）並提示——昨天忘了打的下班卡要另送補卡申請，不能隔天早上補按。
 *   - 最新紀錄非空，而下一步種類跟畫面不同、或有畫面上沒有的 in／out（依 id 比對；沒有 id 比種類＋時刻）
 *     → 不送（changed），呼叫端把畫面換成 `latest` 並顯示 `notice`。例：畫面「上班打卡」（今天 0 張），
 *     主管同時核准了補上班＋補下班——下一步一樣是 in，照送就是下班卡後面多一張上班卡。
 *     只看「最新多出來的卡」、不比筆數：畫面上多出來的卡（例如過午夜下班後，樂觀更新還留著昨天的上班卡）
 *     不算狀態變了；休息／外出卡（break_*／outing_*）一律不看。
 *   - 其他 → 照畫面送。
 * `now`＝現在（ms since epoch），判斷上班卡過期用。
 */
export function precheckPunch<T extends PunchLike>(
  screen: ReadonlyArray<PunchLike>,
  latest: readonly T[] | null | undefined,
  now: number,
): PunchPrecheck<T> {
  const shown = summarizePunches(screen);
  const type = shown.nextType;
  const stale = isStaleWorking(shown, now);
  if (!latest) {
    if (!stale) return { send: true, type };
    return { send: false, reason: "unverified", latest: null, summary: null, notice: punchUnverifiedNotice() };
  }
  const summary = summarizePunches(latest);
  // 前一天還開著的上班卡（carry_over）是正面證據：不走「空紀錄」分支，照下面跟畫面比對。
  if (summary.inOutCount === 0 && !summary.workingCarriedOver) {
    if (!stale) return { send: true, type };
    return { send: false, reason: "day_changed", latest, summary, notice: punchDayChangedNotice(summary) };
  }
  if (summary.nextType !== type || hasUnseenWorkPunch(screen, latest)) {
    return { send: false, reason: "changed", latest, summary, notice: punchStateChangedNotice(summary, shown) };
  }
  return { send: true, type };
}

/**
 * 預檢中止（最新紀錄跟畫面不同）時的提示：說明為什麼沒送出、按鈕現在是什麼，請員工確認後再按一次。
 * `screen`（選填）＝按下當時畫面的摘要：按鈕沒變（同一階段、只是多了新的卡）就改說「已有新的打卡紀錄」。
 */
export function punchStateChangedNotice(
  latest: Pick<PunchSummary, "nextLabel">,
  screen?: Pick<PunchSummary, "nextLabel">,
): string {
  if (screen && screen.nextLabel === latest.nextLabel) {
    return `已有新的打卡紀錄（可能主管已核准補卡），畫面已更新，請確認後再按「${latest.nextLabel}」`;
  }
  return `打卡狀態剛更新（可能主管已核准補卡），按鈕已改為「${latest.nextLabel}」，請確認後再按一次`;
}

/** 預檢發現已換日（day_changed）時的提示。 */
export function punchDayChangedNotice(latest: Pick<PunchSummary, "nextLabel">): string {
  return `已換日，按鈕已改為「${latest.nextLabel}」；若昨天忘了打下班卡，請另送補卡申請`;
}

/** 查不到最新狀態、畫面又過期（unverified）時的提示。 */
export function punchUnverifiedNotice(): string {
  return `打卡沒有送出：上次上班卡已超過 ${STALE_WORKING_HOURS} 小時，又查不到最新狀態（可能已換日），已重新載入，請確認後再按一次`;
}

/**
 * 每 60 秒背景輪詢拿到的紀錄要不要套用到畫面（2026-10-12）。只認「正面證據」：
 *   - 輪詢回來有 in／out → 套用（例如主管剛核准補卡，按鈕要跟上）。
 *   - 輪詢回來沒有任何 in／out、畫面正在上班中、上班卡在 STALE_WORKING_MS（16 小時）內 → 不套用，維持
 *     「下班打卡」：多半是加班過午夜、新的一天還沒打卡，套用就會把按鈕翻成「上班打卡」，人反而打不了下班卡。
 *   - 同上但上班卡已超過 16 小時 → 套用：多半是昨天忘了打下班卡、分頁開了一整夜，按鈕回到「上班打卡」。
 *   - 其他（空紀錄＋畫面沒在上班）→ 套用。
 * 只用在背景輪詢；進頁與回到前景的重抓照舊整個套用。`now`＝現在（ms since epoch）。
 */
export function shouldApplyPolledPunches(
  screen: ReadonlyArray<PunchLike>,
  polled: ReadonlyArray<PunchLike>,
  now: number,
): boolean {
  const p = summarizePunches(polled);
  if (p.inOutCount > 0 || p.workingCarriedOver) return true;
  const shown = summarizePunches(screen);
  return shown.phase !== "working" || isStaleWorking(shown, now);
}

/** 剛下班多久內再按「再次上班打卡」要先確認（2026-10-15：下班後十幾秒又多一張上班卡）。 */
export const RECENT_OUT_CONFIRM_MS = 10 * 60_000;

/**
 * 按鈕是「再次上班打卡」、而今天最後一張下班卡在 RECENT_OUT_CONFIRM_MS 內 → true：首頁先跳確認再送。
 * 防的是剛按完下班、以為沒打到又按一次（多出一張上班卡，打卡紀錄不能硬刪）。
 */
export function needsReInConfirm(summary: Pick<PunchSummary, "phase" | "lastOutAt">, now: number): boolean {
  if (summary.phase !== "done" || !summary.lastOutAt) return false;
  const out = Date.parse(summary.lastOutAt);
  return Number.isFinite(out) && Number.isFinite(now) && now - out >= 0 && now - out < RECENT_OUT_CONFIRM_MS;
}

export interface AnnouncementLike {
  requires_signature: boolean;
  viewed_at?: string | null;
}

/** 需簽收且尚未查閱的公告數（`viewed_at` 為 null／undefined 都算未查閱）。 */
export function needsAnnouncementHint(list: ReadonlyArray<AnnouncementLike>): number {
  let n = 0;
  for (const a of list) {
    if (a.requires_signature && (a.viewed_at === null || a.viewed_at === undefined)) n++;
  }
  return n;
}
