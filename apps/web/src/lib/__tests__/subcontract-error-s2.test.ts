import { describe, expect, it } from "vitest";
import { humanizeSubcontractError } from "../projects-ext-api";

const apiErr = (code: string, status: number, serverMessage?: string) =>
  Object.assign(new Error(`[${status}] ${code}`), { code, status, ...(serverMessage ? { serverMessage } : {}) });

describe("humanizeSubcontractError（2026-11-17 S2 擴大）", () => {
  it("conflict_retry／rebind_requires_boss／subcontract_delete_requires_boss 優先顯示後端說明", () => {
    expect(humanizeSubcontractError(apiErr("conflict_retry", 409, "這筆副委託剛被綁定名冊廠商，沒有儲存這一列；請重新整理後再試"), "x")).toBe(
      "這筆副委託剛被綁定名冊廠商，沒有儲存這一列；請重新整理後再試",
    );
    expect(humanizeSubcontractError(apiErr("rebind_requires_boss", 403, "後端說明"), "x")).toBe("後端說明");
  });
  it("沒有後端說明 → 對照表中文", () => {
    expect(humanizeSubcontractError(apiErr("conflict_retry", 409), "x")).toContain("請重新整理後再試");
    expect(humanizeSubcontractError(apiErr("subcontract_delete_requires_boss", 403), "x")).toContain("只限老闆或平台管理員");
  });
});
