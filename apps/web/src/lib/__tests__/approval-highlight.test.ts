import { describe, expect, it } from "vitest";
import {
  APPROVAL_HIGHLIGHT_MISSING,
  highlightDomId,
  highlightState,
  isHighlighted,
  parseHighlightId,
} from "../approval-highlight";

const ID = "11111111-2222-4333-8444-555555555555";

describe("approval-highlight（簽核頁 ?id= 醒目）", () => {
  it("parseHighlightId：只收英數／-／_，最多 64 字", () => {
    expect(parseHighlightId(ID)).toBe(ID);
    expect(parseHighlightId(` ${ID} `)).toBe(ID);
    expect(parseHighlightId(null)).toBeNull();
    expect(parseHighlightId("")).toBeNull();
    expect(parseHighlightId("<script>")).toBeNull();
    expect(parseHighlightId("a/b")).toBeNull();
    expect(parseHighlightId("x".repeat(65))).toBeNull();
  });

  it("highlightState：沒帶 → none；載入中 → loading；在清單 → found；不在 → missing", () => {
    expect(highlightState(null, false, [ID])).toBe("none");
    expect(highlightState(ID, true, [])).toBe("loading");
    expect(highlightState(ID, false, ["a", ID])).toBe("found");
    expect(highlightState(ID.toUpperCase(), false, [ID])).toBe("found");
    expect(highlightState(ID, false, ["a", "b"])).toBe("missing");
    expect(highlightState(ID, false, [])).toBe("missing");
  });

  it("isHighlighted／highlightDomId／提示文字", () => {
    expect(isHighlighted(ID, ID)).toBe(true);
    expect(isHighlighted(ID.toUpperCase(), ID)).toBe(true);
    expect(isHighlighted(null, ID)).toBe(false);
    expect(isHighlighted("other", ID)).toBe(false);
    expect(highlightDomId("r1")).toBe("approval-r1");
    expect(APPROVAL_HIGHLIGHT_MISSING).toBe("此單已處理或你不是目前簽核人");
  });
});
