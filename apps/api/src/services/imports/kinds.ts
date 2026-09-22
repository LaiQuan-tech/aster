/**
 * 批次匯入（Excel 範本下載 → 填寫 → 上傳）的 6 種 kind 定義。
 *
 * 這份是 API 端的欄位表；web 端 `apps/web/src/lib/import-kinds.ts` 放一份同樣
 * 的常數（前後端各自維護，跟 PayslipBreakdown 一樣的慣例——@hr/web 沒有依賴
 * @hr/rules）。改表頭、必填、允許值時兩邊要一起改。
 *
 * 規則（與 scratchpad 的 batch-import-contract.md 一致）：
 *   • 工作表「資料」第 1 列＝表頭（columns[].header 依序）、第 2 列起＝範例列
 *     （examples，灰字；上傳前請刪除，沒刪的列會被略過並回報）。
 *   • 表頭比對「去空白、全半形統一」後的中文表頭，也接受英文 key（services/imports/parse.ts）。
 *   • 日期欄在範本裡是文字格式 YYYY-MM-DD，但 Excel 的日期／時間儲存格也接受。
 */

export const IMPORT_KINDS = [
  "punches",
  "schedules",
  "salary-adjustments",
  "onboardings",
  "employees",
  "holidays",
] as const

export type ImportKind = (typeof IMPORT_KINDS)[number]

export function isImportKind(value: string): value is ImportKind {
  return (IMPORT_KINDS as readonly string[]).includes(value)
}

export interface ImportColumn {
  /** 英文 key（表頭也接受這個字串）；也是 parse 回傳 values 的 key。 */
  key: string
  /** 中文表頭（範本第 1 列）。 */
  header: string
  required: boolean
  /** 說明工作表的「說明」欄：格式、允許值、注意事項。 */
  hint: string
  /** 第一筆範例列的值（web 面板底部「欄位一覽」用）。 */
  example: string
  /** 允許值（有的話範本加下拉選單、說明列出）。 */
  options?: string[]
  /** 範本欄寬（字元數）。 */
  width?: number
}

/** 範本另附的參考工作表：從 DB 撈，只列在職／現有資料。 */
export type ImportExtraSheet = "employees" | "shifts" | "departments"

export interface ImportKindDef {
  kind: ImportKind
  /** 中文名（檔名 `匯入範本-<label>.xlsx`、說明標題）。 */
  label: string
  /** 一句話說明這份範本做什麼（說明工作表第 2 列）。 */
  description: string
  columns: ImportColumn[]
  /** 範例列（依 columns 順序），1～2 筆。 */
  examples: string[][]
  extraSheets: ImportExtraSheet[]
  /** 說明工作表「注意事項」。 */
  notes: string[]
}

/* ── 各種允許值與中英對照（run.ts 也用） ───────────────────────────── */

export const PUNCH_TYPE_LABELS: Record<string, string> = {
  in: "上班",
  out: "下班",
  break_in: "休息開始",
  break_out: "休息結束",
  outing_in: "外出開始",
  outing_out: "外出結束",
}

export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  regular: "正職",
  parttime: "兼職",
  contract: "約聘",
  intern: "實習",
  dispatched: "派遣",
}

export const ROLE_LABELS: Record<string, string> = {
  employee: "一般員工",
  manager: "主管",
  hr_admin: "HR 管理員",
}

export const SCHEDULE_STATUS_LABELS: Record<string, string> = {
  scheduled: "待確認",
  confirmed: "已確認",
  day_off: "休假",
  disputed: "有爭議",
}

const EMP_NO_HINT = "員工的工號（見「員工清單」工作表）。工號與姓名至少填一個；工號空白時用姓名比對，同名者必須填工號。"
const NAME_HINT = "員工姓名（見「員工清單」）。填了工號時姓名只做核對，不符會回報錯誤。"
const DATE_HINT = "格式 YYYY-MM-DD（例 2026-09-15）；Excel 的日期格式儲存格也可以。"

export const IMPORT_KIND_DEFS: Record<ImportKind, ImportKindDef> = {
  punches: {
    kind: "punches",
    label: "批次打卡補登",
    description: "替員工補登打卡紀錄（來源會標記為「手動補登」）。一列一筆打卡。",
    columns: [
      { key: "empNo", header: "工號", required: false, hint: EMP_NO_HINT, example: "A001", width: 12 },
      { key: "name", header: "姓名", required: false, hint: NAME_HINT, example: "王小明", width: 14 },
      { key: "date", header: "日期", required: true, hint: DATE_HINT, example: "2026-09-15", width: 14 },
      {
        key: "time",
        header: "時間",
        required: true,
        hint: "24 小時制 HH:MM（例 09:00、18:30），以公司所在時區為準；Excel 的時間格式儲存格也可以。",
        example: "09:00",
        width: 10,
      },
      {
        key: "type",
        header: "類型",
        required: true,
        hint: "上班／下班／休息開始／休息結束／外出開始／外出結束（也接受 in/out/break_in/break_out/outing_in/outing_out）。",
        example: "上班",
        options: Object.values(PUNCH_TYPE_LABELS),
        width: 12,
      },
    ],
    examples: [
      ["A001", "王小明", "2026-09-15", "09:00", "上班"],
      ["A001", "王小明", "2026-09-15", "18:00", "下班"],
    ],
    extraSheets: ["employees"],
    notes: [
      "同一位員工同一天有上班也有下班，就填兩列。",
      "時間以公司設定的時區解讀（預設台北時間），寫入時自動轉成系統時間。",
      "已停用的員工也能補登（例如補離職前的紀錄）。",
    ],
  },
  schedules: {
    kind: "schedules",
    label: "批次排班",
    description: "替員工指定某一天的班別。同一位員工同一天已有排班時會被這次的內容覆蓋。",
    columns: [
      { key: "empNo", header: "工號", required: false, hint: EMP_NO_HINT, example: "A001", width: 12 },
      { key: "name", header: "姓名", required: false, hint: NAME_HINT, example: "王小明", width: 14 },
      { key: "date", header: "日期", required: true, hint: DATE_HINT, example: "2026-10-01", width: 14 },
      {
        key: "shift",
        header: "班別",
        required: false,
        hint: "班別名稱（見「班別清單」）。留空＝不排班別（通常搭配狀態「休假」）。",
        example: "早班",
        width: 14,
      },
      {
        key: "status",
        header: "狀態",
        required: false,
        hint: "待確認／已確認／休假（也接受 scheduled/confirmed/day_off）。留空＝待確認。",
        example: "待確認",
        options: ["待確認", "已確認", "休假"],
        width: 10,
      },
    ],
    examples: [
      ["A001", "王小明", "2026-10-01", "早班", "待確認"],
      ["A001", "王小明", "2026-10-02", "", "休假"],
    ],
    extraSheets: ["employees", "shifts"],
    notes: ["同一個檔案裡同一位員工同一天只能出現一次。", "排班後員工可在 ESS 端確認或提出異議。"],
  },
  "salary-adjustments": {
    kind: "salary-adjustments",
    label: "批次調薪",
    description: "登記員工的調薪紀錄（新薪資與生效日）。",
    columns: [
      { key: "empNo", header: "工號", required: false, hint: EMP_NO_HINT, example: "A001", width: 12 },
      { key: "name", header: "姓名", required: false, hint: NAME_HINT, example: "王小明", width: 14 },
      { key: "effectiveDate", header: "生效日", required: true, hint: DATE_HINT, example: "2026-11-01", width: 14 },
      {
        key: "newSalary",
        header: "新薪資",
        required: true,
        hint: "整數或小數，不可為負（例 45000）。可含千分位逗號。",
        example: "45000",
        width: 12,
      },
      { key: "reason", header: "原因", required: false, hint: "調薪原因，自由文字，可留空。", example: "年度調薪", width: 24 },
    ],
    examples: [
      ["A001", "王小明", "2026-11-01", "45000", "年度調薪"],
      ["A002", "李小華", "2026-11-01", "52000", "晉升"],
    ],
    extraSheets: ["employees"],
    notes: ["同一位員工同一個生效日在同一個檔案裡只能出現一次。", "這裡只登記調薪紀錄，薪資結構的本薪請另外在薪資設定更新。"],
  },
  onboardings: {
    kind: "onboardings",
    label: "批次報到",
    description: "建立待報到人員（狀態為「未報到」），之後在報到管理完成報到即轉成員工。",
    columns: [
      { key: "name", header: "姓名", required: true, hint: "報到人員姓名。", example: "陳新人", width: 14 },
      { key: "reportDate", header: "報到日", required: false, hint: DATE_HINT, example: "2026-10-01", width: 14 },
      { key: "identityType", header: "身分別", required: false, hint: "自由文字（例 本國籍、外籍）。", example: "本國籍", width: 12 },
      { key: "region", header: "地區", required: false, hint: "自由文字（例 台北、台中）。", example: "台北", width: 10 },
      {
        key: "employmentType",
        header: "僱用類型",
        required: false,
        hint: "正職／兼職／約聘／實習／派遣（也接受 regular/parttime/contract/intern/dispatched）。留空＝正職。",
        example: "正職",
        options: Object.values(EMPLOYMENT_TYPE_LABELS),
        width: 10,
      },
      { key: "deptName", header: "部門", required: false, hint: "部門名稱（見「部門清單」），須完全一致；留空＝未指定。", example: "業務部", width: 14 },
      { key: "managerEmpNo", header: "主管工號", required: false, hint: "直屬主管的工號（見「員工清單」）；留空＝未指定。", example: "A001", width: 12 },
    ],
    examples: [
      ["陳新人", "2026-10-01", "本國籍", "台北", "正職", "業務部", "A001"],
      ["林實習", "2026-10-15", "本國籍", "台中", "實習", "", ""],
    ],
    extraSheets: ["departments", "employees"],
    notes: ["這裡只建立報到名單，不會建立登入帳號；完成報到時才會建立員工資料。"],
  },
  employees: {
    kind: "employees",
    label: "批次建立帳號",
    description: "批次建立員工登入帳號並寄出邀請信；已有員工資料但尚未有帳號者，會用工號（或唯一的姓名）綁定。",
    columns: [
      { key: "name", header: "姓名", required: true, hint: "員工姓名。", example: "王小明", width: 14 },
      { key: "email", header: "Email", required: true, hint: "登入用的 Email，邀請信會寄到這裡；同一個檔案裡不可重複。", example: "user@example.com", width: 28 },
      { key: "empNo", header: "工號", required: false, hint: "工號。已有員工資料（尚未有帳號）者填工號即可綁定；新員工可留空。", example: "A001", width: 12 },
      { key: "deptName", header: "部門", required: false, hint: "部門名稱（見「部門清單」）；找不到時該欄留空並回報提醒，不影響建立。", example: "業務部", width: 14 },
      {
        key: "employmentType",
        header: "僱用類型",
        required: false,
        hint: "正職／兼職／約聘／實習／派遣（也接受英文代碼）。留空＝正職。",
        example: "正職",
        options: Object.values(EMPLOYMENT_TYPE_LABELS),
        width: 10,
      },
      { key: "hireDate", header: "到職日", required: false, hint: DATE_HINT, example: "2026-10-01", width: 14 },
      {
        key: "role",
        header: "角色",
        required: false,
        hint: "一般員工／主管／HR 管理員（也接受 employee/manager/hr_admin）。留空＝一般員工。",
        example: "一般員工",
        options: Object.values(ROLE_LABELS),
        width: 12,
      },
    ],
    examples: [
      ["王小明", "user@example.com", "A001", "業務部", "正職", "2026-10-01", "一般員工"],
      ["李小華", "user2@example.com", "", "", "兼職", "", "主管"],
    ],
    extraSheets: ["departments", "employees"],
    notes: [
      "已有登入帳號的 Email 會被略過並回報。",
      "邀請信寄到 Email；未設定寄信服務或選擇「不寄信」時，結果表會列出可手動轉交的設定密碼連結。",
    ],
  },
  holidays: {
    kind: "holidays",
    label: "假日清單",
    description: "匯入某一年的國定假日／公司假日（同時把該年週六日標為例假日）。",
    columns: [
      { key: "date", header: "日期", required: true, hint: DATE_HINT + " 全部日期必須同一年。", example: "2026-01-01", width: 14 },
      { key: "label", header: "名稱", required: false, hint: "假日名稱（例 元旦、春節），最多 120 字，可留空。", example: "元旦", width: 20 },
    ],
    examples: [
      ["2026-01-01", "元旦"],
      ["2026-02-28", "和平紀念日"],
    ],
    extraSheets: [],
    notes: [
      "年份由檔案內容決定；一個檔案只能含同一年的日期。",
      "在行事曆手動設定過的日期不會被覆蓋；先前匯入的假日會被更新。",
      "該年所有週六、週日會自動標為例假日（已設定的日期不動）。",
    ],
  },
}

export function templateFileName(kind: ImportKind): string {
  return `匯入範本-${IMPORT_KIND_DEFS[kind].label}.xlsx`
}
