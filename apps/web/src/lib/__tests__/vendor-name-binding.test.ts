import { describe, it, expect } from "vitest";
import { engineerForTypedName, humanizeVendorIdentityError, vendorIdForTypedName } from "../vendor-name-binding";

/**
 * VendorCombo 手改名稱欄時 vendorId 的綁定規則（2026-11-16）。
 * ⚠️ 名稱都是明顯的假值（repo 是公開的）。
 */
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const DUP1 = "aaaaaaaa-0000-4000-8000-000000000003";
const DUP2 = "aaaaaaaa-0000-4000-8000-000000000004";
const vendors = [
  { id: A, name: "測試甲廠商" },
  { id: B, name: " 測試乙廠商 " },
  { id: DUP1, name: "測試同名廠商" },
  { id: DUP2, name: "測試同名廠商 " },
];

describe("vendorIdForTypedName — VendorCombo 手改名稱時的 vendorId", () => {
  it("選了甲之後改名成別的字 → null（不再掛甲）", () => {
    expect(vendorIdForTypedName(vendors, A, "測試甲廠商X")).toBeNull();
    expect(vendorIdForTypedName(vendors, A, "測試名冊外廠商")).toBeNull();
  });

  it("選了甲後改成名冊上的乙（trim 相同）→ 綁到乙", () => {
    expect(vendorIdForTypedName(vendors, A, "測試乙廠商")).toBe(B);
  });

  it("清掉後再打回「甲」→ 綁回甲；前後空白不計", () => {
    expect(vendorIdForTypedName(vendors, null, "測試甲廠商")).toBe(A);
    expect(vendorIdForTypedName(vendors, null, "  測試甲廠商 ")).toBe(A);
  });

  it("未改名（或只多空白）→ 保留已選的 id", () => {
    expect(vendorIdForTypedName(vendors, A, "測試甲廠商")).toBe(A);
    expect(vendorIdForTypedName(vendors, A, "測試甲廠商 ")).toBe(A);
  });

  it("同名多筆：手打名稱不自動綁（null）", () => {
    expect(vendorIdForTypedName(vendors, null, "測試同名廠商")).toBeNull();
    expect(vendorIdForTypedName(vendors, A, "測試同名廠商")).toBeNull();
  });

  it("同名多筆：使用者明確下拉選的那筆在名稱未變時保留，不換成另一筆", () => {
    expect(vendorIdForTypedName(vendors, DUP2, "測試同名廠商")).toBe(DUP2);
    expect(vendorIdForTypedName(vendors, DUP1, "測試同名廠商 ")).toBe(DUP1);
  });

  it("空白名稱 → null", () => {
    expect(vendorIdForTypedName(vendors, A, "")).toBeNull();
    expect(vendorIdForTypedName(vendors, A, "   ")).toBeNull();
  });

  it("已選 id 不在名冊清單（例如已刪）且名稱無相符 → null", () => {
    expect(vendorIdForTypedName(vendors, "aaaaaaaa-0000-4000-8000-0000000000ff", "測試已刪廠商")).toBeNull();
  });
});

describe("engineerForTypedName — 申請單協力技師欄手打名稱（同 vendorIdForTypedName 規則）", () => {
  it("名冊同名兩筆：不自動綁第一筆，當自由輸入", () => {
    expect(engineerForTypedName(vendors, null, "測試同名廠商")).toEqual({ vendorId: null, name: "測試同名廠商" });
  });

  it("原本已綁定 DUP2、名稱未變：保留 DUP2，不換成名冊第一筆 DUP1", () => {
    expect(engineerForTypedName(vendors, DUP2, "測試同名廠商")).toEqual({ vendorId: DUP2, name: "測試同名廠商 " });
  });

  it("名冊剛好一筆相符 → 綁該筆、名稱用名冊名稱；沒有相符 → 自由輸入且不 trim", () => {
    expect(engineerForTypedName(vendors, null, "測試甲廠商")).toEqual({ vendorId: A, name: "測試甲廠商" });
    expect(engineerForTypedName(vendors, A, "測試自由 ")).toEqual({ vendorId: null, name: "測試自由 " });
  });
});

describe("humanizeVendorIdentityError — 名冊同時改名稱與帳戶被 409 擋下", () => {
  it("[409] vendor_identity_change → 中文說明；其他訊息原樣", () => {
    expect(humanizeVendorIdentityError("[409] vendor_identity_change")).toMatch(/請新增廠商.*分兩次修改/);
    expect(humanizeVendorIdentityError("[500] boom")).toBe("[500] boom");
  });
});
