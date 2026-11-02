import { describe, expect, it } from "vitest";
import { consentTrust, safeNextPath } from "../mcp-safety";

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
    "/ess",
    "/admin",
    "/oauth/consent/../../admin",
    "/mcp/confirm/not-a-uuid",
    " /oauth/consent",
    "",
  ])("拒絕 %j", (next) => {
    expect(safeNextPath(next, ORIGIN)).toBeNull();
  });
  it("null／undefined → null", () => {
    expect(safeNextPath(null, ORIGIN)).toBeNull();
    expect(safeNextPath(undefined, ORIGIN)).toBeNull();
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
