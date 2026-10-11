import { isIP } from "node:net"
import type { IncomingHttpHeaders } from "node:http"

/** punch_records.ip_address 的長度上限。超過視為不合法——截斷只會變成另一個位址。 */
export const IP_ADDRESS_MAX_LEN = 64

/** IPv4-mapped IPv6（雙堆疊 socket 上 IPv4 用戶端的樣子）：::ffff:a.b.c.d */
const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * 從請求解出用戶端 IP，打卡時存進 punch_records.ip_address。
 *
 * 來源順序（取第一個「有值」的）：
 *   1. x-forwarded-for 的第一段（逗號分隔、trim）——Vercel 由平台設定，第一段就是用戶端 IP；
 *   2. x-real-ip；
 *   3. req.ip（socket 對端；本機直連開發時才會走到）。
 * 選定來源之後驗格式：只收 IPv4／IPv6，其餘（亂塞的字串、帶連接埠、超過 64 字）一律回 null，
 * **不會**退到下一個來源——寧可記「不明」，也不要記成一個看似合法、其實不是用戶端的位址。
 * IPv4-mapped IPv6（::ffff:203.0.113.5）還原成 IPv4，同一個用戶端不會因為走哪個來源而看起來是兩個位址。
 *
 * ⚠️ 信任前提：x-forwarded-for 由前面的平台（Vercel）覆寫，用戶端塞的值進不來。
 * 若改部署到不覆寫它的環境，用戶端可以自己填第一段——到時要改成「只信任最後幾層 proxy」的取法。
 */
export function clientIpOf(req: { headers: IncomingHttpHeaders; ip?: string | undefined }): string | null {
  const forwarded = firstValue(req.headers["x-forwarded-for"])?.split(",")[0]?.trim()
  const real = firstValue(req.headers["x-real-ip"])?.trim()
  const raw = forwarded || real || req.ip?.trim()
  if (!raw || raw.length > IP_ADDRESS_MAX_LEN || isIP(raw) === 0) return null
  const mapped = MAPPED_IPV4.exec(raw)?.[1]
  return mapped && isIP(mapped) === 4 ? mapped : raw
}
