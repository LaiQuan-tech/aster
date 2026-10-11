import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 一般專案文件不收執行檔與腳本（2026-10-11）——純測試。
 *
 * 專案文件是全公司可下載的工作檔，不限類型（docx／xlsx／dwg／zip…），但 exe／bat／sh／js／apk… 這類
 * 執行檔與腳本一律 400 `unsupported_file_type`（body 帶 `blocked` 清單）。三條上傳路徑都要擋：
 *   • POST /projects/:id/documents/upload-url（連簽名網址都不發）
 *   • POST /projects/:id/documents 的 base64 內容
 *   • POST /projects/:id/documents 的 storagePath 登記（Storage 實際記下的 MIME 也算，並把已傳的檔刪掉）
 * 合約掃描檔另有「只收 PDF 與圖片」的白名單（project-documents-contract-access.test.ts），不受這份影響。
 * supabase 換成記憶體版（helpers/fake-supabase.ts）＋一個只記錄呼叫的 storage 替身；不連任何 DB。
 */

const storage = vi.hoisted(() => {
  type Obj = { size: number; contentType: string }
  const objects = new Map<string, Obj>()
  const uploaded: string[] = []
  const removed: string[] = []
  const uploadUrls: string[] = []
  const api = {
    from: (_bucket: string) => ({
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.example.test/${path}` }, error: null }),
      upload: async (path: string, body: Buffer, opts?: { contentType?: string }) => {
        uploaded.push(path)
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
  }
  return { api, objects, uploaded, removed, uploadUrls, reset }
})

vi.mock("../lib/supabase.js", async () => {
  const base = (await import("./helpers/fake-supabase.js")).fakeSupabaseModule()
  return { ...base, supabaseAdmin: { ...base.supabaseAdmin, storage: storage.api } }
})

import {
  BLOCKED_DOCUMENT_CONTENT_TYPES,
  BLOCKED_DOCUMENT_EXTENSIONS,
  blockedCheckExtOf,
  isBlockedDocument,
} from "../lib/blocked-upload-types.js"
import { projectDocumentsRouter } from "../routes/project-documents.js"
import { fake, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json({ limit: "12mb" }))
app.use(projectDocumentsRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)

const PROJECT = "dddddddd-0000-4000-8000-000000000001"
const HR_ID = "bbbbbbbb-0000-4000-8000-000000000001"
const HR = "hr-user"
const b64 = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64")
const insertedDocs = () => fake.writes.filter((w) => w.table === "project_documents" && w.action === "insert")
const newPath = (ext: string) => `${TENANT_ID}/${PROJECT}/99999999-9999-4999-8999-99999999999${Math.floor(Math.random() * 10)}${ext}`

beforeEach(() => {
  fake.reset()
  storage.reset()
  fake.db.employees = [{ id: HR_ID, tenant_id: TENANT_ID, user_id: HR, role: "hr_admin", dept_id: null }]
  fake.db.departments = []
  fake.db.projects = [{ id: PROJECT, tenant_id: TENANT_ID, dept_id: null, lead_emp_id: null }]
  fake.db.project_members = []
  fake.db.contracts = []
  fake.db.project_documents = []
})

// ── 純函式：名單與判斷 ───────────────────────────────────────────────────

describe("名單（業主指定的副檔名與 MIME）", () => {
  it("副檔名剛好是業主列的 18 個", () => {
    expect([...BLOCKED_DOCUMENT_EXTENSIONS].sort()).toEqual(
      ["exe", "bat", "cmd", "com", "scr", "msi", "ps1", "vbs", "vbe", "js", "jse", "wsf", "jar", "apk", "dmg", "pkg", "sh", "app"].map((e) => `.${e}`).sort(),
    )
  })

  it("MIME 至少含 application/x-msdownload、application/x-sh；全是小寫、不含參數；不含通用的 octet-stream", () => {
    expect(BLOCKED_DOCUMENT_CONTENT_TYPES).toContain("application/x-msdownload")
    expect(BLOCKED_DOCUMENT_CONTENT_TYPES).toContain("application/x-sh")
    for (const type of BLOCKED_DOCUMENT_CONTENT_TYPES) expect(type, type).toMatch(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)
    expect(BLOCKED_DOCUMENT_CONTENT_TYPES).not.toContain("application/octet-stream")
  })
})

describe("isBlockedDocument — 副檔名或 MIME 任一邊中就擋", () => {
  it.each(BLOCKED_DOCUMENT_EXTENSIONS.map((ext) => [ext]))("副檔名 %s：不分大小寫都擋，自報成無害的 MIME 也沒用", (ext) => {
    expect(isBlockedDocument(`setup${ext}`, "application/pdf")).toBe(true)
    expect(isBlockedDocument(`SETUP${ext.toUpperCase()}`, "")).toBe(true)
    expect(isBlockedDocument(`中文 檔名${ext}`, null)).toBe(true)
  })

  it("雙重副檔名看最後一段：report.pdf.exe 擋、report.exe.pdf 不擋", () => {
    expect(isBlockedDocument("report.pdf.exe", "application/pdf")).toBe(true)
    expect(isBlockedDocument("report.exe.pdf", "application/pdf")).toBe(false)
    expect(isBlockedDocument("script.js.txt", "text/plain")).toBe(false)
  })

  it("結尾多打的點或空白不能繞過（Windows 會自動拿掉：setup.exe. 其實就是 setup.exe）", () => {
    for (const name of ["setup.exe.", "setup.exe..", "setup.exe ", "setup.exe. .", "run.sh   "]) {
      expect(blockedCheckExtOf(name), name).not.toBe("")
      expect(isBlockedDocument(name, "application/octet-stream"), name).toBe(true)
    }
  })

  it("MIME：大小寫與參數正規化後比對；副檔名無害也擋", () => {
    expect(isBlockedDocument("data.bin", "application/x-msdownload")).toBe(true)
    expect(isBlockedDocument("data.bin", "Application/X-SH; charset=binary")).toBe(true)
    expect(isBlockedDocument("data.bin", "text/javascript")).toBe(true)
    expect(isBlockedDocument("data.bin", "application/vnd.android.package-archive")).toBe(true)
    expect(isBlockedDocument("data.bin", "application/java-archive")).toBe(true)
  })

  it("多個 MIME（自報＋Storage 實際記的）：任何一個中就擋", () => {
    expect(isBlockedDocument("a.dat", "text/plain", "application/x-msdownload")).toBe(true)
    expect(isBlockedDocument("a.dat", "application/x-sh", "text/plain")).toBe(true)
    expect(isBlockedDocument("a.dat", "text/plain", undefined, null)).toBe(false)
  })

  it("一般工作檔照收：docx／xlsx／dwg／zip／pdf／圖檔／csv／json／沒有副檔名／octet-stream", () => {
    for (const [name, type] of [
      ["報告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["預算.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["圖面.dwg", "application/octet-stream"],
      ["圖面.DWG", ""],
      ["附件.zip", "application/zip"],
      ["合約.pdf", "application/pdf"],
      ["現場.jpg", "image/jpeg"],
      ["清單.csv", "text/csv"],
      ["設定.json", "application/json"], // .json 不等於 .js
      ["元件.jsx", "text/jsx"],
      ["Makefile", "application/octet-stream"],
      ["apple.applescript.pdf", "application/pdf"],
    ] as const) {
      expect(isBlockedDocument(name, type), `${name} ${type}`).toBe(false)
    }
  })
})

// ── 路由 ─────────────────────────────────────────────────────────────────

describe("POST /projects/:id/documents/upload-url — 執行檔連網址都不發", () => {
  const url = `/projects/${PROJECT}/documents/upload-url`

  it.each([
    ["setup.exe", "application/x-msdownload"],
    ["run.sh", "application/x-sh"],
    ["tool.JS", "text/javascript"],
    ["app.apk", "application/vnd.android.package-archive"],
    ["installer.dmg", "application/x-apple-diskimage"],
    ["setup.exe.", "application/octet-stream"], // 結尾多一個點
    ["報告.pdf.exe", "application/pdf"], // 雙重副檔名 + 自報成 pdf
    ["data.bin", "application/x-msdownload"], // 副檔名無害、MIME 是執行檔
  ])("%s（%s）→ 400 unsupported_file_type，附 blocked 清單，沒發任何網址", async (fileName, contentType) => {
    const res = await as(HR, request(app).post(url)).send({ fileName, contentType, sizeBytes: 5 * 1024 * 1024 })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(res.body.blocked).toEqual(expect.arrayContaining(["exe", "bat", "sh", "js", "apk", "dmg"]))
    expect(res.body).not.toHaveProperty("supported")
    expect(storage.uploadUrls).toHaveLength(0)
  })

  it("一般工作檔照發網址（dwg／docx／zip），副檔名保留", async () => {
    for (const [fileName, contentType, ext] of [
      ["圖面.dwg", "application/octet-stream", ".dwg"],
      ["報告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
      ["附件.zip", "application/zip", ".zip"],
    ] as const) {
      const res = await as(HR, request(app).post(url)).send({ fileName, contentType, sizeBytes: 5 * 1024 * 1024 })
      expect(res.status, fileName).toBe(200)
      expect(res.body.path.endsWith(ext)).toBe(true)
    }
    expect(storage.uploadUrls).toHaveLength(3)
  })

  it("先驗類型再驗大小：又大又是 exe → 回 unsupported_file_type（不是 413）", async () => {
    const res = await as(HR, request(app).post(url)).send({ fileName: "big.exe", contentType: "application/x-msdownload", sizeBytes: 50 * 1024 * 1024 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
  })

  it("合約掃描檔的 .exe 仍走原本的白名單回應（supported，不是 blocked）", async () => {
    fake.db.contracts = [{ id: "cccccccc-0000-4000-8000-000000000001", tenant_id: TENANT_ID, project_id: PROJECT, deleted_at: null }]
    const res = await as(HR, request(app).post(url)).send({
      fileName: "a.exe",
      contentType: "application/x-msdownload",
      sizeBytes: 1000,
      contractId: "cccccccc-0000-4000-8000-000000000001",
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(res.body.supported).toEqual(expect.arrayContaining(["pdf", "jpg"]))
    expect(res.body).not.toHaveProperty("blocked")
  })
})

describe("POST /projects/:id/documents（base64）— 執行檔不收", () => {
  const post = (body: Row) => as(HR, request(app).post(`/projects/${PROJECT}/documents`)).send(body)

  it.each([
    ["setup.exe", "application/x-msdownload"],
    ["deploy.sh", "application/x-sh"],
    ["install.bat", "application/octet-stream"],
    ["Run.CMD", "application/octet-stream"],
    ["macro.vbs", "text/vbscript"],
    ["a.ps1", "text/plain"],
    ["tool.jar", "application/java-archive"],
    ["data.bin", "application/x-sh"], // 副檔名無害、MIME 是 shell 腳本
  ])("%s（%s）→ 400 unsupported_file_type；不碰 Storage、不寫資料列", async (fileName, contentType) => {
    const res = await post({ fileName, contentType, dataBase64: b64(100) })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(res.body.blocked).toContain("exe")
    expect(storage.uploaded).toHaveLength(0)
    expect(insertedDocs()).toHaveLength(0)
  })

  it("一般工作檔照收（201）：dwg／docx／xlsx／zip／json", async () => {
    for (const [fileName, contentType] of [
      ["圖面.dwg", "application/octet-stream"],
      ["報告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["預算.xlsx", "application/octet-stream"],
      ["附件.zip", "application/zip"],
      ["設定.json", "application/json"],
    ] as const) {
      const res = await post({ fileName, contentType, dataBase64: b64(100) })
      expect(res.status, fileName).toBe(201)
    }
    expect(insertedDocs()).toHaveLength(5)
  })
})

describe("POST /projects/:id/documents（storagePath 登記）— 檔名、自報與 Storage 實際類型都要看", () => {
  const post = (body: Row) => as(HR, request(app).post(`/projects/${PROJECT}/documents`)).send(body)

  it("檔名無害、自報無害，但 Storage 實際記下的是執行檔 MIME → 400，並把已傳的檔刪掉", async () => {
    const path = newPath(".dat")
    storage.objects.set(path, { size: 4 * 1024 * 1024, contentType: "application/x-msdownload" })

    const res = await post({ fileName: "data.dat", contentType: "text/plain", storagePath: path })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(storage.removed).toEqual([path])
    expect(insertedDocs()).toHaveLength(0)
  })

  it("自報的是執行檔 MIME、Storage 記的是無害的 → 一樣擋（任何一邊中就擋）", async () => {
    const path = newPath(".dat")
    storage.objects.set(path, { size: 1000, contentType: "text/plain" })

    const res = await post({ fileName: "data.dat", contentType: "application/x-sh", storagePath: path })

    expect(res.status).toBe(400)
    expect(storage.removed).toEqual([path])
  })

  it("檔名是 .exe、路徑副檔名也是 .exe（例如規則上線前就發出去的網址）→ 400，並把檔刪掉", async () => {
    const path = newPath(".exe")
    storage.objects.set(path, { size: 1000, contentType: "application/octet-stream" })

    const res = await post({ fileName: "setup.exe", contentType: "application/octet-stream", storagePath: path })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe("unsupported_file_type")
    expect(storage.removed).toEqual([path])
    expect(insertedDocs()).toHaveLength(0)
  })

  it("一般工作檔照登記（201），Storage 記的是 octet-stream 也不擋", async () => {
    const path = newPath(".dwg")
    storage.objects.set(path, { size: 6 * 1024 * 1024, contentType: "application/octet-stream" })

    const res = await post({ fileName: "大圖面.dwg", contentType: "application/octet-stream", storagePath: path })

    expect(res.status).toBe(201)
    expect(res.body.sizeBytes).toBe(6 * 1024 * 1024)
    expect(storage.removed).toHaveLength(0)
    expect(insertedDocs()).toHaveLength(1)
  })
})
