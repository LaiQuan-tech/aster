/**
 * 通知／簽核卡的純函式（不碰 React／DOM；全部有單元測試）。
 *
 * - `isUnread`／`notificationLink`：通知列表「整列可點→標已讀→導頁」用。
 * - `summarizeSegments`：簽核卡把多段請假壓成一屏看得完的文字。
 * - `TYPE_LABEL`：通知類型 → 員工看得懂的中文 Pill。
 *
 * payload 形狀（apps/api）：
 *   approval          `{ requestId, requestKind, event: "submitted"|"advanced"|"approved"|"rejected", currentStep }`
 *   missing_punch     `{ date, issue }`
 *   attendance_sheet  `{ sheetId, period, … }`
 *   anomaly           `{ anomalyType, from, to, detail }`
 * 未讀 ＝ `payload.read !== true`（標記已讀是把 `read: true` 併進 payload）。
 */
import type { LeaveSegment, NotificationItem } from "./ess-api";
import { fmtDateShort, fmtHours } from "./ess-format";

/* ------------------------------------------------------------ 類型 --- */

/** 通知類型 → Pill 文字；不在表內的用 `typeLabel()` 退化成「通知」。 */
export const TYPE_LABEL: Record<string, string> = {
  approval: "簽核",
  missing_punch: "忘打卡",
  attendance_sheet: "出勤月表",
  anomaly: "出勤異常",
  announcement: "公告",
};

export function typeLabel(type: string | null | undefined): string {
  return (type && TYPE_LABEL[type]) || "通知";
}

/* ------------------------------------------------------------ 未讀 --- */

type NotificationLike = Pick<NotificationItem, "type" | "payload">;

/** 未讀＝payload 沒有 `read: true`（payload 缺席／null／read=false 都算未讀）。 */
export function isUnread(n: Pick<NotificationItem, "payload">): boolean {
  const payload = n.payload;
  if (!payload || typeof payload !== "object") return true;
  return payload.read !== true;
}

/* ------------------------------------------------------------ 導頁 --- */

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * 通知點下去要去哪一頁；回 null 代表沒有對應頁（只展開內文）。
 *
 *   approval submitted／advanced → `/ess/approvals`（輪到我簽）
 *   approval approved／rejected  → `/ess/requests?id=<requestId>`（缺 requestId 退回列表）
 *   missing_punch               → `/ess/requests?kind=fix_punch&date=<date>`
 *   attendance_sheet            → `/ess/attendance-sheet/<sheetId>`（缺 sheetId → null）
 *   anomaly                     → `/ess/punches?from=<from>&to=<to>`
 *   其他類型／缺 payload         → null
 */
export function notificationLink(n: NotificationLike): string | null {
  const payload = n.payload;
  if (!payload || typeof payload !== "object") return null;

  switch (n.type) {
    case "approval": {
      const event = str(payload.event);
      if (event === "submitted" || event === "advanced") return "/ess/approvals";
      if (event === "approved" || event === "rejected") {
        const requestId = str(payload.requestId);
        return requestId ? `/ess/requests?id=${encodeURIComponent(requestId)}` : "/ess/requests";
      }
      return null;
    }
    case "missing_punch": {
      const params = new URLSearchParams({ kind: "fix_punch" });
      const date = str(payload.date);
      if (date) params.set("date", date);
      return `/ess/requests?${params.toString()}`;
    }
    case "attendance_sheet": {
      const sheetId = str(payload.sheetId);
      return sheetId ? `/ess/attendance-sheet/${encodeURIComponent(sheetId)}` : null;
    }
    case "anomaly": {
      const params = new URLSearchParams();
      const from = str(payload.from);
      const to = str(payload.to);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return qs ? `/ess/punches?${qs}` : "/ess/punches";
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------- 請假分段 --- */

/**
 * 補卡段卡別 → 顯示文字。六種都要列（與 API PUNCH_SEGMENT_TYPES 同組）：2026-09-23 正式站
 * 一張補「外出開始／結束」的單在 /ess/approvals 顯示成「09/17 15:00 · undefined」，就是這張表
 * 當時只有 in／out。認不得的值退回「補卡（原值）」，永遠不再印 undefined。
 */
const PUNCH_TYPE_LABEL: Record<NonNullable<LeaveSegment["type"]>, string> = {
  in: "補上班卡",
  out: "補下班卡",
  break_in: "補休息開始卡",
  break_out: "補休息結束卡",
  outing_in: "補外出開始卡",
  outing_out: "補外出結束卡",
};

export function punchTypeLabel(type: string): string {
  return (PUNCH_TYPE_LABEL as Record<string, string | undefined>)[type] ?? `補卡（${type}）`;
}

/** 單段：`09/18 09:00–18:00 · 8 小時`；補卡段：`09/18 09:00 · 補上班卡`。 */
export function summarizeSegment(seg: LeaveSegment): string {
  const date = fmtDateShort(seg.date);
  if (seg.type) {
    return `${date} ${seg.startTime} · ${punchTypeLabel(seg.type)}`;
  }
  const hours = Number(seg.hours);
  const hoursText = Number.isFinite(hours) && hours > 0 ? ` · ${fmtHours(hours)}` : "";
  return `${date} ${seg.startTime}–${seg.endTime}${hoursText}`;
}

/**
 * 多段請假壓成卡片文字：
 *   - 0 段 → ""
 *   - ≤3 段 → 逐段一行（換行分隔；渲染時用 `whitespace-pre-line`）
 *   - >3 段 → 「09/18–09/25 全天 ×6 · 48 小時」
 *     時段全部相同且 ≥8 小時叫「全天」；相同但不足 8 小時顯示 `HH:mm–HH:mm`；
 *     時段不一致就不標時段。
 */
export function summarizeSegments(segs: LeaveSegment[] | null | undefined): string {
  if (!segs || segs.length === 0) return "";
  if (segs.length <= 3) return segs.map(summarizeSegment).join("\n");

  const sorted = [...segs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const total = sorted.reduce((sum, seg) => {
    const hours = Number(seg.hours);
    return sum + (Number.isFinite(hours) ? hours : 0);
  }, 0);
  const sameSlot = sorted.every((seg) => seg.startTime === first.startTime && seg.endTime === first.endTime);
  const slotHours = Number(first.hours);
  let slot = "";
  if (sameSlot) slot = Number.isFinite(slotHours) && slotHours >= 8 ? "全天" : `${first.startTime}–${first.endTime}`;

  const range = `${fmtDateShort(first.date)}–${fmtDateShort(last.date)}`;
  return `${range}${slot ? ` ${slot}` : ""} ×${sorted.length} · ${fmtHours(total)}`;
}
