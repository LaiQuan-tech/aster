import { beforeEach, describe, expect, it, vi } from "vitest";

const apiDownload = vi.fn(async () => undefined);
vi.mock("../api-client", () => ({ apiFetch: vi.fn(), apiDownload: (...args: unknown[]) => apiDownload(...(args as [])) }));

import { downloadAnnualProjectsXlsx, downloadProjectRegisterXlsx } from "../projects-ext-api";
import { isTextSelected } from "../project-register";

function query(call: unknown[]): URLSearchParams {
  return new URLSearchParams(String(call[0]).split("?")[1]);
}

describe("兩種總表匯出分開", () => {
  beforeEach(() => apiDownload.mockClear());

  it("專案列表「下載 Excel」帶 layout=register（與原 Excel 一模一樣）", async () => {
    await downloadProjectRegisterXlsx({ year: 2026, includeArchived: true });
    const q = query(apiDownload.mock.calls[0] as unknown[]);
    expect(q.get("layout")).toBe("register");
    expect(q.get("format")).toBe("xlsx");
    expect(q.get("year")).toBe("2026");
    expect(q.get("includeArchived")).toBe("1");
    expect((apiDownload.mock.calls[0] as unknown[])[1]).toBe("專案申請單總表_民國115.xlsx");
  });

  it("全部年度：不帶 year，讓後端依租戶時區取今年", async () => {
    await downloadProjectRegisterXlsx({ year: null });
    const q = query(apiDownload.mock.calls[0] as unknown[]);
    expect(q.has("year")).toBe(false);
    expect((apiDownload.mock.calls[0] as unknown[])[1]).toBe("專案申請單總表_今年度.xlsx");
  });

  it("年度總表頁「匯出 xlsx」不帶 layout（維持原本含系統欄的版面）", async () => {
    await downloadAnnualProjectsXlsx({ year: 115 });
    expect(query(apiDownload.mock.calls[0] as unknown[]).has("layout")).toBe(false);
  });
});

describe("拖曳選字不導頁", () => {
  it("有選取文字＝true；沒選取、只有游標、只選到空白＝false", () => {
    expect(isTextSelected({ isCollapsed: false, toString: () => "1,000" })).toBe(true);
    expect(isTextSelected({ isCollapsed: true, toString: () => "" })).toBe(false);
    expect(isTextSelected({ isCollapsed: false, toString: () => "  " })).toBe(false);
    expect(isTextSelected(null)).toBe(false);
  });
});
