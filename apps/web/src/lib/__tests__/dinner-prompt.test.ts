import { describe, expect, it } from "vitest";
import { dinnerBodyFor, showDinnerCheckbox } from "../dinner-prompt";

describe("晚餐勾選提示（lib/dinner-prompt.ts）", () => {
  const prompt = { optIn: true, fromAt: "2026-10-17T10:00:00.000Z", workDate: "2026-10-17" };
  const at = (iso: string) => Date.parse(iso);

  it("上班中、規則 opt_in、已過正常下班 → 顯示", () => {
    expect(showDinnerCheckbox(prompt, "working", at("2026-10-17T10:00:00.000Z"))).toBe(true);
    expect(showDinnerCheckbox(prompt, "working", at("2026-10-17T12:30:00.000Z"))).toBe(true);
  });

  it("還沒到正常下班、已下班、規則不是 opt_in、不適用 → 不顯示", () => {
    expect(showDinnerCheckbox(prompt, "working", at("2026-10-17T09:59:00.000Z"))).toBe(false);
    expect(showDinnerCheckbox(prompt, "done", at("2026-10-17T12:00:00.000Z"))).toBe(false);
    expect(showDinnerCheckbox({ ...prompt, optIn: false }, "working", at("2026-10-17T12:00:00.000Z"))).toBe(false);
    expect(showDinnerCheckbox({ ...prompt, fromAt: null }, "working", at("2026-10-17T12:00:00.000Z"))).toBe(false);
    expect(showDinnerCheckbox(null, "working", at("2026-10-17T12:00:00.000Z"))).toBe(false);
  });

  it("下班卡且有顯示才帶 dinnerTaken（沒勾＝false），上班卡不帶", () => {
    expect(dinnerBodyFor("out", true, true)).toEqual({ dinnerTaken: true });
    expect(dinnerBodyFor("out", true, false)).toEqual({ dinnerTaken: false });
    expect(dinnerBodyFor("out", false, true)).toEqual({});
    expect(dinnerBodyFor("in", true, true)).toEqual({});
  });
});
