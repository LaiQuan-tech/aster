import { describe, expect, it, vi } from "vitest";
import {
  fileTripWithExpenses,
  isBlankDraft,
  isCategoryUsableForTrip,
  isSelfPaidTrip,
  isTripListedForExpenses,
  parseTripParam,
  showFillExpense,
  summarizeTripClaims,
  tripClaimSummaryText,
  tripExpenseHref,
  tripExpenseNote,
  tripExpenseOutcome,
  tripOptionLabel,
  tripOriginLabel,
  validateExpenseDrafts,
  type ExpenseDraft,
  type ReadyExpense,
} from "../trip-expense";

/** 公出／出差「自行墊付」× 報銷（lib/trip-expense.ts）。識別碼都是明顯的假值。 */

const TRIP_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const CAT_PLAIN = { id: "c-plain", name: "交通費", active: true, requires_trip_approval: false };
const CAT_GATED = { id: "c-gated", name: "出差旅費", active: true, requires_trip_approval: true };
const CAT_OFF = { id: "c-off", name: "舊類別", active: false, requires_trip_approval: false };
const CATS = [CAT_PLAIN, CAT_GATED, CAT_OFF];

const draft = (over: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
  key: "k",
  categoryId: "",
  amount: "",
  incurredOn: "2026-10-16",
  note: "",
  receipt: null,
  ...over,
});

const file = (name: string, size: number, type = "image/jpeg") => new File([new Uint8Array(size)], name, { type });

describe("判斷：自行墊付、可填報銷、類別可用", () => {
  it("自行墊付＝出差單沒有預支金額（null／0／空字串）", () => {
    expect(isSelfPaidTrip({ kind: "business_trip", advance_requested: null })).toBe(true);
    expect(isSelfPaidTrip({ kind: "business_trip", advance_requested: "0" })).toBe(true);
    expect(isSelfPaidTrip({ kind: "business_trip", advance_requested: 0 })).toBe(true);
    expect(isSelfPaidTrip({ kind: "business_trip" })).toBe(true);
    expect(isSelfPaidTrip({ kind: "business_trip", advance_requested: "3000" })).toBe(false);
    expect(isSelfPaidTrip({ kind: "leave", advance_requested: null })).toBe(false);
  });

  it("「填報銷單」只給自行墊付、簽核中或已核准的公出／出差單", () => {
    const base = { kind: "business_trip", status: "pending", advance_requested: null };
    expect(showFillExpense(base)).toBe(true);
    expect(showFillExpense({ ...base, status: "approved" })).toBe(true);
    expect(showFillExpense({ ...base, status: "rejected" })).toBe(false);
    expect(showFillExpense({ ...base, status: "cancelled" })).toBe(false);
    expect(showFillExpense({ ...base, advance_requested: 5000 })).toBe(false); // 先預支：走預支核銷，不變
    expect(showFillExpense({ ...base, kind: "leave" })).toBe(false);
    expect(showFillExpense({ ...base, kind: "petty_cash" })).toBe(false);
  });

  it("報銷頁可列的出差單：已核准全列；簽核中只列自行墊付的；駁回、撤回不列", () => {
    const base = { kind: "business_trip", advance_requested: null };
    expect(isTripListedForExpenses({ ...base, status: "approved" })).toBe(true);
    expect(isTripListedForExpenses({ ...base, status: "approved", advance_requested: "3000" })).toBe(true);
    expect(isTripListedForExpenses({ ...base, status: "pending" })).toBe(true);
    expect(isTripListedForExpenses({ ...base, status: "pending", advance_requested: "3000" })).toBe(false);
    expect(isTripListedForExpenses({ ...base, status: "rejected" })).toBe(false);
    expect(isTripListedForExpenses({ ...base, status: "cancelled" })).toBe(false);
  });

  it("要求出差核准的類別：簽核中不能用、核准後可以；停用的一律不行", () => {
    expect(isCategoryUsableForTrip(CAT_PLAIN)).toBe(true);
    expect(isCategoryUsableForTrip(CAT_GATED)).toBe(false);
    expect(isCategoryUsableForTrip(CAT_GATED, "pending")).toBe(false);
    expect(isCategoryUsableForTrip(CAT_GATED, "approved")).toBe(true);
    expect(isCategoryUsableForTrip(CAT_OFF, "approved")).toBe(false);
  });
});

describe("文案與深連結", () => {
  const trip = {
    id: TRIP_ID,
    status: "pending",
    start_at: "2026-10-16T04:00:00.000Z", // 台北 12:00（各常見時區都還是 10/16）
    trip_type: "outing",
    location: "台中客戶公司",
    reason: "客戶拜訪",
  };

  it("備註預設：類型＋地點＋事由；沒有事由就不加括號；超過 250 字截斷", () => {
    expect(tripExpenseNote(trip)).toBe("公出：台中客戶公司（客戶拜訪）");
    expect(tripExpenseNote({ ...trip, reason: null, trip_type: "business_trip" })).toBe("出差：台中客戶公司");
    const long = tripExpenseNote({ ...trip, reason: "長".repeat(400) });
    expect(long.length).toBe(250);
    expect(long.endsWith("…")).toBe(true);
  });

  it("報銷頁提示與下拉選項：日期、地點、簽核中標示", () => {
    expect(tripOriginLabel(trip)).toBe("來自 10/16 公出申請・台中客戶公司（簽核中）");
    expect(tripOriginLabel({ ...trip, status: "approved", trip_type: "business_trip" })).toBe("來自 10/16 出差申請・台中客戶公司");
    expect(tripOptionLabel(trip)).toBe("2026-10-16 · 台中客戶公司（簽核中）");
    expect(tripOptionLabel({ ...trip, status: "approved", location: null })).toBe("2026-10-16");
  });

  it("連結只帶單號；解析只認 uuid", () => {
    expect(tripExpenseHref(TRIP_ID)).toBe(`/ess/expenses?trip=${TRIP_ID}`);
    expect(parseTripParam(`?trip=${TRIP_ID}`)).toBe(TRIP_ID);
    expect(parseTripParam(`trip=${TRIP_ID}&x=1`)).toBe(TRIP_ID);
    expect(parseTripParam("?trip=abc")).toBeNull();
    expect(parseTripParam("")).toBeNull();
    expect(parseTripParam("?trip=")).toBeNull();
  });
});

describe("已報銷合計", () => {
  it("依出差單分組，撤回、退件、沒綁的不算", () => {
    const map = summarizeTripClaims([
      { trip_request_id: TRIP_ID, amount: "1200", status: "submitted" },
      { trip_request_id: TRIP_ID, amount: 150, status: "settled" },
      { trip_request_id: TRIP_ID, amount: "999", status: "cancelled" },
      { trip_request_id: TRIP_ID, amount: "888", status: "rejected" },
      { trip_request_id: null, amount: "50", status: "submitted" },
      { trip_request_id: "other", amount: "70", status: "submitted" },
    ]);
    expect(map.get(TRIP_ID)).toEqual({ count: 2, total: 1350 });
    expect(map.get("other")).toEqual({ count: 1, total: 70 });
    expect(map.size).toBe(2);
    expect(tripClaimSummaryText({ count: 2, total: 1350 })).toBe("已報銷 2 筆・NT$ 1,350");
  });
});

describe("明細驗證 validateExpenseDrafts", () => {
  const NOTE = "公出：台中客戶公司";

  it("空白的略過（日期有預設值不算填了）；全部空白＝沒有明細", () => {
    expect(isBlankDraft(draft())).toBe(true);
    expect(isBlankDraft(draft({ note: " " }))).toBe(true);
    expect(isBlankDraft(draft({ amount: "1" }))).toBe(false);
    expect(validateExpenseDrafts([draft(), draft()], CATS, NOTE)).toEqual({ ok: true, ready: [] });
  });

  it("合格的：金額轉數字、沒填備註帶入事由、填了用自己的", () => {
    const receipt = file("a.jpg", 1000);
    const res = validateExpenseDrafts(
      [draft({ categoryId: CAT_PLAIN.id, amount: "1,200", receipt }), draft({ categoryId: CAT_PLAIN.id, amount: "80", note: "停車" })],
      CATS,
      NOTE,
    );
    expect(res).toEqual({
      ok: true,
      ready: [
        { position: 0, categoryId: CAT_PLAIN.id, amount: 1200, incurredOn: "2026-10-16", note: NOTE, receipt },
        { position: 1, categoryId: CAT_PLAIN.id, amount: 80, incurredOn: "2026-10-16", note: "停車", receipt: null },
      ],
    });
  });

  it.each([
    ["沒選類別", draft({ amount: "100" }), "報銷明細：請選擇類別"],
    ["要求出差核准的類別", draft({ categoryId: CAT_GATED.id, amount: "100" }), "報銷明細：「出差旅費」須等出差核准後再到報銷頁填"],
    ["停用的類別", draft({ categoryId: CAT_OFF.id, amount: "100" }), "報銷明細：「舊類別」已停用，請重新選擇"],
    ["金額 0", draft({ categoryId: CAT_PLAIN.id, amount: "0" }), "報銷明細：請填寫金額"],
    ["金額空", draft({ categoryId: CAT_PLAIN.id, note: "x" }), "報銷明細：請填寫金額"],
    ["金額小數", draft({ categoryId: CAT_PLAIN.id, amount: "10.5" }), "報銷明細：金額請填整數"],
    ["沒有日期", draft({ categoryId: CAT_PLAIN.id, amount: "10", incurredOn: "" }), "報銷明細：請選擇發生日期"],
    ["空檔憑證", draft({ categoryId: CAT_PLAIN.id, amount: "10", receipt: file("a.jpg", 0) }), "報銷明細：檔案是空的（0 bytes），請重新選擇"],
  ])("%s → 擋下", (_label, d, error) => {
    expect(validateExpenseDrafts([d], CATS, NOTE)).toEqual({ ok: false, index: 0, error });
  });

  it("兩筆以上：訊息指出第幾筆（含中間空白列的位置）", () => {
    const res = validateExpenseDrafts(
      [draft({ categoryId: CAT_PLAIN.id, amount: "10" }), draft(), draft({ categoryId: CAT_PLAIN.id })],
      CATS,
      NOTE,
    );
    expect(res).toEqual({ ok: false, index: 2, error: "報銷第 3 筆：請填寫金額" });
  });

  it("position 記畫面上的位置（中間有空白列也不重新編號）", () => {
    const res = validateExpenseDrafts(
      [draft(), draft({ categoryId: CAT_PLAIN.id, amount: "10" }), draft(), draft({ categoryId: CAT_PLAIN.id, amount: "20" })],
      CATS,
      NOTE,
    );
    expect(res.ok && res.ready.map((r) => r.position)).toEqual([1, 3]);
  });
});

describe("送出編排 fileTripWithExpenses", () => {
  const ready = (amount: number, receipt: File | null = null, position = 0): ReadyExpense => ({
    position,
    categoryId: CAT_PLAIN.id,
    amount,
    incurredOn: "2026-10-16",
    note: "公出",
    receipt,
  });

  function deps(over: Partial<Parameters<typeof fileTripWithExpenses<{ requestId: string }, { id: string }>>[0]> = {}) {
    let n = 0;
    return {
      expenses: [] as ReadyExpense[],
      createTrip: vi.fn(async () => ({ requestId: TRIP_ID })),
      tripId: (t: { requestId: string }) => t.requestId,
      fileExpense: vi.fn(async () => ({ id: `claim-${++n}` })),
      upload: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      prepare: vi.fn(async (f: File) => f),
      ...over,
    };
  }

  it("全部成功：先建公出單，再逐筆建報銷（綁公出單、不帶 receipt 欄位），有憑證才上傳", async () => {
    const receipt = file("r.jpg", 10);
    const d = deps({ expenses: [ready(100, receipt), ready(50)] });
    const res = await fileTripWithExpenses(d);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(d.createTrip).toHaveBeenCalledTimes(1);
    expect(d.fileExpense).toHaveBeenNthCalledWith(1, { categoryId: CAT_PLAIN.id, amount: 100, incurredOn: "2026-10-16", note: "公出", tripRequestId: TRIP_ID });
    expect(d.fileExpense).toHaveBeenCalledTimes(2);
    expect(d.upload).toHaveBeenCalledTimes(1);
    expect(d.upload).toHaveBeenCalledWith({ id: "claim-1" }, receipt);
    expect(res.filed.map((f) => f.amount)).toEqual([100, 50]);
    expect(res.failed).toEqual([]);
  });

  it("沒有明細：只建公出單（行為同以前）", async () => {
    const d = deps();
    const res = await fileTripWithExpenses(d);
    expect(res).toEqual({ ok: true, trip: { requestId: TRIP_ID }, filed: [], failed: [] });
    expect(d.fileExpense).not.toHaveBeenCalled();
  });

  it("憑證準備不過：什麼單都不建（公出單也不建），指出第幾筆", async () => {
    const bad = file("bad.pdf", 10, "application/pdf");
    const err = new Error("檔案超過 3 MB");
    const d = deps({
      expenses: [ready(100, null, 0), ready(50, bad, 2)], // 畫面第 2 列是空白、已略過
      prepare: vi.fn(async (f: File) => {
        if (f === bad) throw err;
        return f;
      }),
    });
    const res = await fileTripWithExpenses(d);
    expect(res).toEqual({ ok: false, stage: "prepare", index: 2, error: err });
    expect(d.createTrip).not.toHaveBeenCalled();
    expect(d.fileExpense).not.toHaveBeenCalled();
  });

  it("公出單建失敗：停下、不建報銷單", async () => {
    const err = new Error("[500] boom");
    const d = deps({ expenses: [ready(100)], createTrip: vi.fn(async () => Promise.reject(err)) });
    const res = await fileTripWithExpenses(d);
    expect(res).toEqual({ ok: false, stage: "trip", error: err });
    expect(d.fileExpense).not.toHaveBeenCalled();
  });

  it("公出單成功、某筆報銷失敗：其餘照送，公出單只建一次；憑證傳失敗會撤回、撤回也失敗就回報留下的單", async () => {
    const r2 = file("r2.jpg", 10);
    const r3 = file("r3.jpg", 10);
    const createErr = new Error("[409] period_closed");
    const uploadErr = new Error("Failed to fetch");
    let n = 0;
    const d = deps({
      expenses: [ready(100, null, 0), ready(200, r2, 1), ready(300, r3, 3), ready(400, null, 4)], // 畫面第 3 列空白
      fileExpense: vi.fn(async () => {
        n += 1;
        if (n === 1) throw createErr;
        return { id: `claim-${n}` };
      }),
      upload: vi.fn(async () => {
        throw uploadErr;
      }),
      rollback: vi.fn(async (claim: { id: string }) => {
        if (claim.id === "claim-3") throw new Error("offline");
      }),
    });
    const res = await fileTripWithExpenses(d);

    expect(d.createTrip).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.filed).toEqual([{ index: 4, amount: 400, claim: { id: "claim-4" } }]);
    expect(res.failed).toEqual([
      { index: 0, amount: 100, stage: "create", error: createErr },
      { index: 1, amount: 200, stage: "upload", error: uploadErr, rolledBack: true },
      { index: 3, amount: 300, stage: "upload", error: uploadErr, rolledBack: false, leftover: { id: "claim-3" } },
    ]);
    expect(d.rollback).toHaveBeenCalledTimes(2);
  });
});

describe("成功畫面的報銷結果 tripExpenseOutcome", () => {
  const reason = () => "網路中斷";

  it("沒填明細 → null", () => {
    expect(tripExpenseOutcome([], [], reason)).toBeNull();
  });

  it("全部成功 → 綠色，筆數＋合計", () => {
    expect(
      tripExpenseOutcome(
        [
          { index: 0, amount: 1200, claim: {} },
          { index: 1, amount: 150, claim: {} },
        ],
        [],
        reason,
      ),
    ).toEqual({ tone: "success", text: "已一併送出 2 筆報銷，共 NT$ 1,350，隨月結給付。" });
  });

  it("有失敗 → 黃色，說成功幾筆、哪筆沒送成，並提醒申請單已送出、用「填報銷單」補", () => {
    const out = tripExpenseOutcome(
      [{ index: 0, amount: 100, claim: {} }],
      [{ index: 1, amount: 50, stage: "create", error: null }],
      reason,
    );
    expect(out).toEqual({
      tone: "warning",
      text: "已一併送出 1 筆報銷，共 NT$ 100，隨月結給付。第 2 筆（NT$ 50）沒送成：網路中斷。申請單已送出、不用重填，請按「填報銷單」補上沒送成的。",
    });
    expect(tripExpenseOutcome([], [{ index: 0, amount: 50, stage: "create", error: null }], reason)?.text).toBe(
      "報銷（NT$ 50）沒送成：網路中斷。申請單已送出、不用重填，請按「填報銷單」補上沒送成的。",
    );
  });
});
