/**
 * 部門「有序多位主管」的純函式（無 React、無 DOM；vitest 在 `__tests__/manager-order.test.ts`）。
 *
 * 順序就是簽核順序：index 0＝第 1 位＝小主管（第一關），之後依序往上（大主管…）。
 * 部門頁的有序多選編輯器用 `add`／`remove`／`moveUp`／`moveDown` 改草稿（全部回新陣列、不改原陣列）；
 * 列表與組織圖用 `managerLabelOf`／`orgNodeManagerLabel` 顯示「A → B」。
 * 舊 API（2026-09-22 之前）沒回 `manager_emp_ids`／`managers` 時，`managerIdsOf` 退回 `manager_emp_id`、
 * 標籤退回後端算好的 `manager_label`／`managerLabel`。
 */
import type { DepartmentManager } from "./admin-api";

/** 顯示多位主管用的連接符（與後端 `manager_label` 相同）。 */
export const MANAGER_JOINER = " → ";

/** 加到最後一位；空字串或已在名單內 → 原樣（回同一個陣列參考，方便 setState 略過重繪）。 */
export function add(ids: readonly string[], id: string): readonly string[] {
  if (!id || ids.includes(id)) return ids;
  return [...ids, id];
}

/** 移除該員工；不在名單內 → 原樣。 */
export function remove(ids: readonly string[], id: string): readonly string[] {
  if (!ids.includes(id)) return ids;
  return ids.filter((x) => x !== id);
}

/** 第 index 位往前一位（變成更小的主管）；已是第 1 位或 index 越界 → 原樣。 */
export function moveUp(ids: readonly string[], index: number): readonly string[] {
  if (index <= 0 || index >= ids.length) return ids;
  const next = [...ids];
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return next;
}

/** 第 index 位往後一位（變成更大的主管）；已是最後一位或 index 越界 → 原樣。 */
export function moveDown(ids: readonly string[], index: number): readonly string[] {
  if (index < 0 || index >= ids.length - 1) return ids;
  const next = [...ids];
  [next[index], next[index + 1]] = [next[index + 1], next[index]];
  return next;
}

/** 「第 N 位」的說明：第 1 位＝小主管、第 2 位＝大主管、之後只標序號。 */
export function positionLabel(index: number): string {
  if (index === 0) return "第 1 位（小主管）";
  if (index === 1) return "第 2 位（大主管）";
  return `第 ${index + 1} 位`;
}

/* ---------------------------------------------------------------- 讀取 ----- */

/** 部門列／組織圖節點裡跟主管有關的欄位（兩種命名都收，皆可缺席以相容舊 API）。 */
export interface ManagerFields {
  manager_emp_ids?: readonly string[] | null;
  manager_emp_id?: string | null;
  managers?: readonly DepartmentManager[] | null;
  manager_label?: string | null;
}

/** 有序主管 id：新欄位 `manager_emp_ids` 優先；舊 API 只有 `manager_emp_id` → `[id]`；都沒有 → `[]`。 */
export function managerIdsOf(dept: Pick<ManagerFields, "manager_emp_ids" | "manager_emp_id">): string[] {
  if (Array.isArray(dept.manager_emp_ids)) return [...dept.manager_emp_ids];
  return dept.manager_emp_id ? [dept.manager_emp_id] : [];
}

/** 一位主管的顯示字：後端算好的 label（工號 · 姓名）；沒有工號時 label 就只有姓名。 */
function managerText(manager: DepartmentManager): string {
  return manager.label?.trim() || manager.name;
}

/** `managers[]` → 「A → B」；空陣列 → null（讓呼叫端退回舊欄位）。 */
export function joinManagers(managers: readonly DepartmentManager[] | null | undefined): string | null {
  if (!managers || managers.length === 0) return null;
  return managers.map(managerText).join(MANAGER_JOINER);
}

/**
 * 部門列表「主管」欄：有 `managers` 就用它串「A → B」，沒有（舊 API）退回 `manager_label`；
 * 都沒有 → null（畫面自己顯示「—」）。
 */
export function managerLabelOf(dept: Pick<ManagerFields, "managers" | "manager_label">): string | null {
  return joinManagers(dept.managers) ?? (dept.manager_label?.trim() || null);
}

/** 組織圖節點版（欄位是 camelCase 的 `managers`／`managerLabel`）。 */
export function orgNodeManagerLabel(node: {
  managers?: readonly DepartmentManager[] | null;
  managerLabel?: string | null;
}): string | null {
  return joinManagers(node.managers) ?? (node.managerLabel?.trim() || null);
}
