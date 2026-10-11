import { describe, expect, it, vi } from "vitest";

vi.mock("../api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("../supabase-browser", () => ({ getSupabaseBrowser: () => ({}) }));

import { changeParentCodeOf } from "../dashboard-api";

/**
 * 後台首頁「最近變更案」卡片的「原案」（2026-10-11）：用母案（parent_project_id）那一列的編號，
 * 不再從編號格式（`{原案 code}-{n}`）反推。母案是選填（2026-09-30 起）——沒有母案就沒有原案。
 */

describe("changeParentCodeOf — 原案編號＝母案的編號", () => {
  it("有母案、API 回了母案編號 → 該編號（不管變更案自己的編號長什麼樣）", () => {
    expect(changeParentCodeOf({ parentProjectId: "p1", parentCode: "AT-115-013" })).toBe("AT-115-013");
    // 編號不是 {原案}-{n} 慣例的變更案，原案也照母案算
    expect(changeParentCodeOf({ parentProjectId: "p1", parentCode: "AT-115-001" })).toBe("AT-115-001");
  });

  it("沒有母案 → null；不從編號格式反推（以前 AT-115-013-1 會被反推成「原案 AT-115-013」）", () => {
    expect(changeParentCodeOf({ parentProjectId: null, parentCode: null })).toBeNull();
    expect(changeParentCodeOf({ parentProjectId: undefined, parentCode: undefined })).toBeNull();
    // 就算 parentCode 殘留值，沒有母案 id 就是沒有母案
    expect(changeParentCodeOf({ parentProjectId: null, parentCode: "AT-115-013" })).toBeNull();
  });

  it("有母案 id 但編號查不到（母案列不見，或舊版 API 沒回 parentCode）→ null，卡片不印「原案」", () => {
    expect(changeParentCodeOf({ parentProjectId: "p1", parentCode: null })).toBeNull();
    expect(changeParentCodeOf({ parentProjectId: "p1" })).toBeNull();
  });
});
