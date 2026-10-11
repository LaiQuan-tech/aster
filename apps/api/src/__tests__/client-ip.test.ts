import { describe, expect, it } from "vitest"
import { clientIpOf, IP_ADDRESS_MAX_LEN } from "../lib/client-ip.js"

/**
 * lib/client-ip.ts：打卡 IP 的取法與驗證（純函式，不連 DB）。
 * ⚠️ 位址一律用文件保留段：IPv4 203.0.113.0/24、198.51.100.0/24，IPv6 2001:db8::/32。
 */
const withHeaders = (headers: Record<string, string | string[]>, ip?: string) => ({ headers, ip })

describe("clientIpOf — x-forwarded-for 第一段", () => {
  it("多段只取第一段，前後空白先 trim", () => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "203.0.113.7, 198.51.100.1, 198.51.100.2" }))).toBe("203.0.113.7")
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "  203.0.113.7  ,198.51.100.1" }))).toBe("203.0.113.7")
  })

  it("單一位址原樣收下", () => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7")
  })

  it("IPv6：單一位址與多段第一段", () => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1")
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "2001:db8:85a3::8a2e:370:7334, 203.0.113.9" }))).toBe("2001:db8:85a3::8a2e:370:7334")
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "::1" }))).toBe("::1")
  })

  it("header 值若是陣列，取第一個元素的第一段", () => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": ["203.0.113.7, 198.51.100.1", "198.51.100.2"] }))).toBe("203.0.113.7")
  })
})

describe("clientIpOf — 來源順序", () => {
  it("x-forwarded-for > x-real-ip > req.ip", () => {
    expect(
      clientIpOf(withHeaders({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.8" }, "203.0.113.9")),
    ).toBe("203.0.113.7")
    expect(clientIpOf(withHeaders({ "x-real-ip": "203.0.113.8" }, "203.0.113.9"))).toBe("203.0.113.8")
    expect(clientIpOf(withHeaders({}, "203.0.113.9"))).toBe("203.0.113.9")
  })

  it("x-forwarded-for 沒值（缺、空白、第一段是空的）才往下一個來源找", () => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "   ", "x-real-ip": "203.0.113.8" }))).toBe("203.0.113.8")
    expect(clientIpOf(withHeaders({ "x-forwarded-for": ", 198.51.100.1" }, "203.0.113.9"))).toBe("203.0.113.9")
    expect(clientIpOf(withHeaders({ "x-real-ip": " " }, "203.0.113.9"))).toBe("203.0.113.9")
  })

  it("全都沒有 → null", () => {
    expect(clientIpOf(withHeaders({}))).toBeNull()
    expect(clientIpOf(withHeaders({}, "  "))).toBeNull()
  })
})

describe("clientIpOf — 驗格式：不是 IPv4／IPv6 一律 null", () => {
  it.each([
    ["亂寫的字串", "not-an-ip"],
    ["unknown（某些 proxy 會塞）", "unknown"],
    ["IPv4 欄位超出範圍", "999.999.999.999"],
    ["IPv4 少一段", "203.0.113"],
    ["IPv4 帶連接埠", "203.0.113.7:8080"],
    ["IPv6 帶括號與連接埠", "[2001:db8::1]:443"],
    ["IPv6 多一組", "2001:db8:1:2:3:4:5:6:7"],
    ["SQL 字樣", "'; drop table punch_records;--"],
    ["含空白的雙位址", "203.0.113.7 198.51.100.1"],
    ["中文", "公司內網"],
  ])("%s → null", (_label, value) => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": value }))).toBeNull()
    expect(clientIpOf(withHeaders({ "x-real-ip": value }))).toBeNull()
    expect(clientIpOf(withHeaders({}, value))).toBeNull()
  })

  it("選定的來源不合法就是 null，不會退到後面看似合法的來源", () => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "garbage", "x-real-ip": "203.0.113.8" }, "203.0.113.9"))).toBeNull()
    expect(clientIpOf(withHeaders({ "x-real-ip": "garbage" }, "203.0.113.9"))).toBeNull()
  })

  it(`長度上限 ${IP_ADDRESS_MAX_LEN}：剛好 ${IP_ADDRESS_MAX_LEN} 字的合法位址可存，多 1 字 → null（不截斷）`, () => {
    // IPv6 的 zone id 可以任意長，拿來湊長度邊界。
    const atLimit = `fe80::1%${"a".repeat(IP_ADDRESS_MAX_LEN - "fe80::1%".length)}`
    expect(atLimit).toHaveLength(IP_ADDRESS_MAX_LEN)
    expect(clientIpOf(withHeaders({ "x-forwarded-for": atLimit }))).toBe(atLimit)

    const overLimit = `${atLimit}a`
    expect(clientIpOf(withHeaders({ "x-forwarded-for": overLimit }))).toBeNull()
  })

  it("超長的垃圾 header 不會被存下來", () => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "9".repeat(10_000) }))).toBeNull()
  })
})

describe("clientIpOf — IPv4-mapped IPv6 還原成 IPv4", () => {
  it("::ffff:a.b.c.d（不分大小寫）→ a.b.c.d，不論來源", () => {
    expect(clientIpOf(withHeaders({ "x-forwarded-for": "::ffff:203.0.113.5" }))).toBe("203.0.113.5")
    expect(clientIpOf(withHeaders({ "x-real-ip": "::FFFF:203.0.113.5" }))).toBe("203.0.113.5")
    expect(clientIpOf(withHeaders({}, "::ffff:203.0.113.5"))).toBe("203.0.113.5")
  })

  it("其他 IPv6 一律原樣", () => {
    expect(clientIpOf(withHeaders({}, "2001:db8::ffff:cb00:7105"))).toBe("2001:db8::ffff:cb00:7105")
    expect(clientIpOf(withHeaders({}, "::ffff:cb00:7105"))).toBe("::ffff:cb00:7105")
  })
})
