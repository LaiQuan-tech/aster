/**
 * 簽核畫面的請假列：顯示假別名稱＋申請人各假別已請／剩餘（2026-11-17 業主）。假資料，無真實人名。
 */
import { describe, expect, it } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { LeaveBalanceSummaryText, LeaveTypeBalanceList } from "../LeaveBalanceSummary";
import { kindChipLabel } from "@/lib/approval-view";
import type { LeaveTypeBalanceEntry } from "@/lib/leave-balance-summary";

/**
 * 不經 react-dom 的極簡「渲染」：元件都是純函式，直接展開元素樹成文字＋屬性標記
 * （本機借用的 node_modules react／react-dom 版本不一致，renderToStaticMarkup 會丟錯）。
 */
function render(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(render).join("");
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown> & { children?: ReactNode };
    if (typeof node.type === "function") return render((node.type as (p: unknown) => ReactNode)(props));
    const attrs = Object.entries(props)
      .filter(([k, v]) => k !== "children" && k !== "style" && v != null && typeof v !== "object")
      .map(([k, v]) => ` ${k === "className" ? "class" : k}="${String(v)}"`)
      .join("");
    return `<${String(node.type)}${attrs}>${render(props.children)}</${String(node.type)}>`;
  }
  return "";
}
const renderToStaticMarkup = render;

const list: LeaveTypeBalanceEntry[] = [
  { leaveTypeId: "t1", name: "特休", current: false, capped: true, source: "balance", remainingHours: 40, pendingHours: 4, usedHours: 16 },
  { leaveTypeId: "t2", name: "病假", current: true, capped: true, source: "balance", remainingHours: 232, pendingHours: 0, usedHours: 8 },
  { leaveTypeId: "t3", name: "育嬰假", current: false, capped: false, source: null, remainingHours: null, pendingHours: 0, usedHours: 12 },
];

describe("請假列顯示假別", () => {
  it("類型 chip：請假列帶假別名稱；沒名稱或非請假照舊", () => {
    expect(kindChipLabel({ kind: "leave", leave_type_name: "病假" })).toBe("請假・病假");
    expect(kindChipLabel({ kind: "leave", leave_type_name: "自訂公益假" })).toBe("請假・自訂公益假");
    expect(kindChipLabel({ kind: "leave", leave_type_name: null })).toBe("請假");
    expect(kindChipLabel({ kind: "fix_punch", leave_type_name: null })).toBe("補卡");
  });

  it("今年已請那行寫出假別", () => {
    const html = renderToStaticMarkup(
      <LeaveBalanceSummaryText
        balance={{ capped: false, source: null, remainingHours: null, pendingHours: 0, usedHours: 0, hoursPerDay: 8 }}
        hours={8}
        leaveTypeName="病假"
      />,
    );
    expect(html).toContain("今年已請病假 0 小時（約 0 天）");
  });

  it("各假別一覽：本單假別醒目、有額度顯示剩餘與簽核中、無額度只顯示已請", () => {
    const html = renderToStaticMarkup(<LeaveTypeBalanceList list={list} hoursPerDay={8} />);
    expect(html).toContain("申請人各假別（今年）");
    expect(html).toContain("已請 16 小時／剩 40 小時（約 5 天）・簽核中 4 小時");
    expect(html).toContain("已請 8 小時／剩 232 小時（約 29 天）");
    expect(html).toContain("已請 12 小時（無額度）");
    expect(html).toMatch(/<li aria-current="true"[^>]*font-semibold[^>]*>.*病假/);
    expect(html.match(/aria-current/g)).toHaveLength(1);
  });

  it("沒有資料不顯示", () => {
    expect(renderToStaticMarkup(<LeaveTypeBalanceList list={[]} hoursPerDay={8} />)).toBe("");
    expect(renderToStaticMarkup(<LeaveTypeBalanceList list={undefined} hoursPerDay={8} />)).toBe("");
  });
});
