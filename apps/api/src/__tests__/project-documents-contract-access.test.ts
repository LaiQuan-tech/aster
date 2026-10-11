import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 合約掃描檔的權限、檔案類型與上傳大小（業主 2026-09-30 會議 A 批）——純測試。
 *
 * 可看／上傳／刪除合約掃描檔的人只有四種：hr_admin／platform_admin、該案 lead_emp_id、
 * 該案成員角色 manager（經理）或 lead（主辦／承辦）。一般成員、非成員、部門主管、會計都不行。
 * supabase 換成記憶體版（helpers/fake-supabase.ts）＋一個只記錄呼叫的 storage 替身；不連任何 DB。
 */

const storage = vi.hoisted(() => {
  type Obj = { size: number; contentType: string }
  const objects = new Map<string, Obj>()
  const signedFor: string[] = []
  const uploaded: Array<{ path: string; bytes: number; contentType: string | undefined }> = []
  const removed: string[] = []
  const uploadUrls: string[] = []
  const api = {
    from: (_bucket: string) => ({
      createSignedUrl: async (path: string, _ttl: number) => {
        signedFor.push(path)
        return { data: { signedUrl: `https://signed.example.test/${path}` }, error: null }
      },
      upload: async (path: string, body: Buffer, opts?: { contentType?: string }) => {
        uploaded.push({ path, bytes: body.length, contentType: opts?.contentType })
        objects.set(path, { size: body.length, contentType: opts?.contentType ?? "" })
        return { data: { path }, error: null }
      },
      remove: async (paths: string[]) => {
        removed.push(...paths)
        for (const p of paths) objects.delete(p)
        return { data: [], error: null }
      },
      createSignedUploadUrl: async (path: string) => {
        uploadUrls.push(path)
        return { data: { signedUrl: `https://signed.example.test/upload/${path}`, token: `token-for-${path}`, path }, error: null }
      },
      info: async (path: string) => {
        const o = objects.get(path)
        if (!o) return { data: null, error: { message: "Object not found" } }
        return { data: { name: path, size: o.size, contentType: o.contentType }, error: null }
      },
    }),
  }
  const reset = () => {
    objects.clear()
    signedFor.length = 0
    uploaded.length = 0
    removed.length = 0
    uploadUrls.length = 0
  }
  return { api, objects, signedFor, uploaded, removed, uploadUrls, reset }
})

vi.mock("../lib/supabase.js", async () => {
  const base = (await import("./helpers/fake-supabase.js")).fakeSupabaseModule()
  return { ...base, supabaseAdmin: { ...base.supabaseAdmin, storage: storage.api } }
})

import {
  BASE64_MAX_BYTES,
  MAX_BYTES,
  isAllowedContractScan,
  projectDocumentsRouter,
} from "../routes/project-documents.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json({ limit: "12mb" }))
app.use(projectDocumentsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const PROJECT = "dddddddd-0000-4000-8000-000000000001"
const OTHER_PROJECT = "dddddddd-0000-4000-8000-000000000002"
const DEPT = "aaaaaaaa-0000-4000-8000-0000000000d1"
const CONTRACT = "cccccccc-0000-4000-8000-000000000001"
const VOIDED_CONTRACT = "cccccccc-0000-4000-8000-000000000002"
const OTHER_PROJECT_CONTRACT = "cccccccc-0000-4000-8000-000000000003"

const emp = (n: number) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`
const E = {
  hr: emp(1),
  platform: emp(2),
  accountant: emp(3),
  lead: emp(4), // projects.lead_emp_id
  manager: emp(5), // 成員角色 manager
  leadRole: emp(6), // 成員角色 lead
  member: emp(7),
  support: emp(8),
  outsider: emp(9),
  deptManager: emp(10),
}
// token 直接當 userId（fake-supabase 的 getUserFromToken）。
const T = {
  hr: "hr-user",
  platform: "platform-user",
  accountant: "accountant-user",
  lead: "lead-user",
  manager: "manager-user",
  leadRole: "lead-role-user",
  member: "member-user",
  support: "support-user",
  outsider: "outsider-user",
  deptManager: "dept-manager-user",
  ghost: "ghost-user", // 登入了，但這個租戶沒有 employees 列
}

const SCAN_NAME = "秘密合約掃描檔.pdf"
const GENERAL_NAME = "一般專案文件.docx"
const SCAN_PATH = `${TENANT_ID}/${PROJECT}/11111111-1111-4111-8111-111111111111.pdf`
const GENERAL_PATH = `${TENANT_ID}/${PROJECT}/22222222-2222-4222-8222-222222222222.docx`
const VOIDED_SCAN_PATH = `${TENANT_ID}/${PROJECT}/33333333-3333-4333-8333-333333333333.pdf`

function docRow(over: Row): Row {
  return { tenant_id: TENANT_ID, project_id: PROJECT, contract_id: null, size_bytes: 1000, content_type: "application/pdf", created_at: "2026-10-01T00:00:00.000Z", uploaded_by_emp_id: null, ...over }
}

const b64 = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64")
const PDF = { fileName: "合約.pdf", contentType: "application/pdf", dataBase64: b64(1000) }

beforeEach(() => {
  fake.reset()
  storage.reset()
  fake.db.employees = [
    { id: E.hr, tenant_id: TENANT_ID, user_id: T.hr, role: "hr_admin", dept_id: null },
    { id: E.platform, tenant_id: TENANT_ID, user_id: T.platform, role: "platform_admin", dept_id: null },
    { id: E.accountant, tenant_id: TENANT_ID, user_id: T.accountant, role: "accountant", dept_id: null },
    { id: E.lead, tenant_id: TENANT_ID, user_id: T.lead, role: "employee", dept_id: null },
    { id: E.manager, tenant_id: TENANT_ID, user_id: T.manager, role: "employee", dept_id: null },
    { id: E.leadRole, tenant_id: TENANT_ID, user_id: T.leadRole, role: "employee", dept_id: null },
    { id: E.member, tenant_id: TENANT_ID, user_id: T.member, role: "employee", dept_id: null },
    { id: E.support, tenant_id: TENANT_ID, user_id: T.support, role: "employee", dept_id: null },
    { id: E.outsider, tenant_id: TENANT_ID, user_id: T.outsider, role: "employee", dept_id: null },
    { id: E.deptManager, tenant_id: TENANT_ID, user_id: T.deptManager, role: "employee", dept_id: DEPT },
  ]
  fake.db.departments = [
    { id: DEPT, tenant_id: TENANT_ID, parent_id: null, name: "測試部門", manager_emp_id: E.deptManager, manager_emp_ids: [E.deptManager], created_at: "2026-01-01T00:00:00.000Z" },
  ]
  fake.db.projects = [
    { id: PROJECT, tenant_id: TENANT_ID, dept_id: DEPT, lead_emp_id: E.lead },
    { id: OTHER_PROJECT, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: null },
  ]
  fake.db.project_members = [
    { id: "m1", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.manager, role_in_project: "manager" },
    { id: "m2", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.leadRole, role_in_project: "lead" },
    { id: "m3", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.member, role_in_project: "member" },
    { id: "m4", tenant_id: TENANT_ID, project_id: PROJECT, employee_id: E.support, role_in_project: "support" },
    // 另一案的經理：不能因此看到這案的合約檔。
    { id: "m5", tenant_id: TENANT_ID, project_id: OTHER_PROJECT, employee_id: E.outsider, role_in_project: "manager" },
  ]
  fake.db.contracts = [
    { id: CONTRACT, tenant_id: TENANT_ID, project_id: PROJECT, deleted_at: null },
    { id: VOIDED_CONTRACT, tenant_id: TENANT_ID, project_id: PROJECT, deleted_at: "2026-10-02T00:00:00.000Z" },
    { id: OTHER_PROJECT_CONTRACT, tenant_id: TENANT_ID, project_id: OTHER_PROJECT, deleted_at: null },
  ]
  fake.db.project_documents = [
    docRow({ id: "doc-general", file_name: GENERAL_NAME, storage_path: GENERAL_PATH, created_at: "2026-10-01T00:00:00.000Z" }),
    docRow({ id: "doc-scan", contract_id: CONTRACT, file_name: SCAN_NAME, storage_path: SCAN_PATH, created_at: "2026-10-02T00:00:00.000Z" }),
    docRow({ id: "doc-voided-scan", contract_id: VOIDED_CONTRACT, file_name: "作廢合約掃描.pdf", storage_path: VOIDED_SCAN_PATH, created_at: "2026-10-03T00:00:00.000Z" }),
  ]
})

const docsOf = (res: request.Response) => (res.body.documents as Array<Row>).map((d) => d.id)
const insertedDocs = () => fake.writes.filter((w) => w.table === "project_documents" && w.action === "insert")

describe("isAllowedContractScan — 合約掃描檔只收 PDF 與圖片（MIME 與副檔名都要在名單內）", () => {
  it("名單內：pdf／jpg／jpeg／png／heic／heif／webp，副檔名大小寫不拘", () => {
    for (const [name, type] of [
      ["a.pdf", "application/pdf"],
      ["a.PDF", "application/pdf"],
      ["a.jpg", "image/jpeg"],
      ["a.JPEG", "image/jpeg"],
      ["a.png", "image/png"],
      ["a.heic", "image/heic"],
      ["a.heif", "image/heif"],
      ["a.webp", "image/webp"],
      ["IMG_0001.HEIC", "image/jpeg"], // iOS Safari：內容轉成 JPEG、檔名仍是 .HEIC——兩項各自檢查，不要求互相對應
      ["a.png", "image/PNG; charset=binary"], // MIME 大小寫與參數正規化
    ] as const) {
      expect(isAllowedContractScan(name, type), `${name} ${type}`).toBe(true)
    }
  })

  it("名單外一律不收：exe、docx、gif、svg、zip、沒副檔名、MIME 或副檔名任一邊不合格", () => {
    for (const [name, type] of [
      ["virus.exe", "application/x-msdownload"],
      ["virus.exe", "application/pdf"], // 副檔名不合格，自報成 pdf 也沒用
      ["scan.pdf", "application/x-msdownload"], // MIME 不合格
      ["scan.pdf.exe", "application/pdf"],
      ["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["a.gif", "image/gif"],
      ["a.svg", "image/svg+xml"],
      ["a.zip", "application/zip"],
      ["noext", "application/pdf"],
      ["a.pdf", ""],
      ["a.pdf", "application/octet-stream"],
    ] as const) {
      expect(isAllowedContractScan(name, type), `${name} ${type}`).toBe(false)
    }
  })
})

describe("GET /projects/:id/documents — 合約掃描檔只給 HR／該案 lead／經理與主辦", () => {
  it.each([
    ["HR（hr_admin）", T.hr],
    ["平台管理員（platform_admin）", T.platform],
    ["該案 lead_emp_id", T.lead],
    ["該案成員角色 manager（經理）", T.manager],
    ["該案成員角色 lead（主辦／承辦）", T.leadRole],
  ])("%s：看得到合約掃描檔（含作廢合約的），旗標 canSeeContractDocs=true", async (_label, token) => {
    const res = await as(token, request(app).get(`/projects/${PROJECT}/documents`))

    expect(res.status).toBe(200)
    expect(res.body.canSeeContractDocs).toBe(true)
    expect(docsOf(res).sort()).toEqual(["doc-general", "doc-scan", "doc-voided-scan"])
    const scan = (res.body.documents as Array<Row>).find((d) => d.id === "doc-scan")!
    expect(scan).toMatchObject({ contractId: CONTRACT, fileName: SCAN_NAME, url: `https://signed.example.test/${SCAN_PATH}` })
  })

  it.each([
    ["一般組員（member）", T.member],
    ["支援（support）", T.support],
    ["非成員（只是另一案的經理）", T.outsider],
    ["部門主管（該案所屬部門）", T.deptManager],
    ["會計（有 finance、能寫一般文件）", T.accountant],
    ["有登入但這個租戶沒有員工列", T.ghost],
  ])("%s：看不到——回應直接不含合約掃描檔（連檔名都沒有），也不替它產簽名網址", async (_label, token) => {
    const res = await as(token, request(app).get(`/projects/${PROJECT}/documents`))

    expect(res.status).toBe(200)
    expect(res.body.canSeeContractDocs).toBe(false)
    // 一般專案文件維持全公司可見。
    expect(docsOf(res)).toEqual(["doc-general"])
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain(SCAN_NAME)
    expect(raw).not.toContain("作廢合約掃描")
    expect(raw).not.toContain(SCAN_PATH)
    expect(raw).not.toContain(CONTRACT)
    // 只有一般文件被簽過名網址。
    expect(storage.signedFor).toEqual([GENERAL_PATH])
  })

  it("專案不存在 → 404", async () => {
    const res = await as(T.hr, request(app).get(`/projects/${"dddddddd-0000-4000-8000-0000000000aa"}/documents`))
    expect(res.status).toBe(404)
  })
})

describe("POST /projects/:id/documents（合約掃描）— 授權", () => {
  it.each([
    ["一般組員", T.member],
    ["支援", T.support],
    ["部門主管", T.deptManager],
    ["會計（一般文件寫得了，合約掃描不行）", T.accountant],
    ["非成員", T.outsider],
  ])("%s：403，檔案沒進 Storage、資料列沒寫", async (_label, token) => {
    const res = await as(token, request(app).post(`/projects/${PROJECT}/documents`)).send({ ...PDF, contractId: CONTRACT })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: "forbidden" })
    expect(storage.uploaded).toHaveLength(0)
    expect(insertedDocs()).toHaveLength(0)
  })

  it.each([
    ["HR", T.hr, E.hr],
    ["該案 lead_emp_id", T.lead, E.lead],
    ["經理成員", T.manager, E.manager],
    ["主辦成員", T.leadRole, E.leadRole],
  ])("%s：201，資料列掛在該合約上並記上傳者", async (_label, token, empId) => {
    const res = await as(token, request(app).post(`/projects/${PROJECT}/documents`)).send({ ...PDF, contractId: CONTRACT })

    expect(res.status).toBe(201)
    expect(storage.uploaded).toHaveLength(1)
    expect(insertedDocs()).toHaveLength(1)
    expect(insertedDocs()[0]?.payload).toMatchObject({
      project_id: PROJECT,
      contract_id: CONTRACT,
      file_name: "合約.pdf",
      content_type: "application/pdf",
      uploaded_by_emp_id: empId,
    })
  })

  it("平台管理員（platform_admin）也可以上傳合約掃描檔；沒有員工列的登入者一律 403", async () => {
    const platform = await as(T.platform, request(app).post(`/projects/${PROJECT}/documents`)).send({ ...PDF, contractId: CONTRACT })
    expect(platform.status).toBe(201)
    expect(insertedDocs()[0]?.payload).toMatchObject({ uploaded_by_emp_id: E.platform })

    const ghost = await as(T.ghost, request(app).post(`/projects/${PROJECT}/documents`)).send({ ...PDF, contractId: CONTRACT })
    expect(ghost.status).toBe(403)
    expect(insertedDocs()).toHaveLength(1)
  })

  it("base64 上傳寫資料列失敗：回 500，並把剛傳進 Storage 的檔刪掉", async () => {
    fake.injectError({ table: "project_documents", action: "insert", error: { message: "boom" } })

    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/documents`)).send({ ...PDF, contractId: CONTRACT })

    expect(res.status).toBe(500)
    expect(storage.uploaded).toHaveLength(1)
    expect(storage.removed).toEqual([storage.uploaded[0]!.path])
  })

  it("無權者拿別人的合約 id 來試探：一律 403，不會用 400 洩漏合約存不存在", async () => {
    const res = await as(T.member, request(app).post(`/projects/${PROJECT}/documents`)).send({
      ...PDF,
      contractId: OTHER_PROJECT_CONTRACT,
    })
    expect(res.status).toBe(403)
  })

  it("有權者帶別的專案／已作廢的合約 id：400 contract_not_in_project", async () => {
    for (const contractId of [OTHER_PROJECT_CONTRACT, VOIDED_CONTRACT]) {
      const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/documents`)).send({ ...PDF, contractId })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: "contract_not_in_project" })
    }
    expect(storage.uploaded).toHaveLength(0)
  })
})

describe("POST /projects/:id/documents — 檔案類型", () => {
  it("合約掃描上傳 .exe → 400 unsupported_file_type，什麼都沒寫", async () => {
    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/documents`)).send({
      fileName: "setup.exe",
      contentType: "application/x-msdownload",
      dataBase64: b64(100),
      contractId: CONTRACT,
    })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(res.body.supported).toEqual(["pdf", "jpg", "jpeg", "png", "heic", "heif", "webp"])
    expect(storage.uploaded).toHaveLength(0)
    expect(insertedDocs()).toHaveLength(0)
  })

  it.each([
    ["副檔名 .exe 卻自報 application/pdf", "setup.exe", "application/pdf"],
    ["副檔名 .pdf 但 MIME 是執行檔", "scan.pdf", "application/x-msdownload"],
    ["雙重副檔名 scan.pdf.exe", "scan.pdf.exe", "application/pdf"],
    ["Word 檔", "合約.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["GIF 圖", "scan.gif", "image/gif"],
    ["SVG（可夾腳本）", "scan.svg", "image/svg+xml"],
  ])("合約掃描：%s → 400 unsupported_file_type", async (_label, fileName, contentType) => {
    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/documents`)).send({
      fileName,
      contentType,
      dataBase64: b64(100),
      contractId: CONTRACT,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(storage.uploaded).toHaveLength(0)
  })

  it.each([
    ["contract.pdf", "application/pdf"],
    ["photo.JPG", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["scan.png", "image/png"],
    ["IMG_1.heic", "image/heic"],
    ["IMG_2.heif", "image/heif"],
    ["scan.webp", "image/webp"],
    ["IMG_3.HEIC", "image/jpeg"],
  ])("合約掃描收 %s（%s）→ 201", async (fileName, contentType) => {
    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/documents`)).send({
      fileName,
      contentType,
      dataBase64: b64(100),
      contractId: CONTRACT,
    })
    expect(res.status).toBe(201)
  })

  it("合約掃描存的 content_type 是正規化後的（小寫、去參數）", async () => {
    const res = await as(T.hr, request(app).post(`/projects/${PROJECT}/documents`)).send({
      fileName: "scan.png",
      contentType: "image/PNG; charset=binary",
      dataBase64: b64(100),
      contractId: CONTRACT,
    })
    expect(res.status).toBe(201)
    expect(insertedDocs()[0]?.payload).toMatchObject({ content_type: "image/png" })
    expect(storage.uploaded[0]?.contentType).toBe("image/png")
  })

  it("只限制合約掃描檔：一般專案文件（知識庫工作檔）不受 PDF／圖片限制——docx、dwg、zip 照收", async () => {
    for (const [fileName, contentType] of [
      ["報告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["圖面.dwg", "application/octet-stream"],
      ["附件.zip", "application/zip"],
    ] as const) {
      const res = await as(T.member, request(app).post(`/projects/${PROJECT}/documents`)).send({
        fileName,
        contentType,
        dataBase64: b64(100),
      })
      expect(res.status, fileName).toBe(201)
    }
    expect(insertedDocs().every((w) => (w.payload as Row).contract_id === null)).toBe(true)
  })
})

describe("POST /projects/:id/documents — 大小（Vercel 請求上限 4.5MB → base64 路徑 3 MiB）", () => {
  it("常數：base64 路徑 3 MiB、直傳 10 MiB", () => {
    expect(BASE64_MAX_BYTES).toBe(3 * 1024 * 1024)
    expect(MAX_BYTES).toBe(10 * 1024 * 1024)
    // 3 MiB 的 base64 約 4.19 MB，加上 JSON 包裝仍在 Vercel 的 4.5 MB 以內。
    expect(Math.ceil(BASE64_MAX_BYTES / 3) * 4).toBeLessThan(4_500_000)
  })

  it("剛好 3 MiB → 201；多 1 byte → 413 file_too_large，附上限與直傳上限", async () => {
    const ok = await as(T.member, request(app).post(`/projects/${PROJECT}/documents`)).send({
      fileName: "ok.docx",
      contentType: "application/octet-stream",
      dataBase64: b64(BASE64_MAX_BYTES),
    })
    expect(ok.status).toBe(201)

    const big = await as(T.member, request(app).post(`/projects/${PROJECT}/documents`)).send({
      fileName: "big.docx",
      contentType: "application/octet-stream",
      dataBase64: b64(BASE64_MAX_BYTES + 1),
    })
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ error: "file_too_large", maxBytes: BASE64_MAX_BYTES, directUploadMaxBytes: MAX_BYTES })
    expect(storage.uploaded).toHaveLength(1)
  })

  it("body 要二選一：dataBase64 與 storagePath 都沒帶、或都帶 → 400 invalid_body", async () => {
    const neither = await as(T.member, request(app).post(`/projects/${PROJECT}/documents`)).send({ fileName: "a.docx", contentType: "x/y" })
    expect(neither.status).toBe(400)
    expect(neither.body.error).toBe("invalid_body")
    const both = await as(T.member, request(app).post(`/projects/${PROJECT}/documents`)).send({
      fileName: "a.docx",
      contentType: "x/y",
      dataBase64: b64(10),
      storagePath: `${TENANT_ID}/${PROJECT}/44444444-4444-4444-8444-444444444444.docx`,
    })
    expect(both.status).toBe(400)
  })
})

describe("POST /projects/:id/documents/upload-url — 簽名上傳網址（大檔直傳 Storage，不經 API）", () => {
  const url = (id = PROJECT) => `/projects/${id}/documents/upload-url`

  it("一般文件：有寫入權的成員拿得到網址；路徑由伺服器產生、在 {tenant}/{project}/ 底下，副檔名保留", async () => {
    const res = await as(T.member, request(app).post(url())).send({ fileName: "大圖面.pdf", contentType: "application/pdf", sizeBytes: 9 * 1024 * 1024 })

    expect(res.status).toBe(200)
    expect(res.body.bucket).toBe("project-documents")
    expect(res.body.maxBytes).toBe(MAX_BYTES)
    expect(res.body.path).toMatch(new RegExp(`^${TENANT_ID}/${PROJECT}/[0-9a-f-]{36}\\.pdf$`))
    expect(res.body.path).not.toContain("大圖面")
    expect(res.body.token).toBe(`token-for-${res.body.path}`)
    expect(storage.uploadUrls).toEqual([res.body.path])
  })

  it("超過 10 MiB → 413；0 或負數／缺欄位 → 400 invalid_body；沒發任何網址", async () => {
    const big = await as(T.member, request(app).post(url())).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: MAX_BYTES + 1 })
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ error: "file_too_large", maxBytes: MAX_BYTES })
    for (const sizeBytes of [0, -5]) {
      const bad = await as(T.member, request(app).post(url())).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes })
      expect(bad.status).toBe(400)
    }
    expect((await as(T.member, request(app).post(url())).send({ fileName: "a.pdf" })).status).toBe(400)
    expect(storage.uploadUrls).toHaveLength(0)
  })

  it("合約掃描：無權者 403；有權者的 .exe 直接 400（連網址都不發）；PDF／圖片才發", async () => {
    const denied = await as(T.deptManager, request(app).post(url())).send({
      fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 5_000_000, contractId: CONTRACT,
    })
    expect(denied.status).toBe(403)

    const exe = await as(T.lead, request(app).post(url())).send({
      fileName: "a.exe", contentType: "application/x-msdownload", sizeBytes: 5_000_000, contractId: CONTRACT,
    })
    expect(exe.status).toBe(400)
    expect(exe.body.error).toBe("unsupported_file_type")
    expect(storage.uploadUrls).toHaveLength(0)

    const ok = await as(T.lead, request(app).post(url())).send({
      fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 5_000_000, contractId: CONTRACT,
    })
    expect(ok.status).toBe(200)
    expect(storage.uploadUrls).toHaveLength(1)
  })

  it("無權者拿不存在或別專案的合約 id 取網址：一律 403（不能用回應差異探測合約），也沒發網址", async () => {
    for (const contractId of [OTHER_PROJECT_CONTRACT, "cccccccc-0000-4000-8000-0000000000ff"]) {
      const res = await as(T.member, request(app).post(url())).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 5_000_000, contractId })
      expect(res.status).toBe(403)
    }
    expect(storage.uploadUrls).toHaveLength(0)
  })

  it("沒有員工列的登入者：403", async () => {
    const res = await as(T.ghost, request(app).post(url())).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 100 })
    expect(res.status).toBe(403)
  })

  it("沒有寫入權的人（非成員）：403；專案不存在：404", async () => {
    const outsider = await as(T.outsider, request(app).post(url())).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 100 })
    expect(outsider.status).toBe(403)
    const missing = await as(T.hr, request(app).post(url("dddddddd-0000-4000-8000-0000000000aa"))).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 100 })
    expect(missing.status).toBe(404)
  })
})

describe("POST /projects/:id/documents（storagePath 登記）— 直傳完成後驗證再寫資料列", () => {
  const newPath = (ext = ".pdf", project = PROJECT) => `${TENANT_ID}/${project}/99999999-9999-4999-8999-99999999999${Math.floor(Math.random() * 10)}${ext}`
  const post = (token: string, body: Row) => as(token, request(app).post(`/projects/${PROJECT}/documents`)).send(body)

  it("一般文件：Storage 裡有這個檔 → 201，大小以 Storage 實際回報的為準", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 7 * 1024 * 1024, contentType: "application/pdf" })

    const res = await post(T.member, { fileName: "大圖面.pdf", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(201)
    expect(res.body.sizeBytes).toBe(7 * 1024 * 1024)
    expect(insertedDocs()[0]?.payload).toMatchObject({
      storage_path: path,
      size_bytes: 7 * 1024 * 1024,
      contract_id: null,
      file_name: "大圖面.pdf",
      uploaded_by_emp_id: E.member,
    })
    expect(storage.removed).toHaveLength(0)
  })

  it("合約掃描：有權者、Storage 記的是 PDF → 201 並掛在合約上", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 5_000_000, contentType: "application/pdf" })

    const res = await post(T.manager, { fileName: "合約.pdf", contentType: "application/pdf", storagePath: path, contractId: CONTRACT })

    expect(res.status).toBe(201)
    expect(insertedDocs()[0]?.payload).toMatchObject({ contract_id: CONTRACT, content_type: "application/pdf", size_bytes: 5_000_000 })
  })

  it("合約掃描：無權者 → 403，Storage 裡的檔不動、資料列沒寫", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 5_000_000, contentType: "application/pdf" })

    const res = await post(T.accountant, { fileName: "合約.pdf", contentType: "application/pdf", storagePath: path, contractId: CONTRACT })

    expect(res.status).toBe(403)
    expect(insertedDocs()).toHaveLength(0)
    expect(storage.removed).toHaveLength(0)
  })

  it("合約掃描：自報 application/pdf、但 Storage 記的是別種類型 → 400，並把已上傳的檔刪掉", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 5_000_000, contentType: "application/x-msdownload" })

    const res = await post(T.hr, { fileName: "合約.pdf", contentType: "application/pdf", storagePath: path, contractId: CONTRACT })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(insertedDocs()).toHaveLength(0)
    expect(storage.removed).toEqual([path])
  })

  it("Storage 說不出類型（octet-stream）才退回自報的——與 base64 路徑信任程度相同", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 5_000_000, contentType: "application/octet-stream" })

    const res = await post(T.hr, { fileName: "合約.pdf", contentType: "application/pdf", storagePath: path, contractId: CONTRACT })

    expect(res.status).toBe(201)
    expect(insertedDocs()[0]?.payload).toMatchObject({ content_type: "application/pdf" })
  })

  it("超過 10 MiB（繞過取網址那步直接傳大檔）→ 413，並把檔刪掉", async () => {
    const path = newPath(".docx")
    storage.objects.set(path, { size: MAX_BYTES + 1, contentType: "application/octet-stream" })

    const res = await post(T.member, { fileName: "超大.docx", contentType: "application/octet-stream", storagePath: path })

    expect(res.status).toBe(413)
    expect(insertedDocs()).toHaveLength(0)
    expect(storage.removed).toEqual([path])
  })

  it("Storage 裡沒有這個檔（沒傳完、或亂填路徑）→ 400 upload_not_found", async () => {
    const res = await post(T.member, { fileName: "a.pdf", contentType: "application/pdf", storagePath: newPath(".pdf") })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "upload_not_found" })
    expect(insertedDocs()).toHaveLength(0)
  })

  it("只認自己發出去的路徑形狀：別的專案／別的租戶／路徑穿越／非 uuid 檔名 → 400 invalid_storage_path", async () => {
    for (const storagePath of [
      newPath(".pdf", OTHER_PROJECT),
      `99999999-9999-4999-8999-999999999999/${PROJECT}/99999999-9999-4999-8999-999999999999.pdf`,
      `${TENANT_ID}/${PROJECT}/../${OTHER_PROJECT}/99999999-9999-4999-8999-999999999999.pdf`,
      `${TENANT_ID}/${PROJECT}/not-a-uuid.pdf`,
      `${TENANT_ID}/${PROJECT}/nested/99999999-9999-4999-8999-999999999999.pdf`,
    ]) {
      const res = await post(T.member, { fileName: "a.pdf", contentType: "application/pdf", storagePath })
      expect(res.status, storagePath).toBe(400)
      expect(res.body.error).toBe("invalid_storage_path")
    }
    expect(insertedDocs()).toHaveLength(0)
  })

  it("登記的檔名副檔名要與路徑副檔名一致（不能傳完 .pdf 再把名字改成 .exe）→ 400", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 100, contentType: "application/pdf" })
    const res = await post(T.member, { fileName: "改名.exe", contentType: "application/pdf", storagePath: path })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_storage_path")
    // 路徑是我們發的形狀、也還沒登記過 → 確定是這次上傳留下的檔，一併刪掉，不留孤兒
    expect(storage.removed).toEqual([path])
    expect(insertedDocs()).toHaveLength(0)
  })

  it("路徑不是我們發的形狀、或已經登記過 → 一律不刪任何檔（驗證失敗不能變成刪別人檔案的管道）", async () => {
    await post(T.member, { fileName: "a.pdf", contentType: "application/pdf", storagePath: `${TENANT_ID}/${PROJECT}/not-a-uuid.pdf` });
    await post(T.member, { fileName: "改名.exe", contentType: "application/pdf", storagePath: SCAN_PATH }); // 已登記的合約掃描檔 + 副檔名對不上
    expect(storage.removed).toHaveLength(0)
  })

  it("直傳登記的合約掃描：檔名是 .exe（沒經過取網址那步、直接傳）→ 400，並把檔刪掉", async () => {
    const path = newPath(".exe")
    storage.objects.set(path, { size: 1000, contentType: "application/x-msdownload" })

    const res = await post(T.hr, { fileName: "setup.exe", contentType: "application/x-msdownload", storagePath: path, contractId: CONTRACT })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(storage.removed).toEqual([path])
    expect(insertedDocs()).toHaveLength(0)
  })

  it("Storage 回報大小是 0 → 400 upload_not_found，並把空檔刪掉", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 0, contentType: "application/pdf" })

    const res = await post(T.member, { fileName: "空檔.pdf", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "upload_not_found" })
    expect(storage.removed).toEqual([path])
  })

  it("資料列寫入失敗：回 500，並把已經在 Storage 的檔刪掉（不留孤兒檔）", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 1000, contentType: "application/pdf" })
    fake.injectError({ table: "project_documents", action: "insert", error: { message: "boom" } })

    const res = await post(T.member, { fileName: "a.pdf", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(500)
    expect(storage.removed).toEqual([path])
  })

  it("沒有員工列的登入者、平台管理員：直傳登記的授權跟 base64 路徑一致（ghost 403；platform_admin 可登記合約掃描）", async () => {
    const path = newPath(".pdf")
    storage.objects.set(path, { size: 1000, contentType: "application/pdf" })
    const ghost = await post(T.ghost, { fileName: "a.pdf", contentType: "application/pdf", storagePath: path })
    expect(ghost.status).toBe(403)
    expect(storage.removed).toHaveLength(0)

    const platform = await post(T.platform, { fileName: "a.pdf", contentType: "application/pdf", storagePath: path, contractId: CONTRACT })
    expect(platform.status).toBe(201)
    expect(insertedDocs()[0]?.payload).toMatchObject({ uploaded_by_emp_id: E.platform, contract_id: CONTRACT })
  })

  it("已登記過的路徑不能再登記（擋重放：不能把別人的合約掃描檔重新登記成一般文件），而且檔不會被刪", async () => {
    const res = await post(T.member, { fileName: "偷來的.pdf", contentType: "application/pdf", storagePath: SCAN_PATH })

    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: "already_registered" })
    expect(insertedDocs()).toHaveLength(0)
    expect(storage.removed).toHaveLength(0)
  })
})

describe("DELETE /projects/:id/documents/:docId", () => {
  const del = (token: string, id: string) => as(token, request(app).delete(`/projects/${PROJECT}/documents/${id}`))
  const deletes = () => fake.writes.filter((w) => w.table === "project_documents" && w.action === "delete")

  it.each([
    ["一般組員", T.member],
    ["部門主管", T.deptManager],
    ["會計", T.accountant],
    ["非成員", T.outsider],
  ])("合約掃描檔：%s 刪不了（403），檔與資料列都留著", async (_label, token) => {
    const res = await del(token, "doc-scan")
    expect(res.status).toBe(403)
    expect(storage.removed).toHaveLength(0)
    expect(deletes()).toHaveLength(0)
  })

  it("合約掃描檔：原上傳者後來變成一般組員，也刪不了（不看上傳者，看現在有沒有權）", async () => {
    const row = fake.db.project_documents.find((d) => d.id === "doc-scan")!
    row.uploaded_by_emp_id = E.member

    const res = await del(T.member, "doc-scan")

    expect(res.status).toBe(403)
    expect(deletes()).toHaveLength(0)
  })

  it.each([
    ["HR", T.hr],
    ["該案 lead", T.lead],
    ["經理成員", T.manager],
    ["主辦成員", T.leadRole],
  ])("合約掃描檔：%s 刪得了（200，Storage 與資料列一起刪）", async (_label, token) => {
    const res = await del(token, "doc-scan")
    expect(res.status).toBe(200)
    expect(storage.removed).toEqual([SCAN_PATH])
    expect(deletes()).toHaveLength(1)
    expect(fake.db.project_documents.map((d) => d.id)).not.toContain("doc-scan")
  })

  it("一般文件：上傳者本人刪得了；沒有寫入權的非成員不行；成員（有寫入權）刪得了別人的", async () => {
    const row = fake.db.project_documents.find((d) => d.id === "doc-general")!
    row.uploaded_by_emp_id = E.support

    expect((await del(T.outsider, "doc-general")).status).toBe(403)
    expect((await del(T.support, "doc-general")).status).toBe(200)

    fake.db.project_documents.push(docRow({ id: "doc-general-2", file_name: "另一份.docx", storage_path: `${TENANT_ID}/${PROJECT}/55555555-5555-4555-8555-555555555555.docx`, uploaded_by_emp_id: E.support }))
    expect((await del(T.member, "doc-general-2")).status).toBe(200)
  })

  it("平台管理員刪得了合約掃描檔；沒有員工列的登入者 403", async () => {
    expect((await del(T.ghost, "doc-scan")).status).toBe(403)
    expect(deletes()).toHaveLength(0)
    expect((await del(T.platform, "doc-scan")).status).toBe(200)
    expect(deletes()).toHaveLength(1)
  })

  it("不存在的文件 → 404", async () => {
    expect((await del(T.hr, "nope")).status).toBe(404)
  })
})
