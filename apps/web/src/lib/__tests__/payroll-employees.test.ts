import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityNumbersOf, loadPayrollEmployees } from "../payroll-employees";

/**
 * lib/payroll-employees.ts：薪資作業頁的員工清單＋證件號碼對照。
 * 網路層是假的（stub 全域 fetch，看 apiFetch 實際打了幾次、打去哪）；全部是明顯的假值，repo 是公開的。
 */

// api-client 載入時會 import supabase-browser：換成沒有 session 的假 client，測試絕不建立真的 Supabase client
// （node 環境沒有 window，apiFetch 本來就不會去拿 session；這是保險，日後改跑 jsdom 也不會連出去）。
vi.mock("../supabase-browser", () => ({
  getSupabaseBrowser: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}));

const fetchMock = vi.fn<typeof fetch>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 第 n 次 fetch 的網址（apiFetch 以字串傳入）。 */
const urlOf = (n: number) => String(fetchMock.mock.calls[n]?.[0]);

function employee(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: "tenant-test",
    user_id: `user-${id}`,
    name,
    role: "employee",
    dept_id: null,
    emp_no: null,
    employment_type: "regular",
    hire_date: null,
    terminated_at: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    email: null,
    ...extra,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadPayrollEmployees", () => {
  it("5 位員工：只打一次 GET /employees?include=profile，證號照第一～三的順序串起來、跳過 null／空字串", async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        employees: [
          employee("emp-1", "測試員工甲", { idNumber: "B100000001", idNumber2: "B200000002", idNumber3: "B100000003" }),
          employee("emp-2", "測試員工乙", { idNumber: "D100000001", idNumber2: null, idNumber3: "D200000002" }),
          employee("emp-3", "測試員工丙", { idNumber: null, idNumber2: "", idNumber3: "E200000002" }),
          employee("emp-4", "測試員工丁", { idNumber: null, idNumber2: null, idNumber3: null }),
          // 會計拿到的形狀：沒有第二、三證號的鍵。
          employee("emp-5", "測試員工戊", { idNumber: "A100000002" }),
        ],
      }),
    );

    const result = await loadPayrollEmployees();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(0).endsWith("/employees?include=profile")).toBe(true);
    expect(result.employees.map((e) => e.id)).toEqual(["emp-1", "emp-2", "emp-3", "emp-4", "emp-5"]);
    expect(result.identityById).toEqual({
      "emp-1": "B100000001 / B200000002 / B100000003",
      "emp-2": "D100000001 / D200000002",
      "emp-3": "E200000002",
      "emp-4": "",
      "emp-5": "A100000002",
    });
  });

  it("include=profile 回 500：退回 GET /employees（共 2 次），員工清單照回、證號全部空字串", async () => {
    fetchMock
      .mockResolvedValueOnce(json(500, { error: "internal_server_error" }))
      .mockResolvedValueOnce(json(200, { employees: [employee("emp-1", "測試員工甲"), employee("emp-2", "測試員工乙")] }));

    const result = await loadPayrollEmployees();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(0).endsWith("/employees?include=profile")).toBe(true);
    expect(urlOf(1).endsWith("/employees")).toBe(true);
    expect(result.employees.map((e) => e.id)).toEqual(["emp-1", "emp-2"]);
    expect(result.identityById).toEqual({ "emp-1": "", "emp-2": "" });
  });

  it("兩次都 403：reject，訊息就是 [403] forbidden（跟以前 getEmployees() 失敗時頁面顯示的字串一樣）", async () => {
    fetchMock.mockImplementation(async () => json(403, { error: "forbidden" }));

    await expect(loadPayrollEmployees()).rejects.toThrow(/^\[403\] forbidden$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(1).endsWith("/employees")).toBe(true);
  });

  it("往外丟的是退回那次（GET /employees）的錯誤，不是第一次的", async () => {
    fetchMock
      .mockResolvedValueOnce(json(500, { error: "internal_server_error" }))
      .mockResolvedValueOnce(json(403, { error: "forbidden" }));

    await expect(loadPayrollEmployees()).rejects.toThrow(/^\[403\] forbidden$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("identityNumbersOf", () => {
  it("三個都有：照第一、二、三的順序以「 / 」串起來", () => {
    expect(identityNumbersOf({ idNumber: "B100000001", idNumber2: "B200000002", idNumber3: "B100000003" })).toBe(
      "B100000001 / B200000002 / B100000003",
    );
  });

  it("null／空字串／沒有該鍵都跳過，不留多餘的分隔符號", () => {
    expect(identityNumbersOf({ idNumber: "B100000001", idNumber2: null, idNumber3: "B100000003" })).toBe("B100000001 / B100000003");
    expect(identityNumbersOf({ idNumber: "", idNumber3: "B100000003" })).toBe("B100000003");
    expect(identityNumbersOf({ idNumber: "B100000001" })).toBe("B100000001");
  });

  it("一個都沒有＝空字串", () => {
    expect(identityNumbersOf({})).toBe("");
    expect(identityNumbersOf({ idNumber: null, idNumber2: null, idNumber3: null })).toBe("");
    expect(identityNumbersOf({ idNumber: "", idNumber2: "", idNumber3: "" })).toBe("");
  });
});
