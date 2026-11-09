import { describe, expect, it } from "vitest";
import { consentTrust, loginRedirectPath, safeNextPath } from "../mcp-safety";

const ORIGIN = "https://aster-system.vercel.app";
const ID = "11111111-2222-4333-8444-555555555555";

describe("safeNextPath（登入回跳，資安驗收 M2）", () => {
  it("只放行同源的 /oauth/consent（可帶 query）與 /mcp/confirm/<uuid>", () => {
    expect(safeNextPath("/oauth/consent?req=abc.def", ORIGIN)).toBe("/oauth/consent?req=abc.def");
    expect(safeNextPath(`/mcp/confirm/${ID}`, ORIGIN)).toBe(`/mcp/confirm/${ID}`);
  });
  it.each([
    "/%09/evil.com",
    "/\t/evil.com",
    "//evil.com",
    "/\\evil.com",
    "https://evil.com/oauth/consent",
    "https://evil.com/ess",
    "//evil.com/ess",
    "/\\evil.com/ess",
    "/ess\\..\\evil",
    "javascript:alert(1)",
    "/%2F%2Fevil.com",
    "/login",
    "/essx",
    "/auth/set-password",
    "/mcp/confirm/not-a-uuid",
    " /oauth/consent",
    "",
  ])("拒絕 %j", (next) => {
    expect(safeNextPath(next, ORIGIN)).toBeNull();
  });
  it("站內 /ess、/admin 頁（通知信深連結，2026-11-09）放行，保留 query", () => {
    expect(safeNextPath("/ess", ORIGIN)).toBe("/ess");
    expect(safeNextPath("/ess/approvals?id=abc-123", ORIGIN)).toBe("/ess/approvals?id=abc-123");
    expect(safeNextPath("/admin/approvals?status=pending&id=r1", ORIGIN)).toBe("/admin/approvals?status=pending&id=r1");
    // ../ 會被正規化成站內路徑（仍同源，不是外部轉址）
    expect(safeNextPath("/oauth/consent/../../admin", ORIGIN)).toBe("/admin");
  });
  it("null／undefined → null", () => {
    expect(safeNextPath(null, ORIGIN)).toBeNull();
    expect(safeNextPath(undefined, ORIGIN)).toBeNull();
  });
});

describe("loginRedirectPath（AuthGate 未登入導登入頁，帶 next）", () => {
  it("站內頁帶 next=路徑＋query（URL 編碼）", () => {
    expect(loginRedirectPath("/ess/approvals", "?id=abc", ORIGIN)).toBe("/login?next=%2Fess%2Fapprovals%3Fid%3Dabc");
    expect(loginRedirectPath("/admin/approvals", "status=pending&id=r1", ORIGIN)).toBe(
      "/login?next=%2Fadmin%2Fapprovals%3Fstatus%3Dpending%26id%3Dr1",
    );
    expect(loginRedirectPath("/ess", "", ORIGIN)).toBe("/login?next=%2Fess");
  });
  it("不合法或非站內頁 → 只導 /login", () => {
    expect(loginRedirectPath(null, null, ORIGIN)).toBe("/login");
    expect(loginRedirectPath("//evil.com", "", ORIGIN)).toBe("/login");
    expect(loginRedirectPath("/auth/set-password", "?x=1", ORIGIN)).toBe("/login");
  });
});

describe("consentTrust（同意頁警示，資安驗收 M5）", () => {
  it("官方網域與本機視為已驗證", () => {
    expect(consentTrust("Claude", "claude.ai")).toMatchObject({ verified: true, nameMismatch: false });
    expect(consentTrust("ChatGPT", "chatgpt.com")).toMatchObject({ verified: true, nameMismatch: false });
    expect(consentTrust("Claude Code", "localhost:33418")).toMatchObject({ verified: true, nameMismatch: false });
    expect(consentTrust("my tool", "127.0.0.1:9000").verified).toBe(true);
  });
  it("其他網域未驗證；冒用品牌名稱 → nameMismatch", () => {
    expect(consentTrust("Claude", "claude.ai.evil.com")).toMatchObject({ verified: false, nameMismatch: true, hostname: "claude.ai.evil.com" });
    expect(consentTrust("OpenAI helper", "evil.example")).toMatchObject({ verified: false, nameMismatch: true });
    expect(consentTrust("Some App", "app.example.com")).toMatchObject({ verified: false, nameMismatch: false });
  });
});
