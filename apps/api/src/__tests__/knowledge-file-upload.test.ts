import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 知識庫檔案上傳（kind=file）——純測試。
 *
 * 以前：檔案 base64 經 API，程式註解寫上限 12 MB；但 API 跑在 Vercel serverless，request body 上限約 4.5 MB，
 * 實際只傳得動 3 MB 上下，超過的請求根本到不了程式（瀏覽器只看到沒有 CORS 標頭的錯誤）。
 * 現在比照專案文件（project-documents.ts）：
 *   • ≤ 3 MiB：base64 隨 JSON 送（POST /knowledge/documents）
 *   • 3～10 MiB：先 POST /knowledge/documents/upload-url 取簽名網址 → 瀏覽器直傳 Storage →
 *     POST /knowledge/documents 帶 storagePath 登記（API 用 Storage 回報的實際大小與類型再驗一次）
 *   • > 10 MiB：413
 * 寫入限 HR（和原本一樣）。supabase 換成記憶體版＋一個只記錄呼叫的 storage 替身；索引（抽字、向量）換成假的。
 * ⚠️ 識別碼、檔名都是明顯的假值。
 */

const h = vi.hoisted(() => {
  type Obj = { size: number; contentType: string }
  const objects = new Map<string, Obj>()
  const uploaded: Array<{ path: string; bytes: number; contentType: string | undefined }> = []
  const removed: string[] = []
  const uploadUrls: string[] = []
  const indexCalls: string[] = []
  const storage = {
    from: (_bucket: string) => ({
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
    uploaded.length = 0
    removed.length = 0
    uploadUrls.length = 0
    indexCalls.length = 0
  }
  return { storage, objects, uploaded, removed, uploadUrls, indexCalls, reset }
})

vi.mock("../lib/supabase.js", async () => {
  const base = (await import("./helpers/fake-supabase.js")).fakeSupabaseModule()
  return { ...base, supabaseAdmin: { ...base.supabaseAdmin, storage: h.storage } }
})
vi.mock("../lib/gemini.js", () => ({
  GeminiNotConfiguredError: class GeminiNotConfiguredError extends Error {},
  isGeminiConfigured: () => false,
  embedTexts: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
  generateText: async () => ({ text: "測試答案", model: "fake-model" }),
}))
// 路由的「建檔後立即索引」換成假的（真的會去下載檔案、抽字、算向量）。
vi.mock("../services/knowledge-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/knowledge-store.js")>()
  return {
    ...actual,
    indexDocument: async (_tenantId: string, id: string) => {
      h.indexCalls.push(id)
      return { status: "indexed", chunks: 1 }
    },
  }
})

import { BASE64_MAX_BYTES, MAX_BYTES, knowledgeRouter } from "../routes/knowledge.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json({ limit: "12mb" }))
app.use(knowledgeRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)
const HR = "hr-user"
const STAFF = "staff-user"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const MiB = 1024 * 1024

const b64 = (bytes: number) => Buffer.alloc(bytes, 65).toString("base64")
const docInserts = () => fake.writes.filter((w) => w.table === "knowledge_documents" && w.action === "insert")
const newPath = (ext = ".pdf", tenant = TENANT_ID) => `${tenant}/99999999-9999-4999-8999-99999999999${Math.floor(Math.random() * 10)}${ext}`

beforeEach(() => {
  fake.reset()
  h.reset()
  fake.db.employees = [
    { id: HR_ID, tenant_id: TENANT_ID, user_id: HR, role: "hr_admin", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000002", tenant_id: TENANT_ID, user_id: STAFF, role: "employee", dept_id: null },
  ]
  fake.db.knowledge_documents = []
  fake.db.knowledge_chunks = []
  fake.db.project_documents = []
})

describe("上限常數（Vercel request body 約 4.5 MB，base64 膨脹 4/3）", () => {
  it("經 API 的 base64 上限 3 MiB（base64 後仍在 4.5 MB 內）、直傳上限 10 MiB", () => {
    expect(BASE64_MAX_BYTES).toBe(3 * MiB)
    expect(MAX_BYTES).toBe(10 * MiB)
    expect(Math.ceil(BASE64_MAX_BYTES / 3) * 4).toBeLessThan(4_500_000)
  })
})

describe("POST /knowledge/documents/upload-url — 取簽名上傳網址", () => {
  const url = "/knowledge/documents/upload-url"

  it("HR：拿到 bucket／path／token；路徑由伺服器產生、在 {tenant}/ 底下、保留副檔名、不含使用者的檔名", async () => {
    const res = await as(HR, request(app).post(url)).send({ fileName: "公司規章（最新）.pdf", contentType: "application/pdf", sizeBytes: 8 * MiB })

    expect(res.status).toBe(200)
    expect(res.body.bucket).toBe("knowledge-files")
    expect(res.body.maxBytes).toBe(MAX_BYTES)
    expect(res.body.path).toMatch(new RegExp(`^${TENANT_ID}/[0-9a-f-]{36}\\.pdf$`))
    expect(res.body.path).not.toContain("規章")
    expect(res.body.token).toBe(`token-for-${res.body.path}`)
    expect(h.uploadUrls).toEqual([res.body.path])
  })

  it("非 HR → 403，沒發網址", async () => {
    const res = await as(STAFF, request(app).post(url)).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 1000 })
    expect(res.status).toBe(403)
    expect(h.uploadUrls).toHaveLength(0)
  })

  it("不支援的類型（.exe、.zip）→ 400 unsupported_file_type 並列出支援的；連網址都不發", async () => {
    for (const [fileName, contentType] of [
      ["setup.exe", "application/x-msdownload"],
      ["附件.zip", "application/zip"],
    ] as const) {
      const res = await as(HR, request(app).post(url)).send({ fileName, contentType, sizeBytes: 5 * MiB })
      expect(res.status, fileName).toBe(400)
      expect(res.body.error).toBe("unsupported_file_type")
      expect(res.body.supported).toEqual(["txt", "md", "csv", "json", "pdf", "docx"])
    }
    expect(h.uploadUrls).toHaveLength(0)
  })

  it("瀏覽器標 octet-stream 但副檔名是支援的（.docx）照發網址", async () => {
    const res = await as(HR, request(app).post(url)).send({ fileName: "SOP.docx", contentType: "application/octet-stream", sizeBytes: 4 * MiB })
    expect(res.status).toBe(200)
    expect(res.body.path.endsWith(".docx")).toBe(true)
  })

  it("剛好 10 MiB 可以；多 1 byte → 413 file_too_large；0／負數／缺欄位 → 400 invalid_body", async () => {
    const edge = await as(HR, request(app).post(url)).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: MAX_BYTES })
    expect(edge.status).toBe(200)

    const big = await as(HR, request(app).post(url)).send({ fileName: "a.pdf", contentType: "application/pdf", sizeBytes: MAX_BYTES + 1 })
    expect(big.status).toBe(413)
    expect(big.body).toEqual({ error: "file_too_large", maxBytes: MAX_BYTES })

    for (const body of [
      { fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 0 },
      { fileName: "a.pdf", contentType: "application/pdf", sizeBytes: -5 },
      { fileName: "a.pdf", contentType: "application/pdf" },
      { contentType: "application/pdf", sizeBytes: 100 },
    ]) {
      const bad = await as(HR, request(app).post(url)).send(body)
      expect(bad.status, JSON.stringify(body)).toBe(400)
      expect(bad.body.error).toBe("invalid_body")
    }
    expect(h.uploadUrls).toHaveLength(1)
  })
})

describe("POST /knowledge/documents（base64，小檔）", () => {
  const post = (body: Row, token = HR) => as(token, request(app).post("/knowledge/documents")).send(body)

  it("≤ 3 MiB：201，檔案進 knowledge-files、建檔並索引", async () => {
    const res = await post({ kind: "file", fileName: "規章.docx", contentType: "application/octet-stream", dataBase64: b64(1000) })

    expect(res.status).toBe(201)
    expect(h.uploaded).toHaveLength(1)
    expect(h.uploaded[0]?.path).toMatch(new RegExp(`^${TENANT_ID}/[0-9a-f-]{36}\\.docx$`))
    expect(docInserts()[0]?.payload).toMatchObject({
      kind: "file",
      file_name: "規章.docx",
      title: "規章",
      storage_path: h.uploaded[0]?.path,
      created_by_emp_id: HR_ID,
    })
    expect(h.indexCalls).toHaveLength(1)
    expect(h.removed).toHaveLength(0)
  })

  it("剛好 3 MiB 可以；多 1 byte → 413，附經 API 上限與直傳上限，什麼都沒寫", async () => {
    const edge = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", dataBase64: b64(BASE64_MAX_BYTES) })
    expect(edge.status).toBe(201)

    h.reset()
    const over = await post({ kind: "file", fileName: "b.pdf", contentType: "application/pdf", dataBase64: b64(BASE64_MAX_BYTES + 1) })
    expect(over.status).toBe(413)
    expect(over.body).toEqual({ error: "file_too_large", maxBytes: BASE64_MAX_BYTES, directUploadMaxBytes: MAX_BYTES })
    expect(h.uploaded).toHaveLength(0)
    expect(h.indexCalls).toHaveLength(0)
  })

  it("body 要二選一：dataBase64 與 storagePath 都沒帶、或都帶 → 400 invalid_body", async () => {
    const neither = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf" })
    expect(neither.status).toBe(400)
    expect(neither.body.error).toBe("invalid_body")

    const both = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", dataBase64: b64(10), storagePath: newPath() })
    expect(both.status).toBe(400)
    expect(both.body.error).toBe("invalid_body")
    expect(h.uploaded).toHaveLength(0)
  })

  it("不支援的類型 → 400 unsupported_file_type；非 HR → 403", async () => {
    const bad = await post({ kind: "file", fileName: "a.exe", contentType: "application/x-msdownload", dataBase64: b64(10) })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("unsupported_file_type")

    const staff = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", dataBase64: b64(10) }, STAFF)
    expect(staff.status).toBe(403)
    expect(h.uploaded).toHaveLength(0)
  })

  it("資料列寫入失敗：回 500，並把剛傳進 Storage 的檔刪掉（不留孤兒檔）", async () => {
    fake.injectError({ table: "knowledge_documents", action: "insert", error: { message: "boom", code: "XX000" } })

    const res = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", dataBase64: b64(100) })

    expect(res.status).toBe(500)
    expect(h.uploaded).toHaveLength(1)
    expect(h.removed).toEqual([h.uploaded[0]?.path])
  })

  it("文字與掛入專案文件兩種 kind 不受影響", async () => {
    const text = await post({ kind: "text", title: "出差 SOP", body: "住宿上限 2500 元" })
    expect(text.status).toBe(201)
    expect(docInserts()[0]?.payload).toMatchObject({ kind: "text", title: "出差 SOP" })
    expect(h.uploaded).toHaveLength(0)
  })
})

describe("POST /knowledge/documents（storagePath 登記，大檔直傳）", () => {
  const post = (body: Row, token = HR) => as(token, request(app).post("/knowledge/documents")).send(body)

  it("Storage 裡有這個檔 → 201：資料列用 Storage 記的類型，檔案不再經過 API，建檔並索引", async () => {
    const path = newPath(".pdf")
    h.objects.set(path, { size: 7 * MiB, contentType: "application/pdf" })

    const res = await post({ kind: "file", fileName: "年度報告.pdf", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(201)
    expect(h.uploaded).toHaveLength(0) // 沒有經 API 上傳
    expect(docInserts()[0]?.payload).toMatchObject({
      kind: "file",
      file_name: "年度報告.pdf",
      title: "年度報告",
      content_type: "application/pdf",
      storage_path: path,
      created_by_emp_id: HR_ID,
    })
    expect(h.indexCalls).toHaveLength(1)
    expect(h.removed).toHaveLength(0)
  })

  it("Storage 說不出類型（octet-stream）才退回自報的", async () => {
    const path = newPath(".docx")
    h.objects.set(path, { size: 4 * MiB, contentType: "application/octet-stream" })

    const res = await post({
      kind: "file",
      fileName: "SOP.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      storagePath: path,
    })

    expect(res.status).toBe(201)
    expect(docInserts()[0]?.payload).toMatchObject({ content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
  })

  it("超過 10 MiB（繞過取網址那步直接傳大檔）→ 413，並把檔刪掉", async () => {
    const path = newPath(".pdf")
    h.objects.set(path, { size: MAX_BYTES + 1, contentType: "application/pdf" })

    const res = await post({ kind: "file", fileName: "巨大.pdf", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(413)
    expect(res.body).toEqual({ error: "file_too_large", maxBytes: MAX_BYTES })
    expect(h.removed).toEqual([path])
    expect(docInserts()).toHaveLength(0)
  })

  it("Storage 裡沒有這個檔（沒傳完、或亂填路徑）→ 400 upload_not_found；大小 0 → 400 並把空檔刪掉", async () => {
    const missing = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", storagePath: newPath(".pdf") })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe("upload_not_found")
    expect(h.removed).toHaveLength(0)

    const empty = newPath(".pdf")
    h.objects.set(empty, { size: 0, contentType: "application/pdf" })
    const res = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", storagePath: empty })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("upload_not_found")
    expect(h.removed).toEqual([empty])
    expect(docInserts()).toHaveLength(0)
  })

  it("只認自己發出去的路徑形狀：別的租戶／路徑穿越／非 uuid 檔名／巢狀 → 400 invalid_storage_path，而且一個檔都不刪", async () => {
    for (const storagePath of [
      newPath(".pdf", OTHER_TENANT_ID),
      `${TENANT_ID}/../${OTHER_TENANT_ID}/99999999-9999-4999-8999-999999999999.pdf`,
      `${TENANT_ID}/not-a-uuid.pdf`,
      `${TENANT_ID}/nested/99999999-9999-4999-8999-999999999999.pdf`,
    ]) {
      h.objects.set(storagePath, { size: 1000, contentType: "application/pdf" })
      const res = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", storagePath })
      expect(res.status, storagePath).toBe(400)
      expect(res.body.error).toBe("invalid_storage_path")
    }
    expect(h.removed).toHaveLength(0)
    expect(docInserts()).toHaveLength(0)
  })

  it("登記的檔名副檔名要與路徑副檔名一致（不能傳完 .txt 再把名字改成 .pdf）→ 400，並把檔刪掉", async () => {
    const path = newPath(".txt")
    h.objects.set(path, { size: 100, contentType: "text/plain" })

    const res = await post({ kind: "file", fileName: "改名.pdf", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("invalid_storage_path")
    expect(h.removed).toEqual([path])
    expect(docInserts()).toHaveLength(0)
  })

  it("已登記過的路徑不能再登記一次（擋重放），而且那個檔不會被刪", async () => {
    const path = newPath(".pdf")
    h.objects.set(path, { size: 1000, contentType: "application/pdf" })
    fake.db.knowledge_documents = [{ id: "kkkkkkkk-0000-4000-8000-000000000001", tenant_id: TENANT_ID, kind: "file", storage_path: path }]

    const res = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe("already_registered")
    expect(h.removed).toHaveLength(0)
    expect(h.objects.has(path)).toBe(true)
  })

  it("自報是 pdf、但 Storage 實際記的是別種（檔名副檔名也認不得）→ 400 unsupported_file_type，並把檔刪掉", async () => {
    const path = newPath(".xyz")
    h.objects.set(path, { size: 1000, contentType: "application/x-msdownload" })

    const res = await post({ kind: "file", fileName: "a.xyz", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(h.removed).toEqual([path])
    expect(docInserts()).toHaveLength(0)
  })

  it("非 HR → 403：Storage 裡的檔不動、資料列沒寫", async () => {
    const path = newPath(".pdf")
    h.objects.set(path, { size: 1000, contentType: "application/pdf" })

    const res = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", storagePath: path }, STAFF)

    expect(res.status).toBe(403)
    expect(h.removed).toHaveLength(0)
    expect(docInserts()).toHaveLength(0)
  })

  it("資料列寫入失敗：回 500，並把已經在 Storage 的檔刪掉（不留孤兒檔）", async () => {
    const path = newPath(".pdf")
    h.objects.set(path, { size: 5 * MiB, contentType: "application/pdf" })
    fake.injectError({ table: "knowledge_documents", action: "insert", error: { message: "boom", code: "XX000" } })

    const res = await post({ kind: "file", fileName: "a.pdf", contentType: "application/pdf", storagePath: path })

    expect(res.status).toBe(500)
    expect(h.removed).toEqual([path])
  })
})
