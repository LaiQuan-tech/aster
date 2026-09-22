/**
 * 批次匯入（Excel 範本下載 → 填寫 → 上傳）的 API 呼叫。端點形狀照 batch-import-contract.md：
 *   GET  /imports/:kind/template → xlsx 下載（HR only）
 *   POST /imports/:kind { fileName, dataBase64, dryRun?, options? } → ImportResponse
 * dryRun=true 只驗證不寫入（面板選檔後的預檢）；dryRun=false 只匯入沒錯的列，errors 照列回報。
 */
import { apiFetch } from "./api-client";
import type { ImportKind } from "./import-kinds";

export type { ImportKind } from "./import-kinds";

export interface ImportError {
  /** Excel 列號（表頭是第 1 列，第一筆資料是第 2 列）。 */
  line: number;
  message: string;
}

export interface ImportResponse {
  kind: ImportKind;
  dryRun: boolean;
  /** 資料列數（不含表頭、空列）。 */
  total: number;
  /** 可匯入的列數。 */
  valid: number;
  errors: ImportError[];
  /** 非 dryRun 時實際寫入筆數。 */
  imported?: number;
  /** kind 專屬（employees 為 BulkInviteResult；holidays 為 {year, generated, imported, skipped}）。 */
  result?: unknown;
}

export interface ImportRequestBody {
  fileName: string;
  dataBase64: string;
  dryRun?: boolean;
  options?: Record<string, unknown>;
}

export function importTemplateUrl(kind: ImportKind): string {
  return `/imports/${kind}/template`;
}

export function runImport(kind: ImportKind, body: ImportRequestBody) {
  return apiFetch<ImportResponse>(`/imports/${kind}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
