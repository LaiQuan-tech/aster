import { describe, it, expect } from "vitest"
import {
  SNAPSHOT_RETENTION_MONTHS,
  SNAPSHOT_ROWS_MAX_LIMIT,
  manifestPathOf,
  planRowSlice,
  runFolder,
} from "../services/backup-snapshot"

/**
 * W7／M9 的純函式部分：run 資料夾命名、manifest 路徑、以及「備份內容瀏覽」
 * 的分頁切片規劃（planRowSlice）。打 Storage 的部分在 backups-live.test.ts。
 *
 * planRowSlice 的職責：大表在快照裡被拆成 part-0001…，每個檔在 manifest 裡都
 * 記了自己有幾列；要翻「第 offset 列起的 limit 列」時，靠逐檔累加列數就能算出
 * 只需要下載哪幾個檔、各跳過幾列、各取幾列——不必把整張表抓下來。
 */

const TENANT = "11111111-2222-3333-4444-555555555555"

/** 三個分頁檔：1000 + 1000 + 250 ＝ 2250 列。 */
const FILES = [
  { path: "audit_logs.part-0001.json.gz", rows: 1000 },
  { path: "audit_logs.part-0002.json.gz", rows: 1000 },
  { path: "audit_logs.part-0003.json.gz", rows: 250 },
]

describe("backup run 路徑（W7：同月不覆蓋）", () => {
  it("runFolder 補滿三位數", () => {
    expect(runFolder(1)).toBe("r001")
    expect(runFolder(12)).toBe("r012")
    expect(runFolder(999)).toBe("r999")
  })

  it("manifestPathOf：run ≥ 1 走 r 資料夾，run 0 ＝ 舊版（直接在 period 底下）", () => {
    expect(manifestPathOf(TENANT, "2026-09", 1)).toBe(`${TENANT}/2026-09/r001/manifest.json`)
    expect(manifestPathOf(TENANT, "2026-09", 2)).toBe(`${TENANT}/2026-09/r002/manifest.json`)
    expect(manifestPathOf(TENANT, "2026-09", 0)).toBe(`${TENANT}/2026-09/manifest.json`)
  })

  it("保留月數＝84（7 年，客戶要求 5–7 年）", () => {
    expect(SNAPSHOT_RETENTION_MONTHS).toBe(84)
  })
})

describe("planRowSlice（M9 備份內容瀏覽的分頁）", () => {
  it("單檔內的一頁：只下載第一個檔", () => {
    const plan = planRowSlice(FILES, 0, 50)
    expect(plan.total).toBe(2250)
    expect(plan.picks).toEqual([{ path: "audit_logs.part-0001.json.gz", skip: 0, take: 50 }])
    expect(plan.nextOffset).toBe(50)
  })

  it("offset 落在第二個檔：跳過前面的檔，skip 是檔內位移", () => {
    const plan = planRowSlice(FILES, 1200, 50)
    expect(plan.picks).toEqual([{ path: "audit_logs.part-0002.json.gz", skip: 200, take: 50 }])
    expect(plan.nextOffset).toBe(1250)
  })

  it("跨檔的一頁：拆成兩段，加起來剛好 limit 列", () => {
    const plan = planRowSlice(FILES, 980, 50)
    expect(plan.picks).toEqual([
      { path: "audit_logs.part-0001.json.gz", skip: 980, take: 20 },
      { path: "audit_logs.part-0002.json.gz", skip: 0, take: 30 },
    ])
    expect(plan.picks.reduce((s, p) => s + p.take, 0)).toBe(50)
    expect(plan.nextOffset).toBe(1030)
  })

  it("最後一頁：只拿得到剩下的列，nextOffset 為 null", () => {
    const plan = planRowSlice(FILES, 2230, 50)
    expect(plan.picks).toEqual([{ path: "audit_logs.part-0003.json.gz", skip: 230, take: 20 }])
    expect(plan.nextOffset).toBeNull()
  })

  it("offset 超出總列數 → 空頁（不是錯誤）", () => {
    const plan = planRowSlice(FILES, 9999, 50)
    expect(plan.picks).toEqual([])
    expect(plan.total).toBe(2250)
    expect(plan.nextOffset).toBeNull()
  })

  it("limit 大於整張表 → 三個檔全拿，且不會多算", () => {
    const plan = planRowSlice(FILES, 0, SNAPSHOT_ROWS_MAX_LIMIT * 100)
    expect(plan.picks.map((p) => p.path)).toEqual(FILES.map((f) => f.path))
    expect(plan.picks.reduce((s, p) => s + p.take, 0)).toBe(2250)
    expect(plan.nextOffset).toBeNull()
  })

  it("單一檔的表（沒分頁）與空表", () => {
    const single = planRowSlice([{ path: "employees.json.gz", rows: 21 }], 10, 50)
    expect(single.picks).toEqual([{ path: "employees.json.gz", skip: 10, take: 11 }])
    expect(single.nextOffset).toBeNull()

    const empty = planRowSlice([], 0, 50)
    expect(empty).toEqual({ picks: [], total: 0, nextOffset: null })
  })

  it("逐頁翻完整張表：每一列剛好被拿到一次、順序不亂", () => {
    const seen: string[] = []
    let offset: number | null = 0
    let guard = 0
    while (offset !== null) {
      const plan: ReturnType<typeof planRowSlice> = planRowSlice(FILES, offset, 200)
      for (const pick of plan.picks) {
        for (let i = 0; i < pick.take; i += 1) seen.push(`${pick.path}#${pick.skip + i}`)
      }
      offset = plan.nextOffset
      expect((guard += 1)).toBeLessThan(100)
    }
    expect(seen).toHaveLength(2250)
    expect(new Set(seen).size).toBe(2250)
    expect(seen[0]).toBe("audit_logs.part-0001.json.gz#0")
    expect(seen.at(-1)).toBe("audit_logs.part-0003.json.gz#249")
  })
})
