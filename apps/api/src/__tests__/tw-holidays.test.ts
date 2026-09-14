import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, it, expect } from "vitest"
import { TW_HOLIDAYS } from "../lib/tw-holidays.js"

/**
 * Drift guard: the API's holiday constant must stay byte-for-byte equal to the
 * canonical seed (packages/db/seed/tw-holidays-2026.json) and to the typed copy
 * exported by @hr/db (packages/db/src/seed/tw-holidays.ts). The db package has
 * no build output, so the API cannot import it — this test is what keeps the
 * three in lock-step.
 */
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../../../..")

describe("TW_HOLIDAYS drift guard", () => {
  it("API copy === packages/db/seed/tw-holidays-2026.json", () => {
    const json = JSON.parse(readFileSync(resolve(ROOT, "packages/db/seed/tw-holidays-2026.json"), "utf8")) as {
      holidays: Array<{ date: string; label: string; type?: string }>
    }
    expect(TW_HOLIDAYS[2026]).toEqual(json.holidays)
  })

  it("API copy === @hr/db TW_HOLIDAYS (packages/db/src/seed/tw-holidays.ts)", async () => {
    // Dynamic import with a runtime path so apps/api's tsc (rootDir=src) does
    // not try to compile the db package's source.
    const dbSeed = (await import(
      /* @vite-ignore */ pathToFileURL(resolve(ROOT, "packages/db/src/seed/tw-holidays.ts")).href
    )) as { TW_HOLIDAYS: typeof TW_HOLIDAYS }
    expect(TW_HOLIDAYS).toEqual(dbSeed.TW_HOLIDAYS)
  })

  it("2026 has 21 entries, all valid YYYY-MM-DD of 2026, unique, sorted", () => {
    const list = TW_HOLIDAYS[2026]
    expect(list).toHaveLength(21)
    const dates = list.map((h) => h.date)
    expect(new Set(dates).size).toBe(dates.length)
    expect([...dates].sort()).toEqual(dates)
    for (const d of dates) expect(d).toMatch(/^2026-\d{2}-\d{2}$/)
    expect(dates).toContain("2026-06-19") // 端午節 — used by the 115-06 fixtures
  })
})
