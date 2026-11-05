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

/** 嚴格 base64（標準字母表、長度 4 的倍數、結尾最多兩個 =；不收空白與 data: 前綴）。 */
export function isStrictBase64(text: string): boolean {
  return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text)
}

const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]

/** 依檔頭判斷影像格式（jpeg／png／webp／heic）；不是這幾種回 null。 */
export function sniffImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "image/heic" | null {
  const b = bytes
  const ascii = (from: number, to: number) => String.fromCharCode(...Array.from(b.subarray(from, to)))
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "image/png"
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && HEIF_BRANDS.includes(ascii(8, 12))) return "image/heic"
  return null
}
