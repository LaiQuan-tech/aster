import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CLOSED, comboReduce, employeeLabel, employeeOptionsOf, filterEmployeeOptions, type EmployeeOption } from "../employee-combobox";
import { EmployeeCombobox } from "@/components/EmployeeCombobox";

// 可搜尋員工選單（2026-11-08）。假資料。
const emps = [
  { id: "e1", name: "王小明", emp_no: "A001" },
  { id: "e2", name: "李小華", emp_no: "A002" },
  { id: "e3", name: "陳大文", emp_no: null },
];
const opts: EmployeeOption[] = employeeOptionsOf(emps, (e) => (e.id === "e2" ? "B123456789" : ""));
const withEmpty: EmployeeOption[] = [{ id: "", label: "全部員工" }, ...opts];

describe("employeeOptionsOf／employeeLabel", () => {
  it("label＝工號 · 姓名；沒有工號只顯示姓名", () => {
    expect(opts.map((o) => o.label)).toEqual(["A001 · 王小明", "A002 · 李小華", "陳大文"]);
    expect(employeeLabel({ name: "某人", empNo: "X9" })).toBe("X9 · 某人");
  });
});

describe("filterEmployeeOptions", () => {
  it("工號、姓名、身分證（extra）、員工 ID 都可搜；不分大小寫；多個字都要命中", () => {
    expect(filterEmployeeOptions(opts, "a002").map((o) => o.id)).toEqual(["e2"]);
    expect(filterEmployeeOptions(opts, "小").map((o) => o.id)).toEqual(["e1", "e2"]);
    expect(filterEmployeeOptions(opts, "b1234").map((o) => o.id)).toEqual(["e2"]);
    expect(filterEmployeeOptions(opts, "e3").map((o) => o.id)).toEqual(["e3"]);
    expect(filterEmployeeOptions(opts, "A00 明").map((o) => o.id)).toEqual(["e1"]);
    expect(filterEmployeeOptions(opts, "不存在")).toEqual([]);
  });
  it("空關鍵字 → 全部（含空選項）；有關鍵字 → 空選項不出現", () => {
    expect(filterEmployeeOptions(withEmpty, " ").map((o) => o.id)).toEqual(["", "e1", "e2", "e3"]);
    expect(filterEmployeeOptions(withEmpty, "王").map((o) => o.id)).toEqual(["e1"]);
  });
});

describe("comboReduce（鍵盤）", () => {
  it("focus 打開並反白目前選到的；↓↑ 移動（頭尾循環）；Enter 選取並關閉", () => {
    let r = comboReduce(CLOSED, { type: "focus" }, opts, "e2");
    expect(r.state).toEqual({ open: true, query: "", active: 1 });
    r = comboReduce(r.state, { type: "key", key: "ArrowDown" }, opts, "e2");
    expect(r.state.active).toBe(2);
    r = comboReduce(r.state, { type: "key", key: "ArrowDown" }, opts, "e2");
    expect(r.state.active).toBe(0);
    r = comboReduce(r.state, { type: "key", key: "ArrowUp" }, opts, "e2");
    expect(r.state.active).toBe(2);
    r = comboReduce(r.state, { type: "key", key: "Enter" }, opts, "e2");
    expect(r.select).toBe("e3");
    expect(r.state.open).toBe(false);
  });
  it("打字篩選並反白第一筆，Enter 選到篩選後的那筆", () => {
    let r = comboReduce(CLOSED, { type: "type", query: "李" }, opts, "");
    expect(r.state).toEqual({ open: true, query: "李", active: 0 });
    r = comboReduce(r.state, { type: "key", key: "Enter" }, opts, "");
    expect(r.select).toBe("e2");
  });
  it("Esc／Tab 關閉不改值；沒有結果時 Enter 不選", () => {
    const open = comboReduce(CLOSED, { type: "type", query: "zzz" }, opts, "e1").state;
    expect(open.active).toBe(-1);
    expect(comboReduce(open, { type: "key", key: "Enter" }, opts, "e1").select).toBeUndefined();
    expect(comboReduce(open, { type: "key", key: "Escape" }, opts, "e1")).toEqual({ state: CLOSED });
    expect(comboReduce(open, { type: "key", key: "Tab" }, opts, "e1")).toEqual({ state: CLOSED });
  });
  it("關著按 ↓ 打開；disabled 選項會被跳過、也不能 hover 反白", () => {
    const list: EmployeeOption[] = [opts[0]!, { ...opts[1]!, disabled: true }, opts[2]!];
    let r = comboReduce(CLOSED, { type: "key", key: "ArrowDown" }, list, "");
    expect(r.state).toEqual({ open: true, query: "", active: 0 });
    r = comboReduce(r.state, { type: "key", key: "ArrowDown" }, list, "");
    expect(r.state.active).toBe(2);
    expect(comboReduce(r.state, { type: "hover", index: 1 }, list, "").state.active).toBe(2);
  });
  it("空選項可用鍵盤選到（「全部員工」→ select ''）", () => {
    let r = comboReduce(CLOSED, { type: "focus" }, withEmpty, "e1");
    r = comboReduce(r.state, { type: "key", key: "Home" }, withEmpty, "e1");
    expect(comboReduce(r.state, { type: "key", key: "Enter" }, withEmpty, "e1").select).toBe("");
  });
});

describe("EmployeeCombobox 靜態渲染（a11y）", () => {
  it("input 是 role=combobox、aria-expanded=false、已選者顯示在輸入框、有清除鈕；name → hidden input", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeCombobox, { options: opts, value: "e1", onChange: () => {}, name: "employeeId", ariaLabel: "員工" }),
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('value="A001 · 王小明"');
    expect(html).toContain('aria-label="清除選擇"');
    expect(html).toContain('type="hidden" name="employeeId" value="e1"');
  });
  it("空值＋emptyLabel → placeholder 顯示空選項文字；disabled 沒有清除鈕", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeCombobox, { options: opts, value: "", onChange: () => {}, emptyLabel: "全部員工", disabled: true }),
    );
    expect(html).toContain('placeholder="全部員工"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("清除選擇");
  });
});
