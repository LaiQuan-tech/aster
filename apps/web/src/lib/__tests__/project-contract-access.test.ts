import { describe, expect, it, vi } from "vitest"
import * as projectsApi from "../projects-ext-api"
import type { CreateProjectExtBody } from "../projects-ext-api"

const creationWithBillings: CreateProjectExtBody = {
  name: "含期程專案",
  contractAmount: 1_000_000,
  billings: [{ installmentNo: 1, percentage: 100, kind: "installment" }],
}

describe("loadContractsForProjectAccess", () => {
  it("exposes billings on the typed project creation payload", () => {
    expect(creationWithBillings.billings).toHaveLength(1)
  })
  it("does not issue a contract request for non-finance project access", async () => {
    const loader = vi.fn(async () => ({ contracts: [{ id: "secret" }] }))
    const helper = (projectsApi as unknown as {
      loadContractsForProjectAccess?: (finance: boolean, loader: () => Promise<{ contracts: unknown[] }>) => Promise<unknown[]>
    }).loadContractsForProjectAccess
    expect(helper).toBeTypeOf("function")
    await expect(helper!(false, loader)).resolves.toEqual([])
    expect(loader).not.toHaveBeenCalled()
  })
})
