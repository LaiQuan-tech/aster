import { describe, expect, it } from "vitest";
import { LATE_SHEET_FROZEN_MESSAGE, lateDecisionErrorMessage } from "../late-reports-api";

/**
 * 遲到說明「決定」失敗的 toast 文字（2026-10-12 驗收第 9 條）：原本 409 sheet_frozen 直接顯示
 * `[409] sheet_frozen`。現在一律中文：sheet_frozen 固定一句、period_closed 維持原本的中文、
 * 其他碼優先用 API 附的中文 message，沒有就用代碼對照的中文，再沒有就用 fallback。
 * 錯誤碼與 message 對照 apps/api/src/routes/late-reports.ts。
 */

/** 照 apiFetch 的樣子組 Error：message `[status] error碼`，另外掛 status／code／detail／serverMessage／body。 */
function apiError(status: number, body: Record<string, unknown>): Error {
  const message = (body.error ?? body.message ?? "error") as string;
  const err = new Error(`[${status}] ${message}`) as Error & Record<string, unknown>;
  err.status = status;
  if (typeof body.error === "string") err.code = body.error;
  if (typeof body.message === "string" && body.message !== message) err.detail = body.message;
  if (typeof body.message === "string" && body.message.trim()) err.serverMessage = body.message;
  err.body = body;
  return err;
}

const FROZEN_API_MESSAGE = "這個月的出勤月表已核准，薪資照核准當下計算；要改請先退回或重開月表";

describe("lateDecisionErrorMessage — sheet_frozen", () => {
  it("月表已核准（status approved）→ 固定中文，不用 API 那句、不露原碼", () => {
    const err = apiError(409, { error: "sheet_frozen", status: "approved", message: FROZEN_API_MESSAGE });
    expect(err.message).toBe("[409] sheet_frozen"); // 使用者原本看到的樣子
    expect(lateDecisionErrorMessage(err)).toBe("本月出勤表已核准或鎖定，不能再改，請洽 HR");
    expect(LATE_SHEET_FROZEN_MESSAGE).toBe("本月出勤表已核准或鎖定，不能再改，請洽 HR");
  });

  it("月表已鎖定（status locked）→ 同一句", () => {
    const err = apiError(409, { error: "sheet_frozen", status: "locked", message: FROZEN_API_MESSAGE });
    expect(lateDecisionErrorMessage(err)).toBe(LATE_SHEET_FROZEN_MESSAGE);
  });

  it("只剩訊息（`[409] sheet_frozen`）、只有 body、只有 code 也認得", () => {
    expect(lateDecisionErrorMessage(new Error("[409] sheet_frozen"))).toBe(LATE_SHEET_FROZEN_MESSAGE);
    expect(lateDecisionErrorMessage(Object.assign(new Error("x"), { body: { error: "sheet_frozen" } }))).toBe(LATE_SHEET_FROZEN_MESSAGE);
    expect(lateDecisionErrorMessage(Object.assign(new Error("x"), { code: "sheet_frozen" }))).toBe(LATE_SHEET_FROZEN_MESSAGE);
  });
});

describe("lateDecisionErrorMessage — 其他錯誤", () => {
  it("period_closed（那天所在月份已發薪鎖定）維持原本的中文", () => {
    expect(lateDecisionErrorMessage(apiError(409, { error: "period_closed", period: "2026-09" }))).toBe("2026-09 已結算，請洽管理者");
    expect(lateDecisionErrorMessage(new Error("[409] period_closed"))).toBe("該月份已結算，請洽管理者");
  });

  it("not_boss：用 API 附的中文；只剩 `[403] not_boss` 時用對照的中文", () => {
    expect(lateDecisionErrorMessage(apiError(403, { error: "not_boss", message: "只有老闆可以決定遲到是否影響全勤" }))).toBe(
      "只有老闆可以決定遲到是否影響全勤",
    );
    expect(lateDecisionErrorMessage(new Error("[403] not_boss"))).toBe("只有老闆可以決定遲到是否影響全勤");
  });

  it("API 沒附 message 的碼（not_found、invalid_body、not_an_employee、unauthorized）→ 對照的中文", () => {
    expect(lateDecisionErrorMessage(apiError(404, { error: "not_found" }))).toBe("找不到這筆遲到說明，請重新整理後再試");
    expect(lateDecisionErrorMessage(apiError(400, { error: "invalid_body", details: {} }))).toBe("送出的內容格式不正確");
    expect(lateDecisionErrorMessage(apiError(403, { error: "not_an_employee" }))).toBe("此帳號尚未對應到員工資料");
    expect(lateDecisionErrorMessage(apiError(401, { error: "unauthorized" }))).toBe("登入已過期，請重新登入");
  });

  it("未知的碼：有中文 message 就用 message，沒有就用 fallback（可自訂）", () => {
    expect(lateDecisionErrorMessage(apiError(409, { error: "brand_new_rule", message: "這筆已被其他人處理" }))).toBe("這筆已被其他人處理");
    expect(lateDecisionErrorMessage(apiError(418, { error: "brand_new_rule" }))).toBe("決定失敗");
    expect(lateDecisionErrorMessage(apiError(418, { error: "brand_new_rule" }), "操作失敗")).toBe("操作失敗");
    expect(lateDecisionErrorMessage(apiError(500, { error: "internal_server_error" }))).toBe("決定失敗");
  });

  it("英文的 message（例如 statusText）不拿來顯示", () => {
    expect(lateDecisionErrorMessage(apiError(429, { error: "rate_limited", message: "Too Many Requests" }))).toBe("決定失敗");
    expect(lateDecisionErrorMessage(apiError(502, { message: "Bad Gateway" }))).toBe("決定失敗");
  });

  it("不是 API 錯誤（網路斷線、字串、空值）→ fallback", () => {
    expect(lateDecisionErrorMessage(new TypeError("Failed to fetch"))).toBe("決定失敗");
    expect(lateDecisionErrorMessage("boom")).toBe("決定失敗");
    expect(lateDecisionErrorMessage(null)).toBe("決定失敗");
    expect(lateDecisionErrorMessage(undefined)).toBe("決定失敗");
    expect(lateDecisionErrorMessage(Object.assign(new Error("[400] constructor"), { code: "constructor" }))).toBe("決定失敗");
  });

  it("任何情況都不露出 `[409] sheet_frozen` 這種原碼", () => {
    const errors: unknown[] = [
      apiError(409, { error: "sheet_frozen", status: "approved", message: FROZEN_API_MESSAGE }),
      apiError(409, { error: "sheet_frozen", status: "locked" }),
      new Error("[409] sheet_frozen"),
      apiError(409, { error: "period_closed", period: "2026-09" }),
      apiError(403, { error: "not_boss", message: "只有老闆可以決定遲到是否影響全勤" }),
      new Error("[403] not_boss"),
      apiError(404, { error: "not_found" }),
      apiError(400, { error: "invalid_body" }),
      apiError(418, { error: "brand_new_rule" }),
      apiError(500, { error: "internal_server_error" }),
      new TypeError("Failed to fetch"),
    ];
    for (const err of errors) {
      const text = lateDecisionErrorMessage(err);
      expect(text).not.toMatch(/\[\d{3}\]/);
      expect(text).not.toMatch(/[a-z]+_[a-z_]+/);
      expect(text).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
