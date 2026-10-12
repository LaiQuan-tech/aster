/**
 * 打卡首頁的狀態機與提示計數——純函式，不碰 React／DOM／時區，方便 vitest 直接測。
 *
 * 契約（首頁 `app/ess/page.tsx` 依賴）：
 *   - `summarizePunches(records)`：只看 `type` 為 in／out 的紀錄（break_*／outing_* 一律略過），
 *     依 `punch_at` 升冪排序後推出今天的階段、上下班時間、下一步要送的 `type` 與文案。
 *     **前端一律送明確 `type`**（伺服器不再自己猜）。
 *   - `needsAnnouncementHint(list)`：需簽收且尚未查閱（`viewed_at` 為 null 或 undefined）的公告數；
 *     舊 API 沒有 `viewed_at` 欄位（undefined）時視為未查閱，首頁才會提示去公告頁補查閱。
 *   - `precheckPunch(screenType, latest)`：按下打卡時，畫面上的種類 vs 剛抓到的最新紀錄 → 送出或中止
 *     （2026-10-12，見函式說明）；`punchStateChangedNotice(latest)` 是中止時給員工看的提示。
 *   - `shouldApplyPolledPunches(screen, polled)`：每 60 秒背景輪詢拿到的紀錄要不要蓋掉畫面。
 *   兩者都只認「正面證據」：`/punch/today` 是租戶的日曆日，加班過午夜時新的一天還沒有任何 in／out，
 *   但人其實還在上班（伺服器照收明確送的 out，結算再把過午夜的下班卡歸到上班那天）——空紀錄不算新證據。
 */

export type PunchPhase = "none" | "working" | "done";
export type PunchType = "in" | "out";

/** 只要有 `type` 與 `punch_at` 就能算（`PunchRecord` 與 POST /punch 回的 `record` 都符合）。 */
export interface PunchLike {
  type: string;
  punch_at: string;
}

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
  const work = records.filter(isWorkPunch).sort(comparePunchAt);
  const last = work[work.length - 1];
  const phase: PunchPhase = !last ? "none" : last.type === "in" ? "working" : "done";

  const firstIn = work.find((r) => r.type === "in");
  let lastOut: PunchLike | undefined;
  for (let i = work.length - 1; i >= 0; i--) {
    if (work[i].type === "out") {
      lastOut = work[i];
      break;
    }
  }

  return {
    phase,
    firstInAt: firstIn?.punch_at ?? null,
    lastOutAt: lastOut?.punch_at ?? null,
    workingSince: phase === "working" && last ? last.punch_at : null,
    inOutCount: work.length,
    ...PHASE_COPY[phase],
  };
}

export type PunchPrecheck<T extends PunchLike = PunchLike> =
  | { send: true; type: PunchType }
  | { send: false; latest: readonly T[]; summary: PunchSummary };

/**
 * 打卡前確認最新狀態（2026-10-12）。伺服器照前端送的 type 寫入（只有沒帶 type 才自己推），
 * 首頁畫面過期——例如主管剛核准補上班卡，畫面還停在「上班打卡」——直接送就會寫出第二張 in，
 * 而打卡紀錄不能硬刪。所以按下時另抓一次 GET /punch/today，用同一套 summarizePunches 比對，
 * 只認「正面證據」：
 *   - `latest` 為 null／undefined（抓失敗或逾時）→ 照畫面上的種類送出：不能因為查不到就擋打卡。
 *   - 最新紀錄沒有任何 in／out（空的；例如加班過午夜，新的一天還沒打卡）→ 沒有新證據，照畫面送
 *     （畫面「下班打卡」就送 out，結算會把它歸到上班那天）。
 *   - 最新紀錄推出的下一步與畫面相同 → 送出。
 *   - 最新紀錄非空、下一步跟畫面不同 → 中止，不送；呼叫端把畫面換成 `latest`，並顯示 `punchStateChangedNotice(summary)`。
 * 只比 nextType：none 與 done 下一步都是 in，畫面是「上班打卡」而最新是「再次上班打卡」時照送（送的種類一樣）。
 */
export function precheckPunch<T extends PunchLike>(
  screenType: PunchType,
  latest: readonly T[] | null | undefined,
): PunchPrecheck<T> {
  if (!latest) return { send: true, type: screenType };
  const summary = summarizePunches(latest);
  if (summary.inOutCount === 0) return { send: true, type: screenType };
  if (summary.nextType === screenType) return { send: true, type: screenType };
  return { send: false, latest, summary };
}

/** 預檢中止時的提示：說明為什麼沒送出、按鈕現在是什麼，請員工確認後再按一次。 */
export function punchStateChangedNotice(latest: Pick<PunchSummary, "nextLabel">): string {
  return `打卡狀態剛更新（可能主管已核准補卡），按鈕已改為「${latest.nextLabel}」，請確認後再按一次`;
}

/**
 * 每 60 秒背景輪詢拿到的紀錄要不要套用到畫面（2026-10-12）。只認「正面證據」：
 *   - 輪詢回來有 in／out → 套用（例如主管剛核准補卡，按鈕要跟上）。
 *   - 輪詢回來沒有任何 in／out、而畫面正在上班中 → 不套用，維持「下班打卡」：多半是加班過午夜、
 *     新的一天還沒打卡，套用就會把按鈕翻成「上班打卡」，人反而打不了下班卡。
 *   - 其他（空紀錄＋畫面沒在上班）→ 套用。
 * 只用在背景輪詢；進頁與回到前景的重抓照舊整個套用。
 */
export function shouldApplyPolledPunches(
  screen: ReadonlyArray<PunchLike>,
  polled: ReadonlyArray<PunchLike>,
): boolean {
  if (summarizePunches(polled).inOutCount > 0) return true;
  return summarizePunches(screen).phase !== "working";
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
