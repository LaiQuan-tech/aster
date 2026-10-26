import { describe, it, expect } from "vitest";
import {
  CLIENT_EXCEL_COLUMNS, VENDOR_EXCEL_COLUMNS, VENDOR_ROSTER_KIND_LABELS,
  clientCellText, countVendorsByKind, filterVendorsByKind, parseSeqInput, vendorCategoryLabel, vendorCellText, vendorRosterKind,
} from "../roster-columns";
import { clientFormFrom, clientFormToInput, emptyClientForm, emptyVendorForm, vendorFormFrom, vendorFormToInput } from "../roster-forms";
import { PAYMENT_METHOD_LABELS, type Client } from "../projects-ext-api";
import type { Vendor } from "../company-api";

/**
 * 名冊列表欄位＝業主 Excel「客供商基本資料」的欄位（順序、欄名一字不差；只拿掉對齊用的空白）。
 * 表頭清單直接寫死在這裡當規格：Excel 改版時這個測試會提醒要一起改。
 * ⚠️ 資料都是明顯的假值（repo 是公開的）。
 */
const EXCEL_VENDOR_HEADERS = ["簡稱", "序", "類別", "細目", "編號", "公司名稱", "TEL", "FAX", "承辦窗口", "Mobil", "E-mail", "公司地址", "統編", "付款方式", "備註", "網址"];
const EXCEL_CLIENT_HEADERS = ["簡稱", "序", "區域", "編號", "公司名稱", "TEL", "FAX", "承辦窗口", "Mobil", "e-mail", "公司地址", "統編", "收款方式", "備註"];

const vendor = (over: Partial<Vendor> = {}): Vendor => ({
  id: "v1", name: "測試廠商甲有限公司", shortName: "測試甲", isAffiliate: false, rosterKind: "engineer", seq: 3,
  category: "空調", subCategory: "測試技師細目", code: "X01", contactName: "測試窗口_甲 / 測試窗口_乙", title: null,
  phone: "(00)0000-0000", fax: "(00)0000-0001", mobile: "測試 0900-000-000", email: "a@example.test", address: "測試市測試路 1 號",
  taxId: "00000000", taxIdValid: false, website: "https://example.test", paymentTerms: "月結", note: "測試備註",
  bankName: null, bankCode: null, bankAccount: null, accountHolder: null, hasCard: false, source: "manual", createdAt: "", updatedAt: "",
  ...over,
});

const client = (over: Partial<Client> = {}): Client => ({
  id: "c1", name: "測試客戶甲設計有限公司", shortName: "測試客甲", isAffiliate: false, category: null, seq: 2, region: "測試市", code: "T0001",
  taxId: null, phone: "(00)1111-1111", fax: null, invoiceAddress: "測試市測試路 2 號", contactName: "測試承辦", contactPhone: "0900-111-111",
  email: "b@example.test", invoiceType: null, paymentMethod: "transfer", closingDay: null, paymentDay: null, note: null,
  ...over,
});

describe("列表欄位對齊 Excel", () => {
  it("廠商：16 欄，順序與欄名＝供應商資料／技師資料／送審相關單位的表頭", () => {
    expect(VENDOR_EXCEL_COLUMNS.map((c) => c.header)).toEqual(EXCEL_VENDOR_HEADERS);
  });

  it("客戶：14 欄，順序與欄名＝客戶資料的表頭", () => {
    expect(CLIENT_EXCEL_COLUMNS.map((c) => c.header)).toEqual(EXCEL_CLIENT_HEADERS);
  });

  it("廠商每一欄讀到對應的欄位", () => {
    const v = vendor();
    const cells = Object.fromEntries(VENDOR_EXCEL_COLUMNS.map((c) => [c.header, vendorCellText(v, c.key)]));
    expect(cells).toEqual({
      簡稱: "測試甲", 序: "3", 類別: "空調", 細目: "測試技師細目", 編號: "X01", 公司名稱: "測試廠商甲有限公司",
      TEL: "(00)0000-0000", FAX: "(00)0000-0001", 承辦窗口: "測試窗口_甲 / 測試窗口_乙", Mobil: "測試 0900-000-000",
      "E-mail": "a@example.test", 公司地址: "測試市測試路 1 號", 統編: "00000000", 付款方式: "月結", 備註: "測試備註", 網址: "https://example.test",
    });
  });

  it("客戶每一欄讀到對應的欄位：公司地址＝invoiceAddress、Mobil＝contactPhone、收款方式顯示中文", () => {
    const c = client();
    const cells = Object.fromEntries(CLIENT_EXCEL_COLUMNS.map((col) => [col.header, clientCellText(c, col.key, PAYMENT_METHOD_LABELS)]));
    expect(cells).toEqual({
      簡稱: "測試客甲", 序: "2", 區域: "測試市", 編號: "T0001", 公司名稱: "測試客戶甲設計有限公司", TEL: "(00)1111-1111", FAX: "",
      承辦窗口: "測試承辦", Mobil: "0900-111-111", "e-mail": "b@example.test", 公司地址: "測試市測試路 2 號", 統編: "", 收款方式: "匯款", 備註: "",
    });
  });

  it("舊 API 回應沒有新欄位：顯示空字串，不出現 undefined", () => {
    const old = vendor({ seq: undefined, subCategory: undefined, code: undefined, fax: undefined, paymentTerms: undefined, rosterKind: undefined });
    for (const key of ["seq", "subCategory", "code", "fax", "paymentTerms"] as const) expect(vendorCellText(old, key)).toBe("");
    expect(vendorRosterKind(old)).toBe("supplier");
  });
});

describe("名冊類別篩選（三個工作表）", () => {
  const list = [vendor({ id: "a", rosterKind: "supplier" }), vendor({ id: "b", rosterKind: "engineer" }), vendor({ id: "c", rosterKind: "review_unit" }), vendor({ id: "d", rosterKind: undefined })];

  it("依類別篩選；沒有類別的舊資料算供應商", () => {
    expect(filterVendorsByKind(list, "all").map((v) => v.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterVendorsByKind(list, "supplier").map((v) => v.id)).toEqual(["a", "d"]);
    expect(filterVendorsByKind(list, "engineer").map((v) => v.id)).toEqual(["b"]);
    expect(filterVendorsByKind(list, "review_unit").map((v) => v.id)).toEqual(["c"]);
    expect(countVendorsByKind(list)).toEqual({ all: 4, supplier: 2, engineer: 1, review_unit: 1 });
  });

  it("頁籤字對應 Excel 工作表", () => {
    expect(VENDOR_ROSTER_KIND_LABELS).toEqual({ supplier: "供應商", engineer: "技師", review_unit: "送審相關單位" });
  });

  it("發包篩選用的「類別／細目」合併字", () => {
    expect(vendorCategoryLabel({ category: "廠商", subCategory: "電線電纜" })).toBe("廠商／電線電纜");
    expect(vendorCategoryLabel({ category: "廠商", subCategory: null })).toBe("廠商");
    expect(vendorCategoryLabel({ category: null, subCategory: " 消防 " })).toBe("消防");
    expect(vendorCategoryLabel({ category: null })).toBe("");
  });
});

describe("表單 ⇄ API", () => {
  it("序：空白＝null、整數照收、其他擋下", () => {
    expect(parseSeqInput("")).toBeNull();
    expect(parseSeqInput(" 12 ")).toBe(12);
    expect(parseSeqInput("1.5")).toBe("invalid");
    expect(parseSeqInput("-1")).toBe("invalid");
    expect(parseSeqInput("123456")).toBe("invalid");
  });

  it("廠商：讀進表單再送出，Excel 欄位一個不漏、空字串轉 null、關係企業沒變不送", () => {
    const v = vendor({ email: null });
    const r = vendorFormToInput(vendorFormFrom(v), v);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({
      name: "測試廠商甲有限公司", rosterKind: "engineer", shortName: "測試甲", seq: 3, category: "空調", subCategory: "測試技師細目", code: "X01",
      phone: "(00)0000-0000", fax: "(00)0000-0001", contactName: "測試窗口_甲 / 測試窗口_乙", mobile: "測試 0900-000-000", email: null,
      address: "測試市測試路 1 號", taxId: "00000000", paymentTerms: "月結", note: "測試備註", website: "https://example.test",
    });
    expect(r.input).not.toHaveProperty("isAffiliate");
  });

  it("廠商新增：預設名冊類別跟著目前頁籤；序不合法回錯誤", () => {
    expect(emptyVendorForm("review_unit").rosterKind).toBe("review_unit");
    const bad = vendorFormToInput({ ...emptyVendorForm(), name: "測試", seq: "abc" }, null);
    expect(bad).toEqual({ ok: false, error: "「序」請填 0–99999 的整數" });
  });

  it("客戶：讀進表單再送出，序／區域／編號與 Excel 欄位一個不漏", () => {
    const c = client();
    const r = clientFormToInput(clientFormFrom(c), c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({
      name: "測試客戶甲設計有限公司", shortName: "測試客甲", seq: 2, region: "測試市", code: "T0001", phone: "(00)1111-1111", fax: null,
      contactName: "測試承辦", contactPhone: "0900-111-111", email: "b@example.test", invoiceAddress: "測試市測試路 2 號", taxId: null,
      paymentMethod: "transfer", note: null,
    });
    const blank = clientFormToInput({ ...emptyClientForm(), name: " 測試客戶乙 ", region: "  " }, null);
    expect(blank.ok && blank.input).toMatchObject({ name: "測試客戶乙", region: null, seq: null, paymentMethod: null });
  });
});
