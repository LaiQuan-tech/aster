import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

describe("primary contract Drizzle migration registration", () => {
  it("registers migration 0053 in the journal and includes deterministic legacy adoption", () => {
    const root = resolve(import.meta.dirname, "..")
    const journal = JSON.parse(readFileSync(resolve(root, "migrations/meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>
    }
    expect(journal.entries).toContainEqual(expect.objectContaining({ idx: 53, tag: "0053_project_primary_contract" }))

    const migration = readFileSync(resolve(root, "migrations/0053_project_primary_contract.sql"), "utf8")
    expect(migration).toContain("contracts_active_primary_uq")
    expect(migration).toContain("supersedes_id")
    expect(migration).toContain("HAVING count(*) = 1")
  })
})
