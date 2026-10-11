/**
 * 一般專案文件不收的檔案類型：**執行檔與腳本**（2026-10-11）。
 *
 * 專案文件是全公司都能下載的知識庫工作檔（docx／xlsx／dwg／zip…），不限類型；但執行檔與腳本一旦進來，
 * 全公司任何人點開就可能直接執行，所以擋掉。合約掃描檔另有「只收 PDF 與圖片」的白名單
 * （routes/project-documents.ts 的 CONTRACT_SCAN_*），比這份更窄，不需要再套這份。
 *
 * 判斷看**三樣**，任一個中就擋（各自獨立、不要求互相對應）：
 *   ① 檔名的副檔名（`BLOCKED_DOCUMENT_EXTENSIONS`）——`report.pdf.exe` 看最後一段，結尾多打的點／空白先去掉
 *      （Windows 會自動拿掉，`setup.exe.` 其實就是 `setup.exe`）；
 *   ② 自報的 MIME（`BLOCKED_DOCUMENT_CONTENT_TYPES`）；
 *   ③ 直傳 Storage 之後 Storage 實際記下的 MIME（登記那步由呼叫端一併帶進來）。
 * 這是衛生性的把關（擋掉最常見、一眼看得出來的），不是安全邊界：改名、包進壓縮檔都擋不了。
 *
 * ⚠️ 純函式、不 import 任何東西：web 的 `apps/web/src/lib/projects-api.ts` 各抄了一份同樣的名單（web 與 api 是各自的
 * build 邊界），`apps/web/src/lib/__tests__/project-documents-upload.test.ts` 直接 import 這個檔逐項比對——改任何一邊，
 * 那裡就會紅。
 */

/** 不收的副檔名（小寫、含點）。 */
export const BLOCKED_DOCUMENT_EXTENSIONS: readonly string[] = [
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".msi",
  ".ps1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".jar",
  ".apk",
  ".dmg",
  ".pkg",
  ".sh",
  ".app",
]

/**
 * 不收的 MIME（小寫、不含參數）。刻意**不**列 `application/octet-stream`：那是「不知道是什麼」的通用類型，
 * dwg 之類的工作檔常被瀏覽器標成它。
 */
export const BLOCKED_DOCUMENT_CONTENT_TYPES: readonly string[] = [
  // Windows 執行檔／批次檔／安裝檔
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-dosexec",
  "application/x-ms-dos-executable",
  "application/vnd.microsoft.portable-executable",
  "application/x-bat",
  "application/bat",
  "application/x-msi",
  // Unix／macOS 執行檔與 shell 腳本
  "application/x-executable",
  "application/x-mach-binary",
  "application/x-elf",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-csh",
  "text/x-shellscript",
  "text/x-sh",
  // 腳本
  "application/javascript",
  "application/x-javascript",
  "text/javascript",
  "application/x-vbscript",
  "text/vbscript",
  "application/x-powershell",
  "text/x-powershell",
  // 行動／Java／macOS 安裝包
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/x-apple-diskimage",
]

/** `application/X-SH; charset=binary` → `application/x-sh`。 */
export function normalizeMime(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

/** 小寫副檔名（含點）；沒有副檔名回 ""。先去掉結尾的點與空白（`setup.exe.`、`setup.exe ` 都算 `.exe`）。 */
export function blockedCheckExtOf(fileName: string): string {
  const trimmed = fileName.trim().replace(/[.\s]+$/u, "")
  return (trimmed.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase()
}

/** 這個檔案是不是一般專案文件不收的類型：副檔名在名單內，或任何一個給進來的 MIME 在名單內。 */
export function isBlockedDocument(fileName: string, ...contentTypes: Array<string | null | undefined>): boolean {
  if (BLOCKED_DOCUMENT_EXTENSIONS.includes(blockedCheckExtOf(fileName))) return true
  return contentTypes.some((type) => BLOCKED_DOCUMENT_CONTENT_TYPES.includes(normalizeMime(type)))
}
