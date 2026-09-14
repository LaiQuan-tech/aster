import { describe, it, expect } from "vitest";
import { buildRemittanceText } from "../disbursements-api";

/**
 * buildRemittanceText（B2「複製匯款資訊」按鈕的文字組裝，純函式）。
 *
 * 這是本批唯一可以在不碰瀏覽器／Clipboard 的情況下驗證「複製出來的內容對不對」
 * 的方式：detail page 的按鈕只是把這支函式的輸出丟給 navigator.clipboard，實際
 * 組字邏輯全部在這裡，行為對了畫面就一定對。
 */
describe("buildRemittanceText（複製匯款資訊文字組裝）", () => {
  it("四行順序固定：戶名／銀行（代號）／帳號／金額", () => {
    const text = buildRemittanceText({
      payeeName: "大同電機工程行",
      payeeBankName: "國泰世華",
      payeeBankCode: "013",
      payeeBankAccount: "013-9999-8888",
      amount: 432_000,
    });
    expect(text.split("\n")).toEqual([
      "戶名：大同電機工程行",
      "銀行：國泰世華（013）",
      "帳號：013-9999-8888",
      "金額：432,000",
    ]);
  });

  it("bankName 已內嵌代碼（vendor 快照慣例，如「國泰世華（013）」）不重複附加", () => {
    const text = buildRemittanceText({
      payeeName: "大同電機工程行",
      payeeBankName: "國泰世華（013）",
      payeeBankCode: "013",
      payeeBankAccount: "013-9999-8888 大同電機工程行",
      amount: 840_000,
    });
    expect(text).toContain("銀行：國泰世華（013）");
    expect(text).not.toContain("（013）（013）");
  });

  it("只有代碼、沒有銀行名稱 → 直接顯示代碼", () => {
    const text = buildRemittanceText({
      payeeName: "某某印刷行",
      payeeBankName: null,
      payeeBankCode: "700",
      payeeBankAccount: "1234567",
      amount: 5_000,
    });
    expect(text).toContain("銀行：700");
  });

  it("完全沒有銀行資訊（payeeKind=other 常見情境）→ 用 — 佔位", () => {
    const text = buildRemittanceText({
      payeeName: "某某印刷行",
      payeeBankName: null,
      payeeBankCode: null,
      payeeBankAccount: null,
      amount: 5_000,
    });
    expect(text.split("\n")).toEqual([
      "戶名：某某印刷行",
      "銀行：—",
      "帳號：—",
      "金額：5,000",
    ]);
  });

  it("金額用千分位（toLocaleString），0 元也正常顯示", () => {
    expect(buildRemittanceText({ payeeName: "x", payeeBankName: null, payeeBankCode: null, payeeBankAccount: null, amount: 0 })).toContain(
      "金額：0",
    );
    expect(
      buildRemittanceText({ payeeName: "x", payeeBankName: null, payeeBankCode: null, payeeBankAccount: null, amount: 1_234_567 }),
    ).toContain("金額：1,234,567");
  });
});
