import { describe, it, expect } from "vitest";
import {
  IMPORT_MAX_BYTES,
  confirmImportLabel,
  errorLinesToShow,
  importDoneMessage,
  importErrorMessage,
  isBulkInviteResult,
  summarizeImport,
  templateFileName,
  validateImportFile,
} from "../import-view";
import { IMPORT_KINDS, IMPORT_KIND_LIST } from "../import-kinds";

describe("summarizeImport", () => {
  it("共 N 列：可匯入 V 筆、錯誤 E 筆", () => {
    expect(summarizeImport({ total: 12, valid: 10, errors: [{ line: 3, message: "x" }, { line: 7, message: "y" }] })).toBe(
      "共 12 列：可匯入 10 筆、錯誤 2 筆",
    );
  });

  it("全部正確時錯誤 0 筆", () => {
    expect(summarizeImport({ total: 5, valid: 5, errors: [] })).toBe("共 5 列：可匯入 5 筆、錯誤 0 筆");
  });
});

describe("errorLinesToShow", () => {
  it("轉成「第 N 列：訊息」並依列號排序", () => {
    const { lines, remaining } = errorLinesToShow([
      { line: 9, message: "工號不存在" },
      { line: 2, message: "日期格式錯誤" },
    ]);
    expect(lines).toEqual(["第 2 列：日期格式錯誤", "第 9 列：工號不存在"]);
    expect(remaining).toBe(0);
  });

  it("超過 max 的折成 remaining，預設最多 50 條", () => {
    const errors = Array.from({ length: 63 }, (_, i) => ({ line: i + 2, message: "e" }));
    const { lines, remaining } = errorLinesToShow(errors);
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("第 2 列：e");
    expect(remaining).toBe(13);
    expect(errorLinesToShow(errors, 10)).toMatchObject({ remaining: 53 });
  });

  it("沒有錯誤就是空清單", () => {
    expect(errorLinesToShow([])).toEqual({ lines: [], remaining: 0 });
  });
});

describe("confirmImportLabel", () => {
  it("沒錯誤列：確認匯入 V 筆", () => {
    expect(confirmImportLabel({ valid: 4, errors: [] })).toBe("確認匯入 4 筆");
  });

  it("有錯誤列：略過錯誤列，匯入 V 筆", () => {
    expect(confirmImportLabel({ valid: 4, errors: [{ line: 2, message: "x" }] })).toBe("略過錯誤列，匯入 4 筆");
  });

  it("V=0 時仍是「確認匯入 0 筆」（由呼叫端 disabled）", () => {
    expect(confirmImportLabel({ valid: 0, errors: [{ line: 2, message: "x" }] })).toBe("確認匯入 0 筆");
  });
});

describe("importDoneMessage", () => {
  it("用 imported 為主，沒有就退回 valid", () => {
    expect(importDoneMessage({ valid: 3, imported: 3, errors: [] })).toBe("已匯入 3 筆");
    expect(importDoneMessage({ valid: 2, errors: [] })).toBe("已匯入 2 筆");
  });

  it("有錯誤列時補上略過筆數", () => {
    expect(importDoneMessage({ valid: 1, imported: 1, errors: [{ line: 3, message: "x" }] })).toBe("已匯入 1 筆，略過 1 筆錯誤列");
  });
});

describe("validateImportFile", () => {
  it("非 .xlsx 擋下（副檔名不分大小寫）", () => {
    expect(validateImportFile({ name: "a.csv", size: 10 })).toBe("只接受 .xlsx 檔");
    expect(validateImportFile({ name: "A.XLSX", size: 10 })).toBeNull();
  });

  it("超過 4MB 擋下", () => {
    expect(validateImportFile({ name: "a.xlsx", size: IMPORT_MAX_BYTES + 1 })).toBe("檔案超過 4MB");
    expect(validateImportFile({ name: "a.xlsx", size: IMPORT_MAX_BYTES })).toBeNull();
  });
});

describe("importErrorMessage", () => {
  it("已知錯誤碼轉中文（從 message 的 [status] code 解析）", () => {
    expect(importErrorMessage(new Error("[400] invalid_header"))).toBe("表頭對不上範本，請重新下載範本填寫");
    expect(importErrorMessage(new Error("[400] unsupported_file"))).toBe("只接受 .xlsx 檔");
    expect(importErrorMessage(new Error("[413] file_too_large"))).toBe("檔案超過 4MB");
  });

  it("有 code／detail 屬性時優先用 code，並把 detail 括在後面", () => {
    const err = Object.assign(new Error("[400] invalid_header"), { code: "invalid_header", detail: "缺少欄位：工號" });
    expect(importErrorMessage(err)).toBe("表頭對不上範本，請重新下載範本填寫（缺少欄位：工號）");
  });

  it("不認識的錯誤顯示原訊息；不是 Error 用 fallback", () => {
    expect(importErrorMessage(new Error("[500] boom"))).toBe("[500] boom");
    expect(importErrorMessage("x")).toBe("匯入失敗");
    expect(importErrorMessage(null, "上傳失敗")).toBe("上傳失敗");
  });
});

describe("isBulkInviteResult", () => {
  it("有 rows 陣列與計數才算", () => {
    expect(isBulkInviteResult({ created: 1, bound: 0, invited: 1, sent: 1, skipped: 0, dryRun: false, errors: [], rows: [] })).toBe(true);
    expect(isBulkInviteResult({ year: 2026, generated: 10, imported: 3, skipped: 0 })).toBe(false);
    expect(isBulkInviteResult(undefined)).toBe(false);
  });
});

describe("IMPORT_KINDS", () => {
  it("六種 kind 都有中文名、欄位與提示，欄位順序照契約", () => {
    expect(IMPORT_KIND_LIST).toEqual(["punches", "schedules", "salary-adjustments", "onboardings", "employees", "holidays"]);
    for (const kind of IMPORT_KIND_LIST) {
      expect(IMPORT_KINDS[kind].label).not.toBe("");
      expect(IMPORT_KINDS[kind].columns.length).toBeGreaterThan(0);
      expect(IMPORT_KINDS[kind].note).not.toBe("");
    }
    expect(IMPORT_KINDS.punches.columns).toEqual(["工號", "姓名", "日期", "時間", "類型"]);
    expect(IMPORT_KINDS.employees.columns).toEqual(["姓名", "Email", "工號", "部門", "僱用類型", "到職日", "角色"]);
    expect(IMPORT_KINDS.holidays.columns).toEqual(["日期", "名稱"]);
  });

  it("範本檔名是「匯入範本-{label}.xlsx」", () => {
    expect(templateFileName("批次補登")).toBe("匯入範本-批次補登.xlsx");
  });
});
