import { describe, it, expect } from "vitest"
import request from "supertest"
import { app } from "../app"

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health")
    expect(res.status).toBe(200)
    expect(res.body.status).toBe("ok")
  })
})

describe("班表端點已移除（2026-10-11，業主：不需要）", () => {
  it.each([
    ["GET", "/schedules"],
    ["GET", "/schedules?scope=mine"],
    ["POST", "/schedules"],
    ["POST", "/schedules/import"],
    ["POST", "/schedules/x/acknowledge"],
    ["POST", "/schedules/x/dispute"],
  ] as const)("%s %s → 404 not_found（路由已取消註冊）", async (method, path) => {
    const res = method === "GET" ? await request(app).get(path) : await request(app).post(path).send({})
    expect(res.status).toBe(404)
    expect(res.body.error).toBe("not_found")
  })
})
