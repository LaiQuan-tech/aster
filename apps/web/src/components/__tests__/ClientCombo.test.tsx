/**
 * ClientCombo 的比對邏輯（純函式）＋靜態渲染。假資料，與任何真實客戶無關。
 *
 * 回歸（2026-11-12）：名冊是頁面載入時抓的一份，管理員在別的分頁新增客戶後回來選，
 * 以前打完整名稱對不到就回傳 null——專案原本的客戶被清掉、或什麼都沒改所以「儲存」沒東西可存。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientCombo, clientComboChange, clientNameKey, matchClientByText } from "../ClientCombo";
import type { Client } from "@/lib/projects-ext-api";

function client(id: string, name: string, extra: Partial<Client> = {}): Client {
  return {
    id, name, category: null, taxId: null, phone: null, fax: null, invoiceAddress: null, contactName: null,
    contactPhone: null, email: null, invoiceType: null, paymentMethod: null, closingDay: null, paymentDay: null, note: null,
    ...extra,
  } as Client;
}

const oldRoster = [client("c1", "測試客戶甲"), client("c2", "Test Co.", { shortName: "TC" })];
const newClient = client("c3", "測試新客戶乙", { category: "other" });
const freshRoster = [...oldRoster, newClient];

describe("clientNameKey／matchClientByText", () => {
  it("忽略頭尾空白、全形半形、英文大小寫", () => {
    expect(clientNameKey("  測試客戶甲 ")).toBe("測試客戶甲");
    expect(matchClientByText(oldRoster, "ｔｅｓｔ　ｃｏ．")?.id).toBe("c2");
    expect(matchClientByText(oldRoster, " 測試客戶甲")?.id).toBe("c1");
  });

  it("全名對不到時，唯一的簡稱也算", () => {
    expect(matchClientByText(oldRoster, "tc")?.id).toBe("c2");
    const dupShort = [...oldRoster, client("c9", "另一家", { shortName: "TC" })];
    expect(matchClientByText(dupShort, "TC")).toBeNull();
  });
});

describe("clientComboChange", () => {
  it("清空＝選無客戶（null）", () => {
    expect(clientComboChange(oldRoster, "  ")).toBeNull();
  });

  it("對到＝回傳該筆 id", () => {
    expect(clientComboChange(oldRoster, "測試客戶甲")).toBe("c1");
  });

  it("回歸：舊名冊裡沒有剛新增的客戶 → 不動原本的值（undefined），不再回傳 null 把客戶清掉", () => {
    expect(clientComboChange(oldRoster, "測試新客戶乙")).toBeUndefined();
    // 打到一半也一樣：不會打一個字就把專案原本的客戶清掉。
    expect(clientComboChange(oldRoster, "測試")).toBeUndefined();
  });

  it("回歸：名冊重抓後就對得到新客戶", () => {
    expect(clientComboChange(freshRoster, "測試新客戶乙")).toBe("c3");
  });
});

describe("ClientCombo 渲染", () => {
  it("datalist 列出名冊，選到的客戶名稱放進輸入框", () => {
    const html = renderToStaticMarkup(<ClientCombo clients={freshRoster} clientId="c3" onChange={() => {}} />);
    expect(html).toContain('value="測試新客戶乙"');
    expect(html).toContain("<datalist");
    expect(html).toContain('value="測試客戶甲"');
  });
});
