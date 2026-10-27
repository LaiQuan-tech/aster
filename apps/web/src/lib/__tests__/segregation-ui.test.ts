import { describe, expect, it } from "vitest";
import { rowActionsFor } from "../approval-view";
import { canDecideBonusRun, humanizeBonusError, SELF_SUBMITTED_NOTE } from "../bonus-api";
import { humanizeDisbursementError } from "../disbursements-api";
import { lateDecisionErrorMessage, OWN_LATE_REPORT_NOTE } from "../late-reports-api";
import { accountErrorMessage } from "../auth-api";

/** 2026-10-27 職責分離的畫面規則（純函式）。 */
const ME = "me-0000";
const OTHER = "other-0000";

describe("後台簽核頁：每列操作", () => {
  const keys = (row: { employee_id: string; current_step_kind?: string }, bucket: Parameters<typeof rowActionsFor>[1]) =>
    rowActionsFor(row as never, bucket, ME).map((a) => a.key);

  it("自己的單：沒有核准／駁回／代理簽核／變更簽核人（其餘照舊；安全驗收 M1）", () => {
    expect(keys({ employee_id: ME }, "pending_mine")).toEqual(["delete", "attachments"]);
    expect(keys({ employee_id: ME }, "in_progress")).toEqual(["remind", "delete", "attachments"]);
  });

  it("老闆關：沒有代理簽核；變更簽核人只給老闆／平台管理員（安全驗收 H1）；其他關照舊", () => {
    expect(keys({ employee_id: OTHER, current_step_kind: "fallback" }, "in_progress")).toEqual(["remind", "delete", "attachments"]);
    expect(keys({ employee_id: OTHER, current_step_kind: "manager" }, "in_progress")).toContain("proxy_approve");
    expect(keys({ employee_id: OTHER, current_step_kind: "manager" }, "in_progress")).toContain("change_approver");
    expect(keys({ employee_id: OTHER, current_step_kind: "fallback" }, "pending_mine")).toEqual(["approve", "reject", "delete", "attachments"]);
    const asBoss = rowActionsFor({ employee_id: OTHER, current_step_kind: "fallback" } as never, "in_progress", ME, { canActAsBoss: true }).map((a) => a.key);
    expect(asBoss).toEqual(["remind", "change_approver", "delete", "attachments"]);
    // L3：沒有任何可簽的老闆／平台管理員 → HR 看得到代理簽核
    expect(keys({ employee_id: OTHER, current_step_kind: "fallback", boss_step_hr_fallback: true } as never, "in_progress")).toContain("proxy_approve");
  });
});

describe("獎金批次：送審人不能核准／退回自己送審的", () => {
  it("canDecideBonusRun：老闆／平台管理員且不是送審人才可以", () => {
    expect(canDecideBonusRun({ canApprove: true, selfSubmitted: false })).toBe(true);
    expect(canDecideBonusRun({ canApprove: true })).toBe(true);
    expect(canDecideBonusRun({ canApprove: true, selfSubmitted: true })).toBe(false);
    expect(canDecideBonusRun({ canApprove: false, selfSubmitted: false })).toBe(false);
    expect(canDecideBonusRun(null)).toBe(false);
  });
  it("錯誤碼翻中文", () => {
    expect(humanizeBonusError(new Error("[403] self_approval_forbidden"), "x")).toContain("不能核准或退回自己送審");
    expect(humanizeBonusError(new Error("[409] no_other_approver"), "x")).toContain("沒有人能核准");
    expect(humanizeBonusError(new Error("[403] not_approver"), "x")).toContain("只有老闆");
    expect(SELF_SUBMITTED_NOTE).toContain("送審人");
  });
});

describe("放款單／遲到說明／員工狀態 錯誤文案", () => {
  it("放款單：own_request 含送簽人、already_signed_step 有中文", () => {
    expect(humanizeDisbursementError(new Error("[403] own_request"), "x")).toBe("不能簽核或變更自己建立、送簽或編輯過的放款單。");
    expect(humanizeDisbursementError(new Error("[403] already_signed_step"), "x")).toContain("同一輪不能再簽下一關");
  });
  it("遲到說明：own_late_report 有中文（API 附中文 message 時優先用它）", () => {
    expect(lateDecisionErrorMessage(new Error("[403] own_late_report"))).toBe("不能決定自己的遲到說明，請由其他平台管理員（老闆）決定");
    expect(OWN_LATE_REPORT_NOTE).toContain("自己的遲到說明");
  });
  it("員工在職狀態：not_boss 文案含在職狀態", () => {
    expect(accountErrorMessage(new Error("not_boss"), "")).toContain("在職狀態");
  });
});
