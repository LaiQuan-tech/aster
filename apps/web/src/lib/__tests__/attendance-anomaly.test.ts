import { describe, it, expect } from "vitest";
import { anomalyForExport, hasRealAnomaly } from "../attendance-anomaly";

describe("hasRealAnomaly — 當日旗標不算異常", () => {
  it("null／空物件／只有 flags → 不是異常", () => {
    expect(hasRealAnomaly(null)).toBe(false);
    expect(hasRealAnomaly({})).toBe(false);
    expect(hasRealAnomaly({ flags: { ptoWork: true, compDayOwed: 1, dinnerTaken: true, dinnerSource: "punch" } })).toBe(false);
  });

  it("舊列頂層旗標（改版前結算）也不算異常", () => {
    expect(hasRealAnomaly({ ptoWork: true, compDayOwed: 1, compTimeMinutes: 60, dinnerTaken: false, dinnerSource: "manual" })).toBe(false);
  });

  it("在家工作認列（新列 flags.wfh、舊列頂層 wfh）不算異常", () => {
    expect(hasRealAnomaly({ flags: { wfh: true } })).toBe(false);
    expect(hasRealAnomaly({ wfh: true })).toBe(false);
  });

  it("未配對打卡、單日加班上限仍是異常", () => {
    expect(hasRealAnomaly({ unpairedPunches: 1, flags: { dinnerTaken: true } })).toBe(true);
    expect(hasRealAnomaly({ overtimeCapExceeded: { minutes: 300, capMinutes: 240 } })).toBe(true);
  });

  it("CSV 匯出只留真正的異常鍵", () => {
    expect(anomalyForExport({ flags: { ptoWork: true } })).toBe("");
    expect(anomalyForExport({ unpairedPunches: 1, flags: { ptoWork: true }, dinnerTaken: true })).toBe('{"unpairedPunches":1}');
  });
});
