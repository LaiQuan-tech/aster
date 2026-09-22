import { describe, it, expect } from "vitest";
import type { DepartmentManager } from "../admin-api";
import {
  MANAGER_JOINER,
  add,
  joinManagers,
  managerIdsOf,
  managerLabelOf,
  moveDown,
  moveUp,
  orgNodeManagerLabel,
  positionLabel,
  remove,
} from "../manager-order";

const A = "aaaaaaaa-0000-0000-0000-000000000000";
const B = "bbbbbbbb-0000-0000-0000-000000000000";
const C = "cccccccc-0000-0000-0000-000000000000";

const MANAGERS: DepartmentManager[] = [
  { id: A, name: "測試員工A", emp_no: "T001", label: "T001 · 測試員工A" },
  { id: B, name: "測試員工B", emp_no: null, label: "測試員工B" },
];

describe("add／remove（有序、去重、不改原陣列）", () => {
  it("add 加到最後一位；重複或空字串原樣回（同一個參考）", () => {
    const base: readonly string[] = [A];
    expect(add(base, B)).toEqual([A, B]);
    expect(add(base, A)).toBe(base);
    expect(add(base, "")).toBe(base);
    expect(base).toEqual([A]);
    expect(add([], A)).toEqual([A]);
  });

  it("remove 移掉該員工、其餘順序不變；不在名單內原樣回", () => {
    const base: readonly string[] = [A, B, C];
    expect(remove(base, B)).toEqual([A, C]);
    expect(remove(base, "nobody")).toBe(base);
    expect(base).toEqual([A, B, C]);
  });
});

describe("moveUp／moveDown（第 1 位＝小主管）", () => {
  it("moveUp 往前一位；第 1 位或越界原樣回", () => {
    const base: readonly string[] = [A, B, C];
    expect(moveUp(base, 1)).toEqual([B, A, C]);
    expect(moveUp(base, 2)).toEqual([A, C, B]);
    expect(moveUp(base, 0)).toBe(base);
    expect(moveUp(base, 3)).toBe(base);
    expect(moveUp(base, -1)).toBe(base);
    expect(base).toEqual([A, B, C]);
  });

  it("moveDown 往後一位；最後一位或越界原樣回", () => {
    const base: readonly string[] = [A, B, C];
    expect(moveDown(base, 0)).toEqual([B, A, C]);
    expect(moveDown(base, 1)).toEqual([A, C, B]);
    expect(moveDown(base, 2)).toBe(base);
    expect(moveDown(base, -1)).toBe(base);
    expect(moveDown([], 0)).toEqual([]);
  });

  it("moveUp 後再 moveDown 回到原順序", () => {
    const base: readonly string[] = [A, B, C];
    expect(moveDown(moveUp(base, 2), 1)).toEqual([A, B, C]);
  });

  it("positionLabel：第 1 位標小主管、第 2 位標大主管、之後只有序號", () => {
    expect(positionLabel(0)).toBe("第 1 位（小主管）");
    expect(positionLabel(1)).toBe("第 2 位（大主管）");
    expect(positionLabel(2)).toBe("第 3 位");
  });
});

describe("managerIdsOf（新欄位優先、舊 API 退回 manager_emp_id）", () => {
  it("有 manager_emp_ids 就用它（含空陣列）；沒有 → [manager_emp_id]；都沒有 → []", () => {
    expect(managerIdsOf({ manager_emp_ids: [B, A], manager_emp_id: B })).toEqual([B, A]);
    expect(managerIdsOf({ manager_emp_ids: [], manager_emp_id: A })).toEqual([]);
    expect(managerIdsOf({ manager_emp_id: A })).toEqual([A]);
    expect(managerIdsOf({ manager_emp_ids: null, manager_emp_id: A })).toEqual([A]);
    expect(managerIdsOf({ manager_emp_id: null })).toEqual([]);
    expect(managerIdsOf({})).toEqual([]);
  });

  it("回新陣列，不會和來源共用參考", () => {
    const ids = [A, B];
    const out = managerIdsOf({ manager_emp_ids: ids });
    expect(out).toEqual(ids);
    expect(out).not.toBe(ids);
  });
});

describe("managerLabelOf／orgNodeManagerLabel（「A → B」，舊 API 退回後端 label）", () => {
  it("有 managers 依序用 label 串「 → 」；label 空白時退回 name", () => {
    expect(managerLabelOf({ managers: MANAGERS, manager_label: "舊的" })).toBe(`T001 · 測試員工A${MANAGER_JOINER}測試員工B`);
    expect(joinManagers([{ id: C, name: "只有名字", emp_no: null, label: "  " }])).toBe("只有名字");
    expect(MANAGER_JOINER).toBe(" → ");
  });

  it("沒有 managers（舊 API／空陣列）→ 退回 manager_label；都沒有 → null", () => {
    expect(managerLabelOf({ managers: [], manager_label: "T001 · 測試員工A" })).toBe("T001 · 測試員工A");
    expect(managerLabelOf({ manager_label: "T001 · 測試員工A" })).toBe("T001 · 測試員工A");
    expect(managerLabelOf({ managers: null, manager_label: "   " })).toBeNull();
    expect(managerLabelOf({})).toBeNull();
  });

  it("組織圖節點（camelCase）同規則", () => {
    expect(orgNodeManagerLabel({ managers: MANAGERS, managerLabel: "舊的" })).toBe(`T001 · 測試員工A${MANAGER_JOINER}測試員工B`);
    expect(orgNodeManagerLabel({ managers: [], managerLabel: "T001 · 測試員工A" })).toBe("T001 · 測試員工A");
    expect(orgNodeManagerLabel({ managerLabel: null })).toBeNull();
  });
});
