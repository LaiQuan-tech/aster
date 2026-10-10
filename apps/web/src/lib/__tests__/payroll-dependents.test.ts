import { describe, expect, it } from "vitest";
import { buildNhiDependentBody, buildTaxDependentBody, dependentErrorMessage } from "../payroll-dependents";

/**
 * lib/payroll-dependents.ts：薪資作業頁「新增健保眷屬／新增扶養親屬」的送出判斷。
 * 重點是「送出內容不變」——以 JSON 字串（含鍵順序）對照抽出前頁面內聯的組法；全部是明顯的假值，repo 是公開的。
 */

const EMP = "00000000-0000-4000-8000-000000000001";

describe("buildNhiDependentBody", () => {
  it("姓名／關係／證號去頭尾空白，送出的 JSON 與抽出前內聯的組法逐字相同", () => {
    const r = buildNhiDependentBody(EMP, { name: "  測試眷屬甲 ", relationship: " 配偶 ", idNumber: " A100000001 ", insured: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.body)).toBe(
      `{"employeeId":"${EMP}","name":"測試眷屬甲","relationship":"配偶","idNumber":"A100000001","insured":false}`,
    );
  });

  it("關係／證號留空（或只有空白）就不帶；投保中照傳", () => {
    const r = buildNhiDependentBody(EMP, { name: "測試眷屬乙", relationship: "", idNumber: "   ", insured: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.relationship).toBeUndefined();
    expect(r.body.idNumber).toBeUndefined();
    expect(JSON.stringify(r.body)).toBe(`{"employeeId":"${EMP}","name":"測試眷屬乙","insured":true}`);
  });

  it.each([
    ["空字串", ""],
    ["半形空白", "   "],
    ["全形空白", "　　"],
    ["tab／換行", "\t\n"],
  ])("姓名是%s：不送 API，回傳提示", (_label, name) => {
    expect(buildNhiDependentBody(EMP, { name, relationship: "配偶", idNumber: "A100000001", insured: true })).toEqual({
      ok: false,
      error: "請輸入眷屬姓名",
    });
  });
});

describe("buildTaxDependentBody", () => {
  it("姓名／關係／證號去頭尾空白，出生年轉成數字，送出的 JSON 與抽出前內聯的組法逐字相同", () => {
    const r = buildTaxDependentBody(EMP, { name: " 測試親屬甲  ", relationship: " 母 ", idNumber: " B100000001 ", birthYear: "1950" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.birthYear).toBe(1950);
    expect(JSON.stringify(r.body)).toBe(
      `{"employeeId":"${EMP}","name":"測試親屬甲","relationship":"母","idNumber":"B100000001","birthYear":1950}`,
    );
  });

  it("出生年／關係／證號沒填就不帶", () => {
    const r = buildTaxDependentBody(EMP, { name: "測試親屬乙", relationship: " ", idNumber: "", birthYear: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.birthYear).toBeUndefined();
    expect(JSON.stringify(r.body)).toBe(`{"employeeId":"${EMP}","name":"測試親屬乙"}`);
  });

  it("前端不替 API 擋出生年（超出 int32 的整數照送，由 API／DB 回錯）——送出內容不變", () => {
    const r = buildTaxDependentBody(EMP, { name: "測試親屬丙", relationship: "", idNumber: "", birthYear: "99999999999" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.birthYear).toBe(99999999999);
  });

  it.each([
    ["空字串", ""],
    ["半形空白", "  "],
    ["全形空白", "　"],
  ])("姓名是%s：不送 API，回傳提示", (_label, name) => {
    expect(buildTaxDependentBody(EMP, { name, relationship: "母", idNumber: "B100000001", birthYear: "1950" })).toEqual({
      ok: false,
      error: "請輸入親屬姓名",
    });
  });
});

describe("dependentErrorMessage", () => {
  it("Error：動作名稱＋失敗＋apiFetch 的 `[status] code`", () => {
    expect(dependentErrorMessage(new Error("[400] invalid_body"), "新增健保眷屬")).toBe("新增健保眷屬失敗：[400] invalid_body");
    expect(dependentErrorMessage(new Error("[500] internal_server_error"), "新增扶養親屬")).toBe(
      "新增扶養親屬失敗：[500] internal_server_error",
    );
  });

  it("沒有訊息的 Error／非 Error（字串、null、物件）：只剩「…失敗」", () => {
    expect(dependentErrorMessage(new Error(""), "新增健保眷屬")).toBe("新增健保眷屬失敗");
    expect(dependentErrorMessage("boom", "新增健保眷屬")).toBe("新增健保眷屬失敗");
    expect(dependentErrorMessage(null, "新增扶養親屬")).toBe("新增扶養親屬失敗");
    expect(dependentErrorMessage({ message: "x" }, "新增扶養親屬")).toBe("新增扶養親屬失敗");
  });
});
