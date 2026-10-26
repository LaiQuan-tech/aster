import { describe, expect, it } from "vitest";
import { A4_HEIGHT_PT, A4_WIDTH_PT, buildSingleImagePdf, payslipPdfFilename } from "../statement-pdf";
import { columnPx, coveredPositions, gridGeometry, rowPx } from "../statement-layout";
import type { StatementGrid } from "../statements-api";

describe("payslipPdfFilename — 不用真名，用民國年月＋工號", () => {
  it("薪資明細表_{民國年月}_{工號}.pdf", () => {
    expect(payslipPdfFilename("2026-06", "T001")).toBe("薪資明細表_11506_T001.pdf");
    expect(payslipPdfFilename("2026-10", "A-12")).toBe("薪資明細表_11510_A-12.pdf");
  });
  it("工號空白 → 未設工號；檔名不允許的字元換掉", () => {
    expect(payslipPdfFilename("2026-06", null)).toBe("薪資明細表_11506_未設工號.pdf");
    expect(payslipPdfFilename("2026-06", "  ")).toBe("薪資明細表_11506_未設工號.pdf");
    expect(payslipPdfFilename("2026-06", "a/b c")).toBe("薪資明細表_11506_a_b_c.pdf");
  });
});

describe("buildSingleImagePdf — 一張 JPEG 包成一頁 A4 直式", () => {
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = buildSingleImagePdf(fakeJpeg, 1200, 800);
  const text = new TextDecoder("latin1").decode(pdf);

  it("PDF 結構：表頭、A4 頁面、DCTDecode 影像、單頁", () => {
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain(`/MediaBox [0 0 ${A4_WIDTH_PT} ${A4_HEIGHT_PT}]`);
    expect(text).toContain("/Filter /DCTDecode");
    expect(text).toContain("/Width 1200 /Height 800");
    expect(text).toContain(`/Length ${fakeJpeg.length}`);
    expect(text).toContain("/Count 1");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("xref 位移正確（每個物件的位移都指到 'n 0 obj'）", () => {
    const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe("xref");
    const entries = text.slice(startxref).split("\n").slice(3, 8);
    entries.forEach((line, i) => {
      const offset = Number(line.slice(0, 10));
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it("影像等比例縮進頁面可印範圍、水平置中", () => {
    const m = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(text)!;
    const [w, h, x] = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(w).toBeLessThanOrEqual(A4_WIDTH_PT - 56 + 0.01);
    expect(w / h).toBeCloseTo(1200 / 800, 2);
    expect(x + w / 2).toBeCloseTo(A4_WIDTH_PT / 2, 1);
  });
});

describe("格線像素換算（畫面與 PDF 共用）", () => {
  const grid: StatementGrid = {
    kind: "payslip",
    title: "t",
    columns: [10, 5],
    rowHeights: [15, 15],
    font: "x",
    cells: [
      { row: 0, col: 0, colSpan: 2, value: "標題", text: "標題", format: "text" },
      { row: 1, col: 0, value: 1, text: "1", format: "general" },
    ],
  };
  it("欄寬 = 寬×8+5、列高 pt→px、合併蓋掉的位置", () => {
    expect(columnPx(10)).toBe(85);
    expect(rowPx(15)).toBe(20);
    expect(gridGeometry(grid)).toMatchObject({ width: 85 + 45, height: 40 });
    expect([...coveredPositions(grid)]).toEqual(["0:1"]);
  });
});
