/**
 * 批次匯入（Excel 範本）的六種 kind：純資料，給 BatchImport 面板底部的「範本欄位一覽」用。
 *
 * 欄位順序必須與 API 端產生的範本表頭一致（共同契約 batch-import-contract.md 的表格）；
 * 前後端各放一份，改欄位時兩邊一起改。
 */

export type ImportKind = "punches" | "schedules" | "salary-adjustments" | "onboardings" | "employees" | "holidays";

export interface ImportKindMeta {
  /** 中文名（範本檔名、面板標題用）。 */
  label: string;
  /** 範本「資料」工作表第 1 列的表頭，依序。 */
  columns: string[];
  /** 面板底部的一句填寫提示。 */
  note: string;
}

export const IMPORT_KINDS: Record<ImportKind, ImportKindMeta> = {
  punches: {
    label: "批次打卡補登",
    columns: ["工號", "姓名", "日期", "時間", "類型"],
    note: "類型填「上班／下班／休息開始／休息結束／外出開始／外出結束」；日期 YYYY-MM-DD、時間 HH:mm（公司所在時區）；工號空白時以姓名比對。",
  },
  schedules: {
    label: "批次排班",
    columns: ["工號", "姓名", "日期", "班別", "狀態"],
    note: "班別填班別名稱（範本附「班別清單」），空白＝休假；狀態選填，預設待確認。同一員工同一天重複上傳會覆蓋。",
  },
  "salary-adjustments": {
    label: "批次調薪",
    columns: ["工號", "姓名", "生效日", "新薪資", "原因"],
    note: "生效日 YYYY-MM-DD；新薪資填數字（月薪）。",
  },
  onboardings: {
    label: "批次報到",
    columns: ["姓名", "報到日", "身分別", "地區", "僱用類型", "部門", "主管工號"],
    note: "僱用類型填「正職／兼職／約聘／實習」；部門填部門名稱（範本附「部門清單」）。",
  },
  employees: {
    label: "批次建立帳號",
    columns: ["姓名", "Email", "工號", "部門", "僱用類型", "到職日", "角色"],
    note: "只有姓名與 Email 必填；角色填「一般員工／主管／HR 管理員」，預設一般員工。工號或姓名對得上尚未開通帳號的既有員工會直接綁定，同名多人請補工號。",
  },
  holidays: {
    label: "假日清單",
    columns: ["日期", "名稱"],
    note: "所有日期須同一年（年份由資料決定），會連同週末例假一併產生該年行事曆；手動設定過的日期不動，先前匯入的假日會更新。",
  },
};

export const IMPORT_KIND_LIST = Object.keys(IMPORT_KINDS) as ImportKind[];
