import { describe, it, expect } from "vitest";
import {
  diffConfigs,
  isDefaultRuleVersion,
  normalizeRuleVersions,
  ruleVersionLabel,
  type RuleConfigVersionFull,
} from "../rule-config-api";

/** 測試用最小列：config 只要是物件就好（比對邏輯不看型別細節）。 */
function row(version: number, extra: Partial<RuleConfigVersionFull> = {}): RuleConfigVersionFull {
  return {
    version,
    effectiveFrom: `2026-0${Math.min(version + 1, 9)}-01`,
    createdAt: `2026-0${Math.min(version + 1, 9)}-01T00:00:00Z`,
    active: false,
    config: { overtime: { rules: [] }, v: version } as unknown as RuleConfigVersionFull["config"],
    configValid: true,
    ...extra,
  };
}

describe("isDefaultRuleVersion／ruleVersionLabel（v0 系統預設）", () => {
  it("isDefault 旗標或 version 0 都算系統預設；一般版本不是", () => {
    expect(isDefaultRuleVersion({ version: 0 })).toBe(true);
    expect(isDefaultRuleVersion({ version: 0, isDefault: true })).toBe(true);
    expect(isDefaultRuleVersion({ version: 5, isDefault: true })).toBe(true);
    expect(isDefaultRuleVersion({ version: 1 })).toBe(false);
    expect(isDefaultRuleVersion({ version: 1, isDefault: false })).toBe(false);
  });

  it("標籤：一般版本 v3；系統預設 v0（系統預設）", () => {
    expect(ruleVersionLabel({ version: 3 })).toBe("v3");
    expect(ruleVersionLabel({ version: 0, isDefault: true })).toBe("v0（系統預設）");
    expect(ruleVersionLabel({ version: 0 })).toBe("v0（系統預設）");
  });
});

describe("normalizeRuleVersions：v0 在最後、新版在前、向後相容", () => {
  it("舊回應（沒有 v0、新版在前）：順序不變、全部 isDefault false", () => {
    const rows = normalizeRuleVersions([row(3), row(2), row(1)]);
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(rows.every((r) => r.isDefault === false)).toBe(true);
    expect(rows.every((r) => r.configValid === true)).toBe(true);
    // 預設比對：最新兩版
    expect([rows[0]?.version, rows[1]?.version]).toEqual([3, 2]);
  });

  it("新回應：後端把 v0 放在陣列最前面 → 排到最後；isDefault 補上；沒帶 configValid 但有 config → 視為有效", () => {
    const v0 = {
      version: 0,
      isDefault: true,
      effectiveFrom: null,
      createdAt: null,
      active: false,
      config: { overtime: { rules: [] } },
    } as unknown as RuleConfigVersionFull;
    const rows = normalizeRuleVersions([v0, row(2), row(1)]);
    expect(rows.map((r) => r.version)).toEqual([2, 1, 0]);
    expect(rows[2]).toMatchObject({ version: 0, isDefault: true, configValid: true, effectiveFrom: null, createdAt: null });
    expect(ruleVersionLabel(rows[2]!)).toBe("v0（系統預設）");
    // 預設比對仍是最新兩版（v2 ↔ v1），不會被 v0 搶走
    expect([rows[0]?.version, rows[1]?.version]).toEqual([2, 1]);
  });

  it("只有 v1 時：清單是 [v1, v0]，預設比對就是 v0 ↔ v1，且 diff 算得出差異", () => {
    const v0 = { version: 0, isDefault: true, effectiveFrom: null, createdAt: null, active: false, config: { a: 1, b: 2 } } as unknown as RuleConfigVersionFull;
    const v1 = row(1, { config: { a: 1, b: 3 } as unknown as RuleConfigVersionFull["config"], active: true });
    const rows = normalizeRuleVersions([v0, v1]);
    expect(rows.map((r) => r.version)).toEqual([1, 0]);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const target = rows[0]!;
    const base = rows[1]!;
    expect(base.isDefault).toBe(true);
    const diff = diffConfigs(base.config, target.config);
    expect(diff.rows).toEqual([{ path: "b", a: "2", b: "3", kind: "changed" }]);
    expect(diff.sameCount).toBe(1);
  });

  it("沒有任何版本的租戶：只有 v0（active true）→ 一筆，不會炸", () => {
    const v0 = { version: 0, isDefault: true, effectiveFrom: null, createdAt: null, active: true, config: {} } as unknown as RuleConfigVersionFull;
    const rows = normalizeRuleVersions([v0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 0, isDefault: true, active: true, configValid: true });
  });

  it("v0 沒帶 configValid 且 config 是 null → configValid false（不能檢視／比對）；明示的 configValid 原樣保留", () => {
    const v0 = { version: 0, isDefault: true, effectiveFrom: null, createdAt: null, active: false, config: null } as unknown as RuleConfigVersionFull;
    const legacy = row(1, { configValid: false });
    const rows = normalizeRuleVersions([v0, legacy]);
    expect(rows.find((r) => r.version === 0)?.configValid).toBe(false);
    expect(rows.find((r) => r.version === 1)?.configValid).toBe(false);
    expect(normalizeRuleVersions([])).toEqual([]);
  });
});
