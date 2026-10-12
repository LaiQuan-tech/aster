import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWhileVisible, type VisibilitySource } from "../visible-interval";

const MINUTE = 60_000;

/** 假的 document：可以切換 visibilityState 並觸發 visibilitychange。 */
function fakeDoc(initial: "visible" | "hidden") {
  const listeners = new Set<() => void>();
  const doc: VisibilitySource & { visibilityState: string } = {
    visibilityState: initial,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    doc,
    setVisibility(state: "visible" | "hidden") {
      doc.visibilityState = state;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe("runWhileVisible（打卡首頁每 60 秒背景對齊，2026-10-12）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("可見時每 60 秒執行一次；開始當下不執行（進頁已經抓過）", () => {
    const { doc } = fakeDoc("visible");
    const tick = vi.fn();
    const stop = runWhileVisible(doc, MINUTE, tick);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MINUTE - 1);
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("隱藏就停；回到可見先立刻執行一次，再從頭起算 60 秒", () => {
    const { doc, setVisibility } = fakeDoc("visible");
    const tick = vi.fn();
    const stop = runWhileVisible(doc, MINUTE, tick);
    vi.advanceTimersByTime(30_000);
    setVisibility("hidden");
    vi.advanceTimersByTime(10 * MINUTE);
    expect(tick).not.toHaveBeenCalled(); // 隱藏期間一次都不抓

    setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(1); // 回到前景立刻對齊
    vi.advanceTimersByTime(MINUTE - 1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(2); // 重新起算的第一個 60 秒
    stop();
  });

  it("一開始就隱藏：不執行；回到可見才立刻執行並開始計時", () => {
    const { doc, setVisibility } = fakeDoc("hidden");
    const tick = vi.fn();
    const stop = runWhileVisible(doc, MINUTE, tick);
    vi.advanceTimersByTime(5 * MINUTE);
    expect(tick).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MINUTE);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it("連續觸發 visible 不會疊出好幾個計時器", () => {
    const { doc, setVisibility } = fakeDoc("visible");
    const tick = vi.fn();
    const stop = runWhileVisible(doc, MINUTE, tick);
    setVisibility("visible");
    setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(MINUTE);
    expect(tick).toHaveBeenCalledTimes(3); // 只有一個計時器在跑
    stop();
  });

  it("給了 onVisible：回到前景跑 onVisible，計時到才跑 tick（輪詢與回前景規則不同）", () => {
    const { doc, setVisibility } = fakeDoc("visible");
    const tick = vi.fn();
    const onVisible = vi.fn();
    const stop = runWhileVisible(doc, MINUTE, tick, onVisible);
    setVisibility("hidden");
    setVisibility("visible");
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MINUTE);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(onVisible).toHaveBeenCalledTimes(1);
    stop();
  });

  it("停止（卸載）：移除監聽、清掉計時器，之後切換可見也不再執行", () => {
    const { doc, setVisibility, listenerCount } = fakeDoc("visible");
    const tick = vi.fn();
    const stop = runWhileVisible(doc, MINUTE, tick);
    expect(listenerCount()).toBe(1);
    stop();
    expect(listenerCount()).toBe(0);
    vi.advanceTimersByTime(10 * MINUTE);
    setVisibility("hidden");
    setVisibility("visible");
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
