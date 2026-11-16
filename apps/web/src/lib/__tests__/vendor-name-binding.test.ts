import { describe, it, expect, vi } from "vitest";
import { engineerForTypedName, humanizeVendorDeleteError, humanizeVendorIdentityError, isChangeReasonRequired, similarNameConflict, vendorIdForTypedName, withSimilarNameConfirm } from "../vendor-name-binding";
import { createProjectExtWithConfirm, duplicateSubcontractWarningText, humanizeProjectExtError, humanizeSubcontractError, putProjectSubcontractsWithRebind } from "../projects-ext-api";
import { humanizeDisbursementError } from "../disbursements-api";
import * as apiClient from "../api-client";

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
    expect(humanizeVendorIdentityError("[409] vendor_identity_change")).toMatch(/請新增廠商/);
    expect(humanizeVendorIdentityError("[409] vendor_identity_change")).not.toMatch(/分兩次/);
    expect(humanizeVendorIdentityError("[409] vendor_has_open_disbursements")).toBe("此廠商仍有未匯款的放款單，請先作廢或匯款後再更改收款帳戶");
    expect(humanizeVendorIdentityError("[400] change_reason_required")).toMatch(/變更原因/);
    expect(isChangeReasonRequired("[400] change_reason_required")).toBe(true);
    expect(isChangeReasonRequired("[409] vendor_has_open_disbursements")).toBe(false);
    expect(humanizeVendorIdentityError("[500] boom")).toBe("[500] boom");
  });
});

describe("第五輪（2026-11-17）中文訊息", () => {
  it("名稱不可見字元、刪除仍有往來的廠商、副委託須綁名冊廠商", () => {
    expect(humanizeVendorIdentityError("[400] invalid_vendor_name")).toBe("名稱含有不可見字元或西里爾／希臘字母，請重新輸入");
    // 第六輪：名冊重名 → 優先顯示後端帶廠商名稱的訊息
    expect(humanizeVendorIdentityError("[409] vendor_name_duplicate", "名冊已有同名廠商「測試甲工程行」")).toBe("名冊已有同名廠商「測試甲工程行」");
    expect(humanizeVendorIdentityError("[409] vendor_name_duplicate")).toBe("名冊已有同名廠商");
    expect(humanizeVendorDeleteError("[409] vendor_in_use")).toBe("此廠商仍有未付期款或未匯款的放款單，不能刪除");
    expect(humanizeVendorDeleteError("[500] boom")).toBe("[500] boom");
    expect(humanizeSubcontractError(new Error("[409] must_bind_vendor"), "x")).toBe("此名稱與名冊廠商名稱相同，請在下拉選擇該廠商。");
    // 第六輪：後端帶副委託名稱與撞到的名冊廠商名稱 → 具名訊息（副委託卡、申請單、新建專案表單共用）
    const named = Object.assign(new Error("[409] must_bind_vendor"), { body: { error: "must_bind_vendor", vendorName: "測試甲", matchedVendorName: "測試甲工程行有限公司" } });
    expect(humanizeSubcontractError(named, "x")).toBe("「測試甲」與名冊廠商「測試甲工程行有限公司」名稱相同，請在下拉選擇該廠商。");
    expect(humanizeProjectExtError(named, "x")).toBe("「測試甲」與名冊廠商「測試甲工程行有限公司」名稱相同，請在下拉選擇該廠商。");
    // 新建專案表單（POST /projects initialSubcontracts）
    expect(humanizeProjectExtError(new Error("[409] must_bind_vendor"), "x")).toContain("請在下拉選擇該廠商");
  });
  it("複製專案：副委託撞多家同名名冊廠商的警告", () => {
    expect(duplicateSubcontractWarningText({})).toBeNull();
    expect(duplicateSubcontractWarningText({ subcontractWarnings: [{ vendorName: "測試重名", candidates: 2, message: "副委託「測試重名」與 2 家名冊廠商同名" }] })).toContain("測試重名");
  });
});

describe("第六輪：副委託改綁要原因（rebind_reason_required）", () => {
  const rows = [{ id: "s1", kind: "subcontract", discipline: null, vendorId: "v2", vendorName: "測試乙", contact: null, item: null, amount: 1, billingBasis: null, orderType: null, withholdingRate: 0, withholdingThreshold: 20000, note: null }] as never[];
  it("問原因後帶 rebindReason 重送；取消就丟原錯誤", async () => {
    const err = Object.assign(new Error("[400] rebind_reason_required"), { body: { error: "rebind_reason_required", id: "s1", message: "請填寫改綁原因" } });
    const spy = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(err).mockResolvedValueOnce({ subcontracts: [] } as never);
    const ask = vi.fn(() => "測試原因");
    await putProjectSubcontractsWithRebind("p1", { subcontracts: rows }, ask);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("請填寫改綁原因"));
    const sent = JSON.parse((spy.mock.calls[1]![1] as { body: string }).body);
    expect(sent.subcontracts[0].rebindReason).toBe("測試原因");
    spy.mockReset().mockRejectedValueOnce(err);
    await expect(putProjectSubcontractsWithRebind("p1", { subcontracts: rows }, () => null)).rejects.toBe(err);
    spy.mockRestore();
  });
  it("第七輪：解除名冊綁定（vendorId: null）的 rebind_reason_required 也問原因、帶 rebindReason 重送", async () => {
    const unbindRows = [{ ...(rows[0] as object), vendorId: null, vendorName: "測試非登錄" }] as never[];
    const err = Object.assign(new Error("[400] rebind_reason_required"), { body: { error: "rebind_reason_required", id: "s1", unbind: true, message: "副委託「測試乙」仍有未付期款，解除與名冊廠商「測試乙」的綁定（改為非登錄廠商）請填寫原因" } });
    const spy = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(err).mockResolvedValueOnce({ subcontracts: [] } as never);
    const ask = vi.fn(() => "測試解除原因");
    await putProjectSubcontractsWithRebind("p1", { subcontracts: unbindRows }, ask);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("解除與名冊廠商"));
    const sent = JSON.parse((spy.mock.calls[1]![1] as { body: string }).body);
    expect(sent.subcontracts[0]).toMatchObject({ id: "s1", vendorId: null, rebindReason: "測試解除原因" });
    spy.mockRestore();
  });
  it("第七輪：invalid_subcontract_vendor_name → 後端訊息優先，否則中文預設", () => {
    const withServer = Object.assign(new Error("[400] invalid_subcontract_vendor_name"), { serverMessage: "副委託廠商名稱「Тест」不合法：名稱含有西里爾或希臘字母，請改用中文或英文字母重新輸入" });
    expect(humanizeSubcontractError(withServer, "x")).toContain("不合法");
    expect(humanizeSubcontractError(new Error("[400] invalid_subcontract_vendor_name"), "x")).toContain("西里爾／希臘字母");
    expect(humanizeProjectExtError(new Error("[400] invalid_subcontract_vendor_name"), "x")).toContain("西里爾／希臘字母");
  });
  it("複製專案：自動綁定／原廠商已刪除的提示也顯示", () => {
    expect(duplicateSubcontractWarningText({ subcontractWarnings: [
      { vendorName: "測試甲", candidates: 1, kind: "autobound", boundVendorName: "測試甲工程行", message: "副委託「測試甲」已自動綁定名冊廠商「測試甲工程行」" },
      { vendorName: "測試丙", candidates: 0, kind: "deleted_vendor", message: "副委託「測試丙」原綁定的名冊廠商已刪除" },
    ] })).toBe("副委託「測試甲」已自動綁定名冊廠商「測試甲工程行」\n副委託「測試丙」原綁定的名冊廠商已刪除");
  });
});

describe("第八輪：名稱相近 → 填說明重送（vendor_name_similar／payee_name_similar）", () => {
  const similarErr = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`[409] ${code}`), {
      serverMessage: "「測試甲」與名冊廠商「測試甲工程行」名稱相近；若是同一家請在下拉選擇該廠商，若是不同公司請填寫說明",
      body: { error: code, matchedVendorName: "測試甲工程行", message: "「測試甲」與名冊廠商「測試甲工程行」名稱相近；若是同一家請在下拉選擇該廠商，若是不同公司請填寫說明", ...extra },
    });
  const rows = [
    { id: "s1", kind: "subcontract", discipline: null, vendorId: "v1", vendorName: "測試乙", contact: null, item: null, amount: 1, billingBasis: null, orderType: null, withholdingRate: 0, withholdingThreshold: 20000, note: null },
    { kind: "subcontract", discipline: null, vendorId: null, vendorName: "測試甲", contact: null, item: null, amount: 1, billingBasis: null, orderType: null, withholdingRate: 0, withholdingThreshold: 20000, note: null },
  ] as never[];
  it("similarNameConflict 認得兩種碼；硬擋碼不認", () => {
    expect(similarNameConflict(similarErr("vendor_name_similar", { index: 1 }))).toMatchObject({ code: "vendor_name_similar", matchedVendorName: "測試甲工程行", index: 1 });
    expect(similarNameConflict(similarErr("payee_name_similar"))).toMatchObject({ code: "payee_name_similar", index: null });
    for (const code of ["must_bind_vendor", "vendor_name_duplicate", "payee_is_registered_vendor"]) expect(similarNameConflict(similarErr(code))).toBeNull();
  });
  it("副委託整批 PUT：問說明（顯示撞到的名冊名稱）後帶在該列 confirmDistinctReason 重送；取消就丟原錯誤", async () => {
    const err = similarErr("vendor_name_similar", { id: null, index: 1 });
    const spy = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(err).mockResolvedValueOnce({ subcontracts: [] } as never);
    const ask = vi.fn(() => "測試：統編不同");
    await putProjectSubcontractsWithRebind("p1", { subcontracts: rows }, ask);
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("測試甲工程行"));
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("若確為不同公司，請說明"));
    const sent = JSON.parse((spy.mock.calls[1]![1] as { body: string }).body);
    expect(sent.subcontracts[1].confirmDistinctReason).toBe("測試：統編不同");
    expect(sent.subcontracts[0].confirmDistinctReason).toBeUndefined();
    spy.mockReset().mockRejectedValueOnce(err);
    await expect(putProjectSubcontractsWithRebind("p1", { subcontracts: rows }, () => null)).rejects.toBe(err);
    expect(humanizeSubcontractError(err, "x")).toContain("名稱相近");
    spy.mockRestore();
  });
  it("建案 initialSubcontracts：帶在該列 confirmDistinctReason 重送", async () => {
    const err = similarErr("vendor_name_similar", { id: null, index: 0 });
    const spy = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(err).mockResolvedValueOnce({ id: "p1", code: null } as never);
    await createProjectExtWithConfirm({ name: "測試案", initialSubcontracts: [{ vendorId: null, vendorName: "測試甲", amount: 1 }] } as never, () => "測試說明");
    const sent = JSON.parse((spy.mock.calls[1]![1] as { body: string }).body);
    expect(sent.initialSubcontracts[0].confirmDistinctReason).toBe("測試說明");
    expect(humanizeProjectExtError(err, "x")).toContain("名稱相近");
    spy.mockRestore();
  });
  it("withSimilarNameConfirm（放款單、名冊）：第二次帶 reason；硬擋錯誤不問、直接丟", async () => {
    const send = vi.fn().mockRejectedValueOnce(similarErr("payee_name_similar")).mockResolvedValueOnce("ok");
    const ask = vi.fn(() => "測試另一家");
    await expect(withSimilarNameConfirm(send, ask)).resolves.toBe("ok");
    expect(send.mock.calls[1]![1]).toBe("測試另一家");
    const hard = Object.assign(new Error("[400] payee_is_registered_vendor"), { body: { error: "payee_is_registered_vendor" } });
    const ask2 = vi.fn(() => "x");
    await expect(withSimilarNameConfirm(() => Promise.reject(hard), ask2)).rejects.toBe(hard);
    expect(ask2).not.toHaveBeenCalled();
  });
  it("取消說明時的錯誤文字帶撞到的名冊名稱", () => {
    expect(humanizeDisbursementError(similarErr("payee_name_similar"), "x")).toContain("測試甲工程行");
    expect(humanizeVendorIdentityError("[409] vendor_name_similar", "名冊已有名稱相近的廠商「測試甲工程行」")).toContain("測試甲工程行");
  });
});
