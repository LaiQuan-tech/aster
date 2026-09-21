import { describe, it, expect } from "vitest";
import { employeeActionsFor, parseApiErrorCode, type ActionSpec } from "../employee-actions";

const keys = (list: ActionSpec[]) => list.map((a) => a.key);
const byKey = (list: ActionSpec[], key: ActionSpec["key"]) => list.find((a) => a.key === key);

const active = { status: "active", user_id: "user-1" };
const noAccount = { status: "active", user_id: null };
const inactive = { status: "inactive", user_id: "user-1" };

describe("employeeActionsFor — 對應原頁那排連結的條件", () => {
  it("在職＋已綁帳號：My Data／寄重設密碼信／暫時密碼／停用／異動紀錄，且沒有寄邀請信", () => {
    expect(keys(employeeActionsFor(active, { isSelf: false }))).toEqual([
      "profile",
      "send-reset",
      "temp-password",
      "deactivate",
      "audit",
    ]);
  });

  it("未開通帳號（user_id 為 null）：寄邀請信取代寄重設密碼信＋暫時密碼；My Data 仍可用", () => {
    const list = employeeActionsFor(noAccount, { isSelf: false });
    expect(keys(list)).toEqual(["profile", "send-invite", "deactivate", "audit"]);
    expect(byKey(list, "temp-password")).toBeUndefined();
    expect(byKey(list, "send-reset")).toBeUndefined();
    expect(byKey(list, "profile")?.disabled).toBeFalsy();
  });

  it("inactive 員工：不出現「停用」，也沒有另發明的「啟用」（原頁走編輯裡的狀態下拉）", () => {
    const list = employeeActionsFor(inactive, { isSelf: false });
    expect(keys(list)).toEqual(["profile", "send-reset", "temp-password", "audit"]);
    expect(list.some((a) => a.label === "啟用")).toBe(false);
  });

  it("停用是紅字（danger）、暫時密碼是灰字備援（muted）並帶原本的 title 說明", () => {
    const list = employeeActionsFor(active, { isSelf: false });
    expect(byKey(list, "deactivate")?.tone).toBe("danger");
    expect(byKey(list, "temp-password")?.tone).toBe("muted");
    expect(byKey(list, "temp-password")?.title).toBe("寄不了信時的備援：產生暫時密碼");
  });

  it("該列請求進行中（busy）：寄重設密碼信與暫時密碼 disabled，其餘不受影響", () => {
    const list = employeeActionsFor(active, { isSelf: false, busy: true });
    expect(byKey(list, "send-reset")?.disabled).toBe(true);
    expect(byKey(list, "temp-password")?.disabled).toBe(true);
    expect(byKey(list, "profile")?.disabled).toBeFalsy();
    expect(byKey(list, "deactivate")?.disabled).toBeFalsy();
    expect(byKey(list, "audit")?.disabled).toBeFalsy();
  });

  it("busy 時未開通帳號者的寄邀請信也 disabled；不 busy 時可按", () => {
    expect(byKey(employeeActionsFor(noAccount, { isSelf: false, busy: true }), "send-invite")?.disabled).toBe(true);
    expect(byKey(employeeActionsFor(noAccount, { isSelf: false }), "send-invite")?.disabled).toBeFalsy();
  });

  it("isSelf 目前不改變結果（原頁與 API 都沒有「不能停用自己」的規則）", () => {
    expect(employeeActionsFor(active, { isSelf: true })).toEqual(employeeActionsFor(active, { isSelf: false }));
    expect(byKey(employeeActionsFor(active, { isSelf: true }), "deactivate")).toBeDefined();
  });

  it("user_id 為空字串視同未綁帳號", () => {
    expect(keys(employeeActionsFor({ status: "active", user_id: "" }, { isSelf: false }))).toContain("send-invite");
  });
});

describe("parseApiErrorCode — 解析 apiFetch 的 `[狀態碼] 代碼` 格式", () => {
  it("[422] weak_password → weak_password", () => {
    expect(parseApiErrorCode("[422] weak_password")).toBe("weak_password");
  });

  it("[409] email_exists → email_exists；前後空白不影響", () => {
    expect(parseApiErrorCode("  [409] email_exists \n")).toBe("email_exists");
  });

  it("後半段不是單一代碼（statusText、自由文字）→ null", () => {
    expect(parseApiErrorCode("[404] Not Found")).toBeNull();
    expect(parseApiErrorCode("[500] GET /employees: relation does not exist")).toBeNull();
  });

  it("沒有 [狀態碼] 前綴的字串 → null（包括裸代碼與空字串）", () => {
    expect(parseApiErrorCode("weak_password")).toBeNull();
    expect(parseApiErrorCode("邀請失敗")).toBeNull();
    expect(parseApiErrorCode("")).toBeNull();
  });
});
