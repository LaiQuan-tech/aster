/**
 * 打卡首頁的狀態機與提示計數——純函式，不碰 React／DOM／時區，方便 vitest 直接測。
 *
 * 契約（首頁 `app/ess/page.tsx` 依賴）：
 *   - `summarizePunches(records)`：只看 `type` 為 in／out 的紀錄（break_*／outing_* 一律略過），
 *     依 `punch_at` 升冪排序後推出今天的階段、上下班時間、下一步要送的 `type` 與文案。
 *     **前端一律送明確 `type`**（伺服器不再自己猜）。
 *   - `needsAnnouncementHint(list)`：需簽收且尚未查閱（`viewed_at` 為 null 或 undefined）的公告數；
 *     舊 API 沒有 `viewed_at` 欄位（undefined）時視為未查閱，首頁才會提示去公告頁補查閱。
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
