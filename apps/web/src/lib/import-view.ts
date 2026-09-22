/**
 * 批次匯入面板的顯示邏輯（純函式，vitest 在 __tests__/import-view.test.ts）。
 * 不 import React 也不打 API，方便測試與重用。
 */
import type { BulkInviteResult } from "./auth-api";
import type { ImportError, ImportResponse } from "./import-api";

/** 上傳前在瀏覽器端先擋掉的限制，與 API 端一致（≤ 4MB、只收 .xlsx）。 */
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

/** 面板一次最多列出幾條錯誤，其餘折成「還有 N 條」。 */
export const IMPORT_ERROR_LINES_MAX = 50;

/** API 錯誤碼 → 中文；其餘顯示原訊息。 */
const IMPORT_ERROR_TEXT: Record<string, string> = {
  invalid_header: "表頭對不上範本，請重新下載範本填寫",
  unsupported_file: "只接受 .xlsx 檔",
  file_too_large: "檔案超過 4MB",
};

/** 範本檔名：`匯入範本-{label}.xlsx`。 */
export function templateFileName(label: string): string {
  return `匯入範本-${label}.xlsx`;
}

/** 預檢結果的一句摘要：「共 N 列：可匯入 V 筆、錯誤 E 筆」。 */
export function summarizeImport(res: Pick<ImportResponse, "total" | "valid" | "errors">): string {
  return `共 ${res.total} 列：可匯入 ${res.valid} 筆、錯誤 ${res.errors.length} 筆`;
}

/**
 * 錯誤清單要顯示的行（`第 {line} 列：{message}`，依列號排序）與被折起來的條數。
 * `max` 預設 50。
 */
export function errorLinesToShow(errors: ImportError[], max = IMPORT_ERROR_LINES_MAX): { lines: string[]; remaining: number } {
  const sorted = [...errors].sort((a, b) => a.line - b.line);
  const shown = sorted.slice(0, Math.max(0, max));
  return {
    lines: shown.map((e) => `第 ${e.line} 列：${e.message}`),
    remaining: Math.max(0, sorted.length - shown.length),
  };
}

/** 「確認匯入」按鈕文案：有錯誤列時改成「略過錯誤列，匯入 V 筆」；V=0 由呼叫端 disabled。 */
export function confirmImportLabel(res: Pick<ImportResponse, "valid" | "errors">): string {
  if (res.valid > 0 && res.errors.length > 0) return `略過錯誤列，匯入 ${res.valid} 筆`;
  return `確認匯入 ${res.valid} 筆`;
}

/** 匯入完成的 toast 文案：「已匯入 N 筆」＋（有錯誤列時）「，略過 E 筆錯誤列」。 */
export function importDoneMessage(res: Pick<ImportResponse, "valid" | "errors" | "imported">): string {
  const count = res.imported ?? res.valid;
  const skipped = res.errors.length > 0 ? `，略過 ${res.errors.length} 筆錯誤列` : "";
  return `已匯入 ${count} 筆${skipped}`;
}

/** 選檔後、送出前在瀏覽器端先檢查副檔名與大小；回 null 表示可上傳。 */
export function validateImportFile(file: { name: string; size: number }): string | null {
  if (!/\.xlsx$/i.test(file.name)) return IMPORT_ERROR_TEXT.unsupported_file;
  if (file.size > IMPORT_MAX_BYTES) return IMPORT_ERROR_TEXT.file_too_large;
  return null;
}

/**
 * apiFetch 丟出的錯誤（`[400] invalid_header` 這種）轉成中文；API 有補充說明（例如缺哪個欄）就
 * 括在後面。對不上表的錯誤碼顯示原訊息；不是 Error 就回 fallback。
 */
export function importErrorMessage(err: unknown, fallback = "匯入失敗"): string {
  if (!(err instanceof Error)) return fallback;
  const e = err as Error & { code?: string; detail?: string };
  const match = /^\[(\d{3})\]\s+([a-z][a-z0-9_]*)\s*$/i.exec(e.message.trim());
  const code = e.code ?? match?.[2] ?? null;
  const text = code ? IMPORT_ERROR_TEXT[code] : undefined;
  if (text) return e.detail && e.detail !== code ? `${text}（${e.detail}）` : text;
  return e.message || fallback;
}

/** employees kind 的 `result` 是否為 bulk-invite 的結果（有 rows 陣列＋計數）。 */
export function isBulkInviteResult(value: unknown): value is BulkInviteResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<BulkInviteResult>;
  return Array.isArray(v.rows) && typeof v.created === "number" && typeof v.skipped === "number";
}
