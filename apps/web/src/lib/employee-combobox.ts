/**
 * EmployeeCombobox 的純邏輯（篩選、鍵盤狀態機、選項組裝）。不 import React／DOM，單元測試在
 * __tests__/employee-combobox.test.ts。元件本體在 components/EmployeeCombobox.tsx。
 *
 * 為什麼自繪：Windows Chrome 的原生 <select> 彈出層在部分顯示卡／縮放設定下整片空白（只剩藍色選取列），
 * 而且原生 select 的寬度由最長選項撐開，員工一多就把版面撐寬。改成可搜尋清單：輸入即篩選、鍵盤可操作、
 * 清單有最大高度可捲動。
 */

export interface EmployeeOption {
  /** 選項值（員工 id）；"" 只用在「全部員工／請選擇」這類空選項。 */
  id: string;
  /** 顯示文字，例「E001 · 王小明」。 */
  label: string;
  /** 額外可搜尋的文字（工號、身分證、員工 ID…）；label 一定會被搜尋。 */
  searchText?: string;
  /** 分組標題（例：部門、「已離職」）；同組要排在一起，清單照輸入順序顯示組標題。 */
  group?: string;
  disabled?: boolean;
  /** 顯示在選項右側的小字（例：「已離職」）。 */
  note?: string;
}

/** 依關鍵字篩選（不分大小寫、去頭尾空白；空白分隔的多個字都要命中）。空選項（id ""）永遠保留在最前面。 */
export function filterEmployeeOptions(options: readonly EmployeeOption[], query: string): EmployeeOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...options];
  return options.filter((o) => {
    if (o.id === "") return false;
    const hay = `${o.label} ${o.searchText ?? ""} ${o.id} ${o.note ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export interface ComboState {
  open: boolean;
  /** 使用者正在打的字（open 時才有意義；關閉後輸入框顯示已選者的 label）。 */
  query: string;
  /** 目前反白的選項在「篩選後清單」的索引；-1 = 沒有。 */
  active: number;
}

export const CLOSED: ComboState = { open: false, query: "", active: -1 };

export type ComboAction =
  | { type: "focus" }
  | { type: "type"; query: string }
  | { type: "key"; key: string }
  | { type: "hover"; index: number }
  | { type: "close" };

export interface ComboResult {
  state: ComboState;
  /** 有值 = 這次動作選定了這個 id（"" = 選了空選項）。 */
  select?: string;
}

function nextEnabled(list: readonly EmployeeOption[], from: number, step: 1 | -1): number {
  if (list.length === 0) return -1;
  let i = from;
  for (let n = 0; n < list.length; n++) {
    i = (i + step + list.length) % list.length;
    if (!list[i]!.disabled) return i;
  }
  return -1;
}

/** 開啟時預設反白：目前選到的那筆，沒有就第一個可選的。 */
function initialActive(list: readonly EmployeeOption[], value: string): number {
  const idx = list.findIndex((o) => o.id === value && !o.disabled);
  return idx >= 0 ? idx : nextEnabled(list, -1, 1);
}

/**
 * 鍵盤／輸入狀態機（純函式）。`options` 是完整清單，`value` 是目前選定的 id。
 *   ↓／↑：沒開就打開；開著就移動反白（跳過 disabled，頭尾循環）
 *   Enter：開著且有反白 → 選取並關閉
 *   Escape／Tab：關閉（不改值）
 *   打字：打開並篩選，反白第一個可選項
 */
export function comboReduce(
  state: ComboState,
  action: ComboAction,
  options: readonly EmployeeOption[],
  value: string,
): ComboResult {
  switch (action.type) {
    case "focus":
      return { state: state.open ? state : { open: true, query: "", active: initialActive(options, value) } };
    case "type": {
      const list = filterEmployeeOptions(options, action.query);
      return { state: { open: true, query: action.query, active: nextEnabled(list, -1, 1) } };
    }
    case "hover": {
      const list = filterEmployeeOptions(options, state.query);
      return { state: list[action.index] && !list[action.index]!.disabled ? { ...state, active: action.index } : state };
    }
    case "close":
      return { state: CLOSED };
    case "key": {
      const list = filterEmployeeOptions(options, state.query);
      switch (action.key) {
        case "ArrowDown":
        case "ArrowUp": {
          if (!state.open) return { state: { open: true, query: "", active: initialActive(options, value) } };
          const step = action.key === "ArrowDown" ? 1 : -1;
          const from = state.active < 0 && step === -1 ? 0 : state.active;
          return { state: { ...state, active: nextEnabled(list, from, step) } };
        }
        case "Home":
          return state.open ? { state: { ...state, active: nextEnabled(list, -1, 1) } } : { state };
        case "End":
          return state.open ? { state: { ...state, active: nextEnabled(list, 0, -1) } } : { state };
        case "Enter": {
          if (!state.open) return { state: { open: true, query: "", active: initialActive(options, value) } };
          const picked = list[state.active];
          if (!picked || picked.disabled) return { state };
          return { state: CLOSED, select: picked.id };
        }
        case "Escape":
        case "Tab":
          return { state: CLOSED };
        default:
          return { state };
      }
    }
  }
}

/** 標準顯示：「工號 · 姓名」；沒有工號就只顯示姓名。 */
export function employeeLabel(e: { name?: string | null; emp_no?: string | null; empNo?: string | null }): string {
  const no = e.emp_no ?? e.empNo ?? null;
  const name = e.name ?? "";
  return no ? `${no} · ${name}` : name;
}

/** 由員工清單組選項（label＝工號 · 姓名；工號、姓名、員工 ID、extra（例：身分證）都可搜尋）。 */
export function employeeOptionsOf<
  E extends { id: string; name?: string | null; emp_no?: string | null; empNo?: string | null },
>(employees: readonly E[], extra?: (e: E) => string | null | undefined, label?: (e: E) => string): EmployeeOption[] {
  return employees.map((e) => ({
    id: e.id,
    label: label ? label(e) : employeeLabel(e),
    searchText: [e.emp_no ?? e.empNo ?? "", e.name ?? "", extra?.(e) ?? ""].filter(Boolean).join(" "),
  }));
}
