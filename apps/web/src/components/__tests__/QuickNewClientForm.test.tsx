/**
 * 「＋ 新增客戶」就地建檔表單（新建專案與既有專案申請單共用）的純函式＋靜態渲染。假資料，與任何真實客戶無關。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_QUICK_NEW_CLIENT, QuickNewClientForm, quickNewClientBody, quickNewClientExisting } from "../QuickNewClientForm";
import type { Client } from "@/lib/projects-ext-api";

function client(id: string, name: string, extra: Partial<Client> = {}): Client {
  return {
    id, name, category: null, taxId: null, phone: null, fax: null, invoiceAddress: null, contactName: null,
    contactPhone: null, email: null, invoiceType: null, paymentMethod: null, closingDay: null, paymentDay: null, note: null,
    ...extra,
  } as Client;
}

describe("quickNewClientBody", () => {
  it("名稱空白不能建", () => {
    expect(quickNewClientBody(EMPTY_QUICK_NEW_CLIENT)).toBeNull();
    expect(quickNewClientBody({ ...EMPTY_QUICK_NEW_CLIENT, name: "   " })).toBeNull();
  });
  it("去頭尾空白、空欄送 null（同新建專案的送出內容）", () => {
    expect(quickNewClientBody({ name: " 測試客戶丁 ", category: "", taxId: " ", phone: " 02-0000-0004 " })).toEqual({
      name: "測試客戶丁", category: null, taxId: null, phone: "02-0000-0004",
    });
    expect(quickNewClientBody({ name: "測試客戶丁", category: "other" as Client["category"] & string, taxId: "12345675", phone: "" })).toEqual({
      name: "測試客戶丁", category: "other", taxId: "12345675", phone: null,
    });
  });
});

describe("quickNewClientExisting：名冊已有同名就直接選用、不重複建檔", () => {
  const roster = [client("c1", "測試客戶甲"), client("c2", "Test Co.", { shortName: "TC" })];
  it("全名（忽略空白／全半形／大小寫）或唯一簡稱對得到", () => {
    expect(quickNewClientExisting(roster, " 測試客戶甲 ")?.id).toBe("c1");
    expect(quickNewClientExisting(roster, "ｔｅｓｔ　ｃｏ．")?.id).toBe("c2");
    expect(quickNewClientExisting(roster, "tc")?.id).toBe("c2");
  });
  it("真的沒有才回 null（要建新的）", () => {
    expect(quickNewClientExisting(roster, "測試客戶乙")).toBeNull();
  });
});

describe("QuickNewClientForm 渲染", () => {
  it("預填打的名稱；有名稱時「建立並選用」可按", () => {
    const html = renderToStaticMarkup(
      <QuickNewClientForm clients={[]} initialName="測試客戶戊" onCreate={async () => client("x", "x")} onPicked={() => {}} />,
    );
    expect(html).toContain('value="測試客戶戊"');
    expect(html).toContain("建立並選用");
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>建立並選用/);
  });
  it("沒有名稱時按鈕停用", () => {
    const html = renderToStaticMarkup(
      <QuickNewClientForm clients={[]} onCreate={async () => client("x", "x")} onPicked={() => {}} />,
    );
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>建立並選用/);
  });
});
