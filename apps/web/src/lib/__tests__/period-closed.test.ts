import { describe, expect, it } from "vitest";
import {
  PERIOD_CLOSED_CODE,
  describePeriodClosed,
  errorMessageOf,
  isPeriodClosedError,
  periodClosedMessage,
  periodClosedPeriod,
} from "../period-closed";
import { apiErrorMessage } from "../api-client";
import { expenseErrorMessage } from "../advance-view";
import { friendlyError } from "../attendance-sheets-api";
import { describeBatchError } from "../ess-approval-batch";
import { importErrorMessage } from "../import-view";
import { lateDecisionErrorMessage } from "../late-reports-api";
import { friendlySettlementError } from "../leave-settlement-api";
import { requestErrorText } from "../request-forms";

/**
 * 發薪鎖定（2026-10-11）：伺服器回 409 `{ error: "period_closed", period }` 的辨識與友善中文。
 * 使用者看到的一定是「YYYY-MM 已結算，請洽管理者」，不是 `[409] period_closed`。
 */

/** apiFetch 丟出的 Error 的樣子：message 是 `[status] code`，另外掛 status／code／body（整包回應 JSON）。 */
function apiError(status: number, body: Record<string, unknown>): Error {
  const code = typeof body.error === "string" ? body.error : undefined;
  return Object.assign(new Error(`[${status}] ${code ?? String(body.message ?? "error")}`), {
    status,
    ...(code ? { code } : {}),
    body,
  });
}

const CLOSED_2026_09 = "2026-09 已結算，請洽管理者";
const CLOSED_GENERIC = "該月份已結算，請洽管理者";

describe("periodClosedMessage", () => {
  it("有月份：「YYYY-MM 已結算，請洽管理者」；沒有或格式不對：「該月份已結算，請洽管理者」", () => {
    expect(periodClosedMessage("2026-09")).toBe(CLOSED_2026_09);
    expect(periodClosedMessage()).toBe(CLOSED_GENERIC);
    expect(periodClosedMessage(null)).toBe(CLOSED_GENERIC);
    expect(periodClosedMessage("")).toBe(CLOSED_GENERIC);
    expect(periodClosedMessage("2026-13")).toBe(CLOSED_GENERIC);
    expect(periodClosedMessage("2026-9")).toBe(CLOSED_GENERIC);
  });
});

describe("isPeriodClosedError／describePeriodClosed — 各種錯誤形狀", () => {
  it("apiFetch 丟的 409 Error（code＋status＋body）→ 認得，取 body.period", () => {
    const err = apiError(409, { error: "period_closed", period: "2026-09" });
    expect(err.message).toBe("[409] period_closed"); // 就是使用者原本會看到的樣子
    expect(isPeriodClosedError(err)).toBe(true);
    expect(periodClosedPeriod(err)).toBe("2026-09");
    expect(describePeriodClosed(err)).toBe(CLOSED_2026_09);
    expect(PERIOD_CLOSED_CODE).toBe("period_closed");
  });

  it("碰到多個已結算月（periods）：用最早的——period 與 periods 都有、只有 periods、順序亂都一樣", () => {
    expect(
      describePeriodClosed(apiError(409, { error: "period_closed", period: "2026-08", periods: ["2026-08", "2026-09", "2026-10"] })),
    ).toBe("2026-08 已結算，請洽管理者");
    // 就算伺服器的 period 不是最早的，也以最早的為準
    expect(
      describePeriodClosed(apiError(409, { error: "period_closed", period: "2026-10", periods: ["2026-10", "2026-07", "2026-09"] })),
    ).toBe("2026-07 已結算，請洽管理者");
    // 只有 periods（亂序，跨年）
    expect(describePeriodClosed(apiError(409, { error: "period_closed", periods: ["2027-01", "2026-12"] }))).toBe(
      "2026-12 已結算，請洽管理者",
    );
    expect(periodClosedPeriod(apiError(409, { error: "period_closed", periods: ["2027-01", "2026-12"] }))).toBe("2026-12");
  });

  it("只剩 message（`[409] period_closed`）、只有 code、只有 body.error → 認得，但沒有月份就用通用說法", () => {
    expect(describePeriodClosed(new Error("[409] period_closed"))).toBe(CLOSED_GENERIC);
    expect(describePeriodClosed(new Error("period_closed"))).toBe(CLOSED_GENERIC);
    expect(describePeriodClosed("[409] period_closed")).toBe(CLOSED_GENERIC);
    expect(describePeriodClosed(Object.assign(new Error("x"), { code: "period_closed" }))).toBe(CLOSED_GENERIC);
    expect(describePeriodClosed(Object.assign(new Error("x"), { body: { error: "period_closed" } }))).toBe(CLOSED_GENERIC);
    // body 只有月份、code 在 Error 上
    expect(describePeriodClosed(Object.assign(new Error("[409] period_closed"), { body: { period: "2026-09" } }))).toBe(CLOSED_2026_09);
    // 沒有月份 → periodClosedPeriod 是 null，但仍然認得
    expect(isPeriodClosedError(new Error("[409] period_closed"))).toBe(true);
    expect(periodClosedPeriod(new Error("[409] period_closed"))).toBeNull();
  });

  it("回應 body 本身、批次簽核的逐張結果也認得", () => {
    expect(describePeriodClosed({ error: "period_closed", period: "2026-09" })).toBe(CLOSED_2026_09);
    expect(describePeriodClosed({ ok: false, id: "req-1", error: "period_closed", period: "2026-10" })).toBe(
      "2026-10 已結算，請洽管理者",
    );
    expect(describePeriodClosed({ ok: false, id: "req-1", error: "period_closed" })).toBe(CLOSED_GENERIC);
  });

  it("月份格式不對（2026-13、abc、數字、空字串）一律忽略；合法的月份仍會被採用", () => {
    expect(describePeriodClosed(apiError(409, { error: "period_closed", period: "2026-13" }))).toBe(CLOSED_GENERIC);
    expect(describePeriodClosed(apiError(409, { error: "period_closed", period: "abc" }))).toBe(CLOSED_GENERIC);
    expect(describePeriodClosed(apiError(409, { error: "period_closed", period: 202609 }))).toBe(CLOSED_GENERIC);
    expect(describePeriodClosed(apiError(409, { error: "period_closed", period: "" }))).toBe(CLOSED_GENERIC);
    expect(describePeriodClosed(apiError(409, { error: "period_closed", periods: ["bad", "2026-10", 5, null] }))).toBe(
      "2026-10 已結算，請洽管理者",
    );
  });

  it("不是 period_closed → false／null：其他 409、其他錯誤、非 Error、空值", () => {
    for (const other of [
      apiError(409, { error: "period_settled" }),
      apiError(409, { error: "checklist_incomplete", period: "2026-09" }),
      apiError(403, { error: "unlock_forbidden", message: "只有老闆…" }),
      new Error("[500] kaboom"),
      new Error("[409] period_closed_xyz"), // 只是長得像
      new Error(""),
      new TypeError("Failed to fetch"),
      { error: "not_found" },
      { message: "hello" },
      "boom",
      "",
      42,
      null,
      undefined,
    ]) {
      expect(isPeriodClosedError(other)).toBe(false);
      expect(periodClosedPeriod(other)).toBeNull();
      expect(describePeriodClosed(other)).toBeNull();
    }
  });
});

describe("errorMessageOf — 只用 err.message 的呼叫端一行替換", () => {
  it("已結算 → 友善中文；其他 Error → 原 message；沒有 message 或不是 Error → fallback", () => {
    expect(errorMessageOf(apiError(409, { error: "period_closed", period: "2026-09" }), "補登失敗")).toBe(CLOSED_2026_09);
    expect(errorMessageOf(new Error("[403] forbidden"), "補登失敗")).toBe("[403] forbidden");
    expect(errorMessageOf(new Error(""), "補登失敗")).toBe("補登失敗");
    expect(errorMessageOf("boom", "補登失敗")).toBe("補登失敗");
    expect(errorMessageOf(undefined, "補登失敗")).toBe("補登失敗");
  });
});

/**
 * 各個畫面共用的錯誤翻譯函式：伺服器回 409 period_closed 時，使用者看到的都是「YYYY-MM 已結算，請洽管理者」，
 * 不是 `[409] period_closed`。（ESS 打卡頁、ESS 簽核頁的是頁面內的 local 函式，沒有辦法在這裡 import，
 * 它們直接呼叫上面測過的 describePeriodClosed。）
 */
describe("共用錯誤翻譯接上 describePeriodClosed", () => {
  const closed = apiError(409, { error: "period_closed", period: "2026-09" });
  const closedMessageOnly = new Error("[409] period_closed");

  it("出勤月表（friendlyError）：產生／重算／逐日修改／送出／審核／核准／退回／重開共用", () => {
    expect(friendlyError(closed, "更新失敗")).toBe(CLOSED_2026_09);
    expect(friendlyError(closedMessageOnly, "更新失敗")).toBe(CLOSED_GENERIC);
    // 既有的翻譯不受影響
    expect(friendlyError(new Error("[409] locked"), "更新失敗")).toBe("此月表已鎖定，不可再變更");
    expect(friendlyError(new Error("[500] kaboom"), "更新失敗")).toBe("[500] kaboom");
  });

  it("申請單送出／撤回（requestErrorText，ESS describeError 用）", () => {
    expect(requestErrorText(closed)).toBe(CLOSED_2026_09);
    expect(requestErrorText(closedMessageOnly)).toBe(CLOSED_GENERIC);
    expect(requestErrorText(new Error("[409] not_pending"))).toBe("這張申請已不是待簽核狀態");
    expect(requestErrorText(new Error("[500] kaboom"))).toBeNull();
  });

  it("報銷送出／修改／撤回（expenseErrorMessage）；報銷月結的 period_settled 維持原本的說明", () => {
    expect(expenseErrorMessage(closed, "送出失敗")).toBe(CLOSED_2026_09);
    expect(expenseErrorMessage(closedMessageOnly, "送出失敗")).toBe(CLOSED_GENERIC);
    expect(expenseErrorMessage(apiError(409, { error: "period_settled" }), "送出失敗")).toContain("月結鎖定");
  });

  it("假單核銷／取消核銷（friendlySettlementError）", () => {
    expect(friendlySettlementError(closed, "核銷失敗")).toBe(CLOSED_2026_09);
    expect(friendlySettlementError(new Error("[403] forbidden"), "核銷失敗")).toBe("沒有權限執行此操作");
  });

  it("遲到說明決定（lateDecisionErrorMessage）", () => {
    expect(lateDecisionErrorMessage(closed)).toBe(CLOSED_2026_09);
    expect(lateDecisionErrorMessage(new Error("[403] not_boss"))).toBe("[403] not_boss");
    expect(lateDecisionErrorMessage("boom")).toBe("決定失敗");
  });

  it("打卡補登匯入（importErrorMessage）：預檢與正式匯入都可能整批 409", () => {
    expect(importErrorMessage(closed)).toBe(CLOSED_2026_09);
    expect(importErrorMessage(new Error("[400] invalid_header"))).toBe("表頭對不上範本，請重新下載範本填寫");
  });

  it("批次簽核逐張結果（describeBatchError）：帶月份就寫月份，沒帶就通用", () => {
    expect(describeBatchError("period_closed", "2026-09")).toBe(CLOSED_2026_09);
    expect(describeBatchError("period_closed")).toBe(CLOSED_GENERIC);
    expect(describeBatchError("period_closed", null)).toBe(CLOSED_GENERIC);
  });

  it("apiErrorMessage（api-client 的通用出口）：已結算友善中文；其餘維持原行為", () => {
    expect(apiErrorMessage(closed)).toBe(CLOSED_2026_09);
    expect(apiErrorMessage(Object.assign(new Error("[409] mail_not_configured"), { serverMessage: "尚未設定 RESEND_API_KEY" }))).toBe(
      "尚未設定 RESEND_API_KEY",
    );
    expect(apiErrorMessage(new Error("[500] kaboom"))).toBe("[500] kaboom");
    expect(apiErrorMessage("boom", "操作失敗")).toBe("操作失敗");
  });
});
