import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_CHUNK_SIZE,
  batchActionLabel,
  batchDecideRequests,
  batchSummaryLine,
  batchSummaryTitle,
  batchToastMessage,
  batchToastTone,
  chunk,
  describeBatchError,
  errorCodeOf,
  isAllSelected,
  runBatchDecision,
  selectedInOrder,
  summarizeBatch,
  toggleId,
  type BatchDecisionBody,
  type BatchDecisionResponse,
  type BatchItemResult,
} from "../ess-approval-batch";

/**
 * ESS「待我簽核」多選批次簽核的前端這一側（勾選、分批、結果彙整、錯誤碼翻成人話）。
 * 後端授權（只能簽輪到他的、其他張照常）在 apps/api 的 requests-batch-decision.test.ts。
 */

const ok = (id: string, status: "pending" | "approved" | "rejected" = "approved", currentStep = 1): BatchItemResult => ({
  ok: true,
  id,
  status,
  currentStep,
});
const fail = (id: string, error: string): BatchItemResult => ({ ok: false, id, error });
const respond = (results: BatchItemResult[]): BatchDecisionResponse => ({
  ok: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
});
const ids = (n: number) => Array.from({ length: n }, (_, i) => `req-${String(i + 1).padStart(3, "0")}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chunk", () => {
  it("依大小切；最後一批可以不滿；空陣列回空；大小不合法時至少 1", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });

  it("每批 20 張（低於 API 單次 100 張上限，伺服器逐張處理較不會逾時）", () => {
    expect(BATCH_CHUNK_SIZE).toBe(20);
    expect(BATCH_CHUNK_SIZE).toBeLessThanOrEqual(100);
  });
});

describe("勾選", () => {
  it("toggleId：沒選就加、選了就移除，不改原陣列", () => {
    const base = ["a", "b"];
    expect(toggleId(base, "c")).toEqual(["a", "b", "c"]);
    expect(toggleId(base, "a")).toEqual(["b"]);
    expect(base).toEqual(["a", "b"]);
  });

  it("selectedInOrder：依清單順序、只留仍在清單裡的（被處理掉的單自動消失）", () => {
    expect(selectedInOrder(["c", "a", "gone"], ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(selectedInOrder([], ["a"])).toEqual([]);
  });

  it("isAllSelected：清單非空且每張都勾；清單空不算全選", () => {
    expect(isAllSelected(["a", "b"], ["a", "b"])).toBe(true);
    expect(isAllSelected(["a"], ["a", "b"])).toBe(false);
    expect(isAllSelected(["a", "stale"], ["a", "b"])).toBe(false);
    expect(isAllSelected([], [])).toBe(false);
    expect(isAllSelected(["a"], [])).toBe(false);
  });
});

describe("describeBatchError — 錯誤碼翻成主管看得懂的話", () => {
  it("後端會回的代碼各有說明；附件必要時提示可駁回請其補件", () => {
    expect(describeBatchError("not_current_approver")).toContain("不是輪到你");
    expect(describeBatchError("not_pending")).toContain("已被處理過");
    expect(describeBatchError("not_found")).toContain("找不到");
    expect(describeBatchError("attachment_required")).toContain("需要附件");
    expect(describeBatchError("attachment_required")).toContain("駁回");
    expect(describeBatchError("internal_error")).toContain("重新整理");
    expect(describeBatchError("network_error")).toContain("重新整理");
    expect(describeBatchError("ess_tab_disabled")).toContain("沒有開放");
    expect(describeBatchError("unauthorized")).toContain("重新登入");
  });

  it("5xx 提示結果不確定；不認得的（例如原始 DB 錯誤訊息）一律用通用說明，不把內部文字秀出來", () => {
    expect(describeBatchError("http_504")).toContain("不確定");
    const raw = 'duplicate key value violates unique constraint "approval_steps_pkey"';
    const text = describeBatchError(raw);
    expect(text).toBe("處理失敗，請稍後再試或聯絡人資。");
    expect(text).not.toContain("approval_steps");
  });
});

describe("errorCodeOf", () => {
  it("API 錯誤碼優先；沒有就用 HTTP 狀態；都沒有（fetch 本身失敗）視為網路問題", () => {
    expect(errorCodeOf(Object.assign(new Error("[403] ess_tab_disabled"), { status: 403, code: "ess_tab_disabled" }))).toBe("ess_tab_disabled");
    expect(errorCodeOf(Object.assign(new Error("[504] Gateway Timeout"), { status: 504 }))).toBe("http_504");
    expect(errorCodeOf(new TypeError("Failed to fetch"))).toBe("network_error");
    expect(errorCodeOf(null)).toBe("network_error");
    expect(errorCodeOf("boom")).toBe("network_error");
  });
});

describe("runBatchDecision — 分批送、不丟例外", () => {
  it("一批以內：結果依送出的順序回傳（含混入的失敗），comment 去頭尾空白後帶上", async () => {
    const send = vi.fn(async (body: BatchDecisionBody) =>
      respond([ok(body.ids[0]), fail(body.ids[1], "not_current_approver"), ok(body.ids[2])]),
    );
    const results = await runBatchDecision({ ids: ["a", "b", "c"], action: "reject", comment: "  人力不足  " }, send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ ids: ["a", "b", "c"], action: "reject", comment: "人力不足" });
    expect(results).toEqual([ok("a"), fail("b", "not_current_approver"), ok("c")]);
  });

  it("核准沒填意見 → body 不帶 comment；重複的 id 只送一次", async () => {
    const send = vi.fn(async (body: BatchDecisionBody) => respond(body.ids.map((id) => ok(id))));
    await runBatchDecision({ ids: ["a", "b", "a"], action: "approve", comment: "   " }, send);
    expect(send).toHaveBeenCalledWith({ ids: ["a", "b"], action: "approve" });
  });

  it("超過一批 → 依序分批（20／20／5），每批都帶同一個 action 與 comment；結果合併後順序不變", async () => {
    const all = ids(45);
    const send = vi.fn(async (body: BatchDecisionBody) => respond(body.ids.map((id) => ok(id))));
    const results = await runBatchDecision({ ids: all, action: "reject", comment: "共同理由" }, send);

    expect(send.mock.calls.map(([body]) => body.ids.length)).toEqual([20, 20, 5]);
    expect(send.mock.calls.every(([body]) => body.action === "reject" && body.comment === "共同理由")).toBe(true);
    expect(results.map((r) => r.id)).toEqual(all);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("超過 API 單次 100 張的「全選」也能處理（每批都在上限內）", async () => {
    const all = ids(130);
    const send = vi.fn(async (body: BatchDecisionBody) => respond(body.ids.map((id) => ok(id))));
    const results = await runBatchDecision({ ids: all, action: "approve" }, send);
    expect(results).toHaveLength(130);
    expect(Math.max(...send.mock.calls.map(([body]) => body.ids.length))).toBeLessThanOrEqual(100);
  });

  it("中間一批整批失敗（逾時／5xx）→ 只有那一批記成失敗，前後批照常；不丟例外", async () => {
    const all = ids(60);
    let call = 0;
    const send = vi.fn(async (body: BatchDecisionBody) => {
      call += 1;
      if (call === 2) throw Object.assign(new Error("[504] Gateway Timeout"), { status: 504 });
      return respond(body.ids.map((id) => ok(id)));
    });

    const results = await runBatchDecision({ ids: all, action: "approve" }, send);

    expect(send).toHaveBeenCalledTimes(3);
    expect(results.map((r) => r.id)).toEqual(all);
    const failed = results.filter((r) => !r.ok);
    expect(failed.map((r) => r.id)).toEqual(all.slice(20, 40));
    expect(failed.every((r) => !r.ok && r.error === "http_504")).toBe(true);
    expect(results.slice(0, 20).every((r) => r.ok)).toBe(true);
    expect(results.slice(40).every((r) => r.ok)).toBe(true);
  });

  it("send 丟出奇怪的東西（非 Error）也不會往外丟，當成網路問題", async () => {
    const send = vi.fn(async () => {
      throw "boom";
    });
    const results = await runBatchDecision({ ids: ["a"], action: "approve" }, send);
    expect(results).toEqual([fail("a", "network_error")]);
  });

  it("伺服器漏回某一張的結果 → 記成 no_result，不假裝成功", async () => {
    const send = vi.fn(async (body: BatchDecisionBody) => respond([ok(body.ids[0])]));
    const results = await runBatchDecision({ ids: ["a", "b"], action: "approve" }, send);
    expect(results).toEqual([ok("a"), fail("b", "no_result")]);
  });

  it("空勾選 → 不送任何請求", async () => {
    const send = vi.fn(async () => respond([]));
    expect(await runBatchDecision({ ids: [], action: "approve" }, send)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("batchDecideRequests（實際打 fetch 的那一層）", () => {
  it("POST /requests/batch-decision，body 是 JSON；回應照原樣解析", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(respond([ok("a"), fail("b", "not_current_approver")])), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await batchDecideRequests({ ids: ["a", "b"], action: "approve", comment: "好" });

    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/requests\/batch-decision$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ ids: ["a", "b"], action: "approve", comment: "好" });
  });

  it("整批被 403 擋下（分頁限縮）→ runBatchDecision 把每張記成 ess_tab_disabled，不丟例外", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "ess_tab_disabled", tab: "requests" }), { status: 403 })),
    );
    const results = await runBatchDecision({ ids: ["a", "b"], action: "approve" });
    expect(results).toEqual([fail("a", "ess_tab_disabled"), fail("b", "ess_tab_disabled")]);
  });

  it("伺服器逐張回 period_closed（整批仍是 200）→ 結果原樣帶著月份，其他張照常成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              respond([ok("a"), { ok: false, id: "b", error: "period_closed", period: "2026-09" } as BatchItemResult]),
            ),
            { status: 200 },
          ),
      ),
    );
    const results = await runBatchDecision({ ids: ["a", "b"], action: "approve" });
    expect(results).toEqual([ok("a"), { ok: false, id: "b", error: "period_closed", period: "2026-09" }]);
  });

  it("整批被 409 period_closed 擋下（保底）→ 每張記成 period_closed 並帶最早的月份", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "period_closed", period: "2026-08", periods: ["2026-08", "2026-09"] }), { status: 409 }),
      ),
    );
    const results = await runBatchDecision({ ids: ["a", "b"], action: "approve" });
    expect(results).toEqual([
      { ok: false, id: "a", error: "period_closed", period: "2026-08" },
      { ok: false, id: "b", error: "period_closed", period: "2026-08" },
    ]);
    const summary = summarizeBatch("approve", results, (id) => id);
    expect(summary.failures.map((f) => f.reason)).toEqual(["2026-08 已結算，請洽管理者", "2026-08 已結算，請洽管理者"]);
  });

  it("連線失敗（fetch 本身丟例外）→ network_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await runBatchDecision({ ids: ["a"], action: "reject", comment: "x" })).toEqual([fail("a", "network_error")]);
  });
});

describe("summarizeBatch／文案", () => {
  const labels: Record<string, string> = { a: "王小明 · 請假（特休）· 10/13 09:00", b: "李小華 · 加班 · 10/14 18:00", c: "陳大寶 · 補卡 · 10/15 09:00" };
  const labelOf = (id: string) => labels[id] ?? "這張單";

  it("成功與失敗分開統計；失敗列出是哪一張與原因（原因已翻成中文）", () => {
    const summary = summarizeBatch(
      "approve",
      [ok("a"), fail("b", "not_current_approver"), fail("c", "attachment_required")],
      labelOf,
    );
    expect(summary.total).toBe(3);
    expect(summary.okCount).toBe(1);
    expect(summary.failedCount).toBe(2);
    expect(summary.failures).toEqual([
      { id: "b", label: labels.b, reason: describeBatchError("not_current_approver") },
      { id: "c", label: labels.c, reason: describeBatchError("attachment_required") },
    ]);
    expect(batchSummaryLine(summary)).toBe("成功 1 張、失敗 2 張");
    expect(batchSummaryTitle(summary)).toBe("批次核准結果");
    expect(batchToastTone(summary)).toBe("info");
    expect(batchToastMessage(summary)).toBe("批次核准完成：成功 1 張、失敗 2 張");
  });

  it("核准後單子還有下一關（status pending）算成功，另外標出幾張送往下一關；駁回不會有這個數字", () => {
    const approve = summarizeBatch("approve", [ok("a", "approved"), ok("b", "pending", 2), ok("c", "pending", 2)], labelOf);
    expect(approve.okCount).toBe(3);
    expect(approve.advancedCount).toBe(2);
    expect(batchSummaryLine(approve)).toBe("成功 3 張（其中 2 張已送往下一關）");
    expect(batchToastTone(approve)).toBe("success");

    const reject = summarizeBatch("reject", [ok("a", "rejected"), ok("b", "rejected")], labelOf);
    expect(reject.advancedCount).toBe(0);
    expect(batchSummaryTitle(reject)).toBe("批次駁回結果");
    expect(batchSummaryLine(reject)).toBe("成功 2 張");
  });

  it("發薪鎖定：這張單碰到已結算月 → 該張失敗，原因是「YYYY-MM 已結算，請洽管理者」，不是未知錯誤；其他張照常", () => {
    const closed: BatchItemResult = { ok: false, id: "b", error: "period_closed", period: "2026-09" };
    const closedNoPeriod: BatchItemResult = { ok: false, id: "c", error: "period_closed" };
    const summary = summarizeBatch("approve", [ok("a"), closed, closedNoPeriod], labelOf);
    expect(summary.okCount).toBe(1);
    expect(summary.failures).toEqual([
      { id: "b", label: labels.b, reason: "2026-09 已結算，請洽管理者" },
      { id: "c", label: labels.c, reason: "該月份已結算，請洽管理者" },
    ]);
    expect(summary.failures.every((f) => !f.reason.includes("處理失敗"))).toBe(true);
    expect(describeBatchError("period_closed", "2026-09")).toBe("2026-09 已結算，請洽管理者");
  });

  it("全部失敗 → error 語氣", () => {
    const summary = summarizeBatch("reject", [fail("a", "not_current_approver"), fail("b", "not_current_approver")], labelOf);
    expect(summary.okCount).toBe(0);
    expect(batchToastTone(summary)).toBe("error");
    expect(batchSummaryLine(summary)).toBe("成功 0 張、失敗 2 張");
  });

  it("底部固定列的按鈕文字：核准（N）／駁回（N）", () => {
    expect(batchActionLabel("approve", 3)).toBe("核准（3）");
    expect(batchActionLabel("reject", 0)).toBe("駁回（0）");
  });
});
