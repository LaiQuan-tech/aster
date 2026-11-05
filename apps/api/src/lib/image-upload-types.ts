/**
 * 影像上傳白名單（2026-11-05，公務車車況照片起）。比照 routes/project-documents.ts 的 CONTRACT_SCAN_*，去掉 PDF。
 * MIME 與副檔名**兩個都要在名單內**（各自獨立檢查、不要求互相對應：iOS Safari 會把 HEIC 轉成 JPEG 卻保留 .HEIC 檔名）。
 * 純函式、不 import 任何東西。
 */

export const IMAGE_CONTENT_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"]
export const IMAGE_EXTENSIONS: readonly string[] = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"]

/** `image/PNG; charset=binary` → `image/png`。 */
export function normalizeImageContentType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

/** 小寫副檔名（含點）；沒有副檔名回 ""。 */
export function imageExtOf(fileName: string): string {
  return (fileName.match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase()
}

/** 是否為允許的影像：副檔名與 MIME 都要在名單內。 */
export function isAllowedImage(fileName: string, contentType: string | null | undefined): boolean {
  return IMAGE_EXTENSIONS.includes(imageExtOf(fileName)) && IMAGE_CONTENT_TYPES.includes(normalizeImageContentType(contentType))
}
