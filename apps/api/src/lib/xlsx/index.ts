/**
 * Barrel for apps/api's xlsx generators. `buildAttendanceWorkbook` /
 * `workbookToBuffer` are the 出勤統計表 exporter (routes/exports.ts); the three
 * small utilities are generic enough that P3's 年度總表 exporter should import
 * them from here too instead of redefining them.
 */
export {
  buildAttendanceWorkbook,
  workbookToBuffer,
  toRocYear,
  minutesToHours,
  applyHeaderStyle,
  SHEET_STATUS_LABELS,
  type BuildAttendanceWorkbookOptions,
} from "./attendance-sheet.js"
