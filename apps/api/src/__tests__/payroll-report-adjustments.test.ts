import type { Server } from "node:http"
import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// 純測試：supabase 換成記憶體版（helpers/fake-supabase.ts），不連任何 DB。
vi.mock("../lib/supabase.js", async () => (await import("./helpers/fake-supabase.js")).fakeSupabaseModule())

import { reportsRouter } from "../routes/reports.js"
import { fake, TENANT_ID } from "./helpers/fake-supabase.js"

/**
 * 工資清冊（GET /reports/payroll，含 ?format=csv）要列出一次性加減項（前期更正）的三個欄位——
 * 否則應發合計／應扣合計／實發金額含了補發與扣回、各欄位卻對不起來：
 *   adjustmentEarnings（課稅補發，已含在應發合計）、adjustmentDeductions（扣回，已含在應扣合計）、
 *   adjustmentNonTaxable（不課稅補發，只加在實發）。沒有加減項的薪資單三欄都是 0。
 */

const app = express()
app.use(express.json())
app.use(reportsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

let server: Server
beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s))
  })
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const HR = "a0000000-0000-4000-8000-000000000001"
const E1 = "a0000000-0000-4000-8000-000000000004"
const E2 = "a0000000-0000-4000-8000-000000000005"

beforeEach(() => {
  fake.reset()
  fake.db.employees = [
    { id: HR, tenant_id: TENANT_ID, user_id: "u-hr", role: "hr_admin", name: "人資甲" },
    { id: E1, tenant_id: TENANT_ID, user_id: "u-e1", role: "employee", name: "員工甲" },
    { id: E2, tenant_id: TENANT_ID, user_id: "u-e2", role: "employee", name: "員工乙" },
  ]
  fake.db.payslips = [
    {
      id: "p1",
      tenant_id: TENANT_ID,
      employee_id: E1,
      period: "2026-10",
      base: 40000,
      overtime_pay: 0,
      night_pay: 0,
      attendance_bonus: 0,
      gross: 43000,
      status: "draft",
      breakdown: { allowances: 0, totalDeductions: 2000, expenses: 0, net: 41450, adjustmentEarnings: 3000, adjustmentDeductions: 2000, adjustmentDeductionsTaxable: 1500, adjustmentNonTaxable: 450 },
    },
    {
      id: "p2",
      tenant_id: TENANT_ID,
      employee_id: E2,
      period: "2026-10",
      base: 50000,
      overtime_pay: 0,
      night_pay: 0,
      attendance_bonus: 0,
      gross: 50000,
      status: "draft",
      breakdown: { allowances: 0, totalDeductions: 0, expenses: 0, net: 50000 }, // 舊薪資單／沒有加減項
    },
  ]
})

const get = (path: string) => request(server).get(path).set("Authorization", "Bearer u-hr")

describe("GET /reports/payroll — 加減項欄位", () => {
  it("JSON：每位員工附三個加減項欄位（沒有的是 0）；合計列不受影響", async () => {
    const res = await get("/reports/payroll?period=2026-10")
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const rows = res.body.rows as Array<Record<string, unknown>>
    const e1 = rows.find((r) => r.employeeId === E1)
    const e2 = rows.find((r) => r.employeeId === E2)
    expect(e1).toMatchObject({
      adjustmentEarnings: 3000,
      adjustmentDeductions: 2000,
      adjustmentDeductionsTaxable: 1500, // 追回的是已課稅所得
      adjustmentDeductionsNonTaxable: 500, // 追回的是不課稅的給付
      adjustmentNonTaxable: 450,
      gross: 43000,
      net: 41450,
    })
    expect(e2).toMatchObject({ adjustmentEarnings: 0, adjustmentDeductions: 0, adjustmentDeductionsTaxable: 0, adjustmentDeductionsNonTaxable: 0, adjustmentNonTaxable: 0, gross: 50000, net: 50000 })
    expect(res.body.total).toMatchObject({ gross: 93000, totalDeductions: 2000, net: 91450 })
  })

  it("CSV：三個加減項欄位在對的位置（補發在應發合計前、扣回在應扣合計前、不課稅補發在實發金額前），合計列有加總", async () => {
    const res = await get("/reports/payroll?period=2026-10&format=csv")
    expect(res.status).toBe(200)
    const lines = res.text.replace(/^﻿/, "").trim().split(/\r?\n/)
    const header = lines[0].split(",")
    const idx = (label: string) => header.indexOf(label)
    expect(idx("加減項補發(前期更正)")).toBeGreaterThan(-1)
    expect(idx("加減項補發(前期更正)")).toBeLessThan(idx("應發合計"))
    // 扣回拆成兩欄（追回課稅所得／追回非課稅），年度申報才知道全年應發合計裡有多少是已收回的。
    expect(idx("加減項扣回-追回課稅所得(前期更正)")).toBeGreaterThan(-1)
    expect(idx("加減項扣回-追回課稅所得(前期更正)")).toBeLessThan(idx("應扣合計"))
    expect(idx("加減項扣回-追回非課稅(前期更正)")).toBeLessThan(idx("應扣合計"))
    expect(idx("加減項不課稅補發(前期更正)")).toBeLessThan(idx("實發金額"))
    const total = lines[lines.length - 1].split(",")
    expect(total[1]).toBe("合計")
    expect(total[idx("加減項補發(前期更正)")]).toBe("3000")
    expect(total[idx("加減項扣回-追回課稅所得(前期更正)")]).toBe("1500")
    expect(total[idx("加減項扣回-追回非課稅(前期更正)")]).toBe("500")
    expect(total[idx("加減項不課稅補發(前期更正)")]).toBe("450")
  })
})
