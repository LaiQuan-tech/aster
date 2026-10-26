import type { GridCell, StatementGrid } from "./statements-api";
import { BORDER_PX, STATEMENT_FONT_STACK, gridGeometry } from "./statement-layout";

/**
 * 薪資明細表 → PDF 檔（員工端「下載 PDF」，2026-10-27）。純前端、不加任何 npm 套件：
 *   1. 用同一份格線（StatementGrid）畫到 <canvas>——字用瀏覽器本機字型畫，中文不缺字；
 *      欄寬、列高、合併、框線、字級與畫面表格同一套換算（lib/statement-layout.ts），版面同畫面。
 *   2. canvas 轉 JPEG，包成一頁 A4 直式的 PDF（PDF 直接內嵌 JPEG＝DCTDecode，不用另外的 PDF 函式庫；
 *      buildSingleImagePdf 是純函式、有單元測試）。
 * 檔名不用真名（避免檔案外流時帶出姓名）：「薪資明細表_{民國年月}_{工號}.pdf」。
 */

/** A4 直式（pt）。 */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;
const MARGIN_PT = 28; // 約 10mm

/** 「薪資明細表_11506_T001.pdf」；工號空白或含檔名不允許的字元時替換掉。 */
export function payslipPdfFilename(period: string, empNo: string | null | undefined): string {
  const [y, m] = period.split("-").map(Number);
  const roc = Number.isFinite(y) && Number.isFinite(m) ? `${y - 1911}${String(m).padStart(2, "0")}` : period;
  const no = (empNo ?? "").trim().replace(/[\\/:*?"<>|\s]+/g, "_") || "未設工號";
  return `薪資明細表_${roc}_${no}.pdf`;
}

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * 一張 JPEG → 一頁 A4 直式 PDF（圖等比例縮到頁面可印範圍內、水平置中、靠上）。純函式。
 * imageWidth／imageHeight 是 JPEG 的像素尺寸。
 */
export function buildSingleImagePdf(jpeg: Uint8Array, imageWidth: number, imageHeight: number): Uint8Array {
  const maxW = A4_WIDTH_PT - MARGIN_PT * 2;
  const maxH = A4_HEIGHT_PT - MARGIN_PT * 2;
  const scale = Math.min(maxW / imageWidth, maxH / imageHeight);
  const w = imageWidth * scale;
  const h = imageHeight * scale;
  const x = (A4_WIDTH_PT - w) / 2;
  const y = A4_HEIGHT_PT - MARGIN_PT - h;
  const content = `q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /Im0 Do Q`;

  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH_PT} ${A4_HEIGHT_PT}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  offsets[4] = length;
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push("\nendstream\nendobj\n");
  obj(5, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`);

  const xrefAt = length;
  const xref = ["xref", "0 6", "0000000000 65535 f "];
  for (let n = 1; n <= 5; n += 1) xref.push(`${String(offsets[n]).padStart(10, "0")} 00000 n `);
  push(`${xref.join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return concat(parts);
}

/** 格子文字的對齊（與畫面表格同規則：未指定時數字靠右、文字靠左）。 */
function alignOf(cell: GridCell): "left" | "center" | "right" {
  return cell.align ?? (typeof cell.value === "number" ? "right" : "left");
}

/** 把格線畫到 canvas（瀏覽器限定）。scale＝解析度倍率（2.5 ≈ A4 寬 200dpi 以上）。 */
export function renderGridToCanvas(grid: StatementGrid, scale = 2.5): HTMLCanvasElement {
  const g = gridGeometry(grid);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(g.width * scale) + 4;
  canvas.height = Math.ceil(g.height * scale) + 4;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("瀏覽器不支援畫布，無法產生 PDF");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(2, 2);
  ctx.scale(scale, scale);

  const box = (cell: GridCell) => {
    const x1 = g.colX[cell.col];
    const x2 = g.colX[Math.min(cell.col + (cell.colSpan ?? 1), grid.columns.length)];
    const y1 = g.rowY[cell.row];
    const y2 = g.rowY[Math.min(cell.row + (cell.rowSpan ?? 1), g.rowY.length - 1)];
    return { x1, x2, y1, y2 };
  };

  // 底色
  for (const cell of grid.cells) {
    if (!cell.fill) continue;
    const { x1, x2, y1, y2 } = box(cell);
    ctx.fillStyle = cell.fill;
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  }
  // 文字（太寬就等比例縮小字級塞進格子，PDF 上不被切掉）
  ctx.textBaseline = "middle";
  for (const cell of grid.cells) {
    if (!cell.text) continue;
    const { x1, x2, y1, y2 } = box(cell);
    const pad = 3;
    let sizePx = ((cell.size ?? 12) * 4) / 3;
    const weight = cell.bold ? "700" : "400";
    ctx.font = `${weight} ${sizePx}px ${STATEMENT_FONT_STACK}`;
    const room = x2 - x1 - pad * 2;
    const measured = ctx.measureText(cell.text).width;
    if (measured > room && room > 0) {
      sizePx = Math.max(sizePx * 0.6, (sizePx * room) / measured);
      ctx.font = `${weight} ${sizePx}px ${STATEMENT_FONT_STACK}`;
    }
    ctx.fillStyle = cell.negative ? "#c00000" : "#000";
    const align = alignOf(cell);
    ctx.textAlign = align;
    const tx = align === "left" ? x1 + pad : align === "right" ? x2 - pad : (x1 + x2) / 2;
    ctx.fillText(cell.text, tx, (y1 + y2) / 2);
  }
  // 框線（畫在格線上，粗細照 Excel 細／中／粗）
  ctx.strokeStyle = "#000";
  ctx.lineCap = "square";
  for (const cell of grid.cells) {
    const b = cell.border;
    if (!b) continue;
    const { x1, x2, y1, y2 } = box(cell);
    const line = (style: keyof typeof BORDER_PX | undefined, ax: number, ay: number, bx: number, by: number) => {
      if (!style) return;
      ctx.lineWidth = BORDER_PX[style] * 0.8;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    };
    line(b.top, x1, y1, x2, y1);
    line(b.bottom, x1, y2, x2, y2);
    line(b.left, x1, y1, x1, y2);
    line(b.right, x2, y1, x2, y2);
  }
  return canvas;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 格線 → PDF Blob（瀏覽器限定）。 */
export async function statementPdfBlob(grid: StatementGrid): Promise<Blob> {
  // 等網頁字型就緒，避免第一次畫時中文落到後備字型。
  if (typeof document !== "undefined" && document.fonts?.ready) await document.fonts.ready;
  const canvas = renderGridToCanvas(grid);
  const jpeg = dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92));
  const pdf = buildSingleImagePdf(jpeg, canvas.width, canvas.height);
  return new Blob([pdf.buffer as ArrayBuffer], { type: "application/pdf" });
}

/** 產生並下載 PDF。 */
export async function downloadStatementPdf(grid: StatementGrid, filename: string): Promise<void> {
  const blob = await statementPdfBlob(grid);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
