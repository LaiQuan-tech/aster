import { describe, expect, it } from "vitest";
import { BOSS_STEP_NOTE, OWN_REQUEST_TEXT, isOwnRequestError, stepCandidatesLine } from "../approval-view";
import { describeBatchError } from "../ess-approval-batch";

/** 2026-10-27 驗收：後台簽核頁 own_request 翻中文；放款待簽頁老闆關補註。 */
describe("own_request 文案", () => {
  it("與 ESS 待我簽核同一句", () => {
    expect(OWN_REQUEST_TEXT).toBe("不能簽核自己的單。");
    expect(describeBatchError("own_request")).toBe(OWN_REQUEST_TEXT);
  });

  it("認得 apiFetch 丟的 Error（訊息／code／body）與批次逐張錯誤碼", () => {
    expect(isOwnRequestError(new Error("[403] own_request"))).toBe(true);
    expect(isOwnRequestError(new Error("own_request"))).toBe(true);
    expect(isOwnRequestError(Object.assign(new Error("x"), { code: "own_request" }))).toBe(true);
    expect(isOwnRequestError(Object.assign(new Error("x"), { body: { error: "own_request" } }))).toBe(true);
    expect(isOwnRequestError("own_request")).toBe(true);
  });

  it("其他錯誤不誤判", () => {
    expect(isOwnRequestError(new Error("[403] not_current_approver"))).toBe(false);
    expect(isOwnRequestError(new Error("[403] own_request_extra"))).toBe(false);
    expect(isOwnRequestError("period_closed")).toBe(false);
    expect(isOwnRequestError(null)).toBe(false);
  });
});

describe("放款待簽：本關可簽標籤", () => {
  it("老闆關（fallback）補註「（平台管理員（老闆））」", () => {
    expect(stepCandidatesLine(["老闆大頭"], "fallback")).toBe(`本關可簽：老闆大頭${BOSS_STEP_NOTE}`);
    expect(BOSS_STEP_NOTE).toBe("（平台管理員（老闆））");
  });
  it("其他關不補註；沒名字不顯示", () => {
    expect(stepCandidatesLine(["主管甲", "主管乙"], "manager")).toBe("本關可簽：主管甲、主管乙");
    expect(stepCandidatesLine(["會計丙"], null)).toBe("本關可簽：會計丙");
    expect(stepCandidatesLine([], "fallback")).toBeNull();
  });
});
