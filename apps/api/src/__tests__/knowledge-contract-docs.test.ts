import express, { type NextFunction, type Request, type Response } from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 合約掃描檔不進知識庫（業主 2026-09-30 會議 A 批）——純測試。
 * 合約掃描只給該案經理、承辦與 HR 看；知識庫的搜尋與問答是全公司可用，所以：
 *   • 掛入（POST /knowledge/documents kind=project_document）遇到合約掃描檔 → 400 contract_document_not_allowed
 *   • 已經掛進去的（歷史殘留；正式庫目前 0 筆）：列表不列、下載 404、搜尋與問答排除、重建索引失敗
 */

const h = vi.hoisted(() => ({
  gemini: { configured: true, prompts: [] as string[] },
  signed: [] as string[],
  indexCalls: [] as string[],
}))

vi.mock("../lib/supabase.js", async () => {
  const base = (await import("./helpers/fake-supabase.js")).fakeSupabaseModule()
  const storage = {
    from: () => ({
      createSignedUrl: async (path: string) => {
        h.signed.push(path)
        return { data: { signedUrl: `https://signed.example.test/${path}` }, error: null }
      },
    }),
  }
  return { ...base, supabaseAdmin: { ...base.supabaseAdmin, storage } }
})
vi.mock("../lib/gemini.js", () => ({
  GeminiNotConfiguredError: class GeminiNotConfiguredError extends Error {},
  isGeminiConfigured: () => h.gemini.configured,
  embedTexts: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
  generateText: async (_system: string, prompt: string) => {
    h.gemini.prompts.push(prompt)
    return { text: "測試答案", model: "fake-model" }
  },
}))
// 路由的「建檔後立即索引」換成假的（真的會去下載檔案、抽字、算向量）；其餘（搜尋、問答、列表過濾）用真的。
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

import { knowledgeRouter } from "../routes/knowledge.js"
import { fake, OTHER_TENANT_ID, TENANT_ID, type Row } from "./helpers/fake-supabase.js"

const app = express()
app.use(express.json())
app.use(knowledgeRouter)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
})

const as = (token: string, req: request.Test) => req.set("Authorization", `Bearer ${token}`)
const HR = "hr-user"
const STAFF = "staff-user"

const PD_NORMAL = "aaaaaaaa-0000-4000-8000-000000000001"
const PD_SCAN = "aaaaaaaa-0000-4000-8000-000000000002"
const CONTRACT = "cccccccc-0000-4000-8000-000000000001"
const K_NORMAL = "kkkkkkkk-0000-4000-8000-000000000001"
const K_SCAN = "kkkkkkkk-0000-4000-8000-000000000002"
const K_TEXT = "kkkkkkkk-0000-4000-8000-000000000003"
const SCAN_PATH = `${TENANT_ID}/proj/scan.pdf`
const NORMAL_PATH = `${TENANT_ID}/proj/normal.pdf`

function knowledgeDoc(over: Row): Row {
  return {
    tenant_id: TENANT_ID,
    kind: "project_document",
    file_name: null,
    content_type: "application/pdf",
    storage_path: null,
    status: "indexed",
    error: null,
    chunk_count: 1,
    created_by_emp_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    body: "",
    ...over,
  }
}

beforeEach(() => {
  fake.reset()
  h.gemini.configured = true
  h.gemini.prompts.length = 0
  h.signed.length = 0
  h.indexCalls.length = 0
  fake.db.employees = [
    { id: "bbbbbbbb-0000-4000-8000-000000000001", tenant_id: TENANT_ID, user_id: HR, role: "hr_admin", dept_id: null },
    { id: "bbbbbbbb-0000-4000-8000-000000000002", tenant_id: TENANT_ID, user_id: STAFF, role: "employee", dept_id: null },
  ]
  fake.db.project_documents = [
    { id: PD_NORMAL, tenant_id: TENANT_ID, contract_id: null, file_name: "施工規範.pdf", content_type: "application/pdf", storage_path: NORMAL_PATH },
    { id: PD_SCAN, tenant_id: TENANT_ID, contract_id: CONTRACT, file_name: "秘密合約掃描.pdf", content_type: "application/pdf", storage_path: SCAN_PATH },
  ]
  fake.db.knowledge_documents = [
    knowledgeDoc({ id: K_NORMAL, title: "施工規範", project_document_id: PD_NORMAL, file_name: "施工規範.pdf" }),
    // 歷史殘留：來源是合約掃描檔的知識庫文件。
    knowledgeDoc({ id: K_SCAN, title: "秘密合約", project_document_id: PD_SCAN, file_name: "秘密合約掃描.pdf" }),
    knowledgeDoc({ id: K_TEXT, kind: "text", title: "出差 SOP", project_document_id: null, body: "出差住宿上限 2500 元" }),
  ]
  fake.db.knowledge_chunks = []
})

const docWrites = () => fake.writes.filter((w) => w.table === "knowledge_documents" && w.action === "insert")

describe("POST /knowledge/documents（掛入專案文件）", () => {
  it("合約掃描檔 → 400 contract_document_not_allowed；不建檔、不索引", async () => {
    const res = await as(HR, request(app).post("/knowledge/documents")).send({ kind: "project_document", projectDocumentId: PD_SCAN })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "contract_document_not_allowed" })
    expect(docWrites()).toHaveLength(0)
    expect(h.indexCalls).toHaveLength(0)
  })

  it("帶自訂標題也一樣擋（不能用改名繞過）", async () => {
    const res = await as(HR, request(app).post("/knowledge/documents")).send({ kind: "project_document", projectDocumentId: PD_SCAN, title: "公司規章" })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe("contract_document_not_allowed")
  })

  it("一般專案文件照常掛入（201、建檔並索引）", async () => {
    fake.db.knowledge_documents = []
    const res = await as(HR, request(app).post("/knowledge/documents")).send({ kind: "project_document", projectDocumentId: PD_NORMAL })

    expect(res.status).toBe(201)
    expect(docWrites()).toHaveLength(1)
    expect(docWrites()[0]?.payload).toMatchObject({ kind: "project_document", project_document_id: PD_NORMAL, title: "施工規範" })
    expect(h.indexCalls).toHaveLength(1)
  })

  it("不存在的專案文件 → 404（沒有被合約檢查吃掉）；非 HR → 403", async () => {
    const missing = await as(HR, request(app).post("/knowledge/documents")).send({
      kind: "project_document",
      projectDocumentId: "aaaaaaaa-0000-4000-8000-0000000000ff",
    })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe("project_document_not_found")

    const staff = await as(STAFF, request(app).post("/knowledge/documents")).send({ kind: "project_document", projectDocumentId: PD_NORMAL })
    expect(staff.status).toBe(403)
  })
})

describe("GET /knowledge/documents（列表）", () => {
  it("歷史殘留的合約掃描文件不列——連標題與檔名都不給；其他文件照列", async () => {
    const res = await as(STAFF, request(app).get("/knowledge/documents"))

    expect(res.status).toBe(200)
    expect((res.body.documents as Array<Row>).map((d) => d.id).sort()).toEqual([K_NORMAL, K_TEXT].sort())
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain("秘密合約")
    expect(raw).not.toContain(PD_SCAN)
  })
})

describe("GET /knowledge/documents/:id/download", () => {
  it("來源是合約掃描檔 → 404，不發簽名網址", async () => {
    const res = await as(STAFF, request(app).get(`/knowledge/documents/${K_SCAN}/download`))

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: "not_found" })
    expect(h.signed).toHaveLength(0)
  })

  it("一般專案文件照常回簽名網址", async () => {
    const res = await as(STAFF, request(app).get(`/knowledge/documents/${K_NORMAL}/download`))

    expect(res.status).toBe(200)
    expect(res.body.url).toBe(`https://signed.example.test/${NORMAL_PATH}`)
    expect(h.signed).toEqual([NORMAL_PATH])
  })
})

describe("搜尋與問答排除合約掃描檔來源", () => {
  const chunk = (documentId: string, title: string, content: string) => ({
    chunk_id: `chunk-${documentId}`,
    document_id: documentId,
    title,
    chunk_index: 0,
    content,
    similarity: 0.9,
  })

  beforeEach(() => {
    fake.rpcHandlers.match_knowledge_chunks = () => ({
      data: [
        chunk(K_SCAN, "秘密合約", "合約機密條款：違約金為總價 30%"),
        chunk(K_NORMAL, "施工規範", "施工規範：管線需保持 30 公分間距"),
      ],
      error: null,
    })
  })

  it("GET /knowledge/search（向量）：合約掃描來源的段落被濾掉", async () => {
    const res = await as(STAFF, request(app).get("/knowledge/search").query({ q: "違約金" }))

    expect(res.status).toBe(200)
    expect(res.body.mode).toBe("vector")
    expect((res.body.hits as Array<Row>).map((x) => x.documentId)).toEqual([K_NORMAL])
    expect(JSON.stringify(res.body)).not.toContain("機密條款")
  })

  it("向量命中的全是合約掃描 → 不回那些段落（退回關鍵字後也沒有）", async () => {
    fake.rpcHandlers.match_knowledge_chunks = () => ({ data: [chunk(K_SCAN, "秘密合約", "合約機密條款")], error: null })

    const res = await as(STAFF, request(app).get("/knowledge/search").query({ q: "違約金" }))

    expect(res.status).toBe(200)
    expect(res.body.hits).toEqual([])
    expect(JSON.stringify(res.body)).not.toContain("機密條款")
  })

  it("POST /knowledge/ask：送給模型的參考資料與回傳的 sources 都不含合約掃描來源", async () => {
    const res = await as(STAFF, request(app).post("/knowledge/ask")).send({ question: "違約金是多少？" })

    expect(res.status).toBe(200)
    expect(res.body.answer).toBe("測試答案")
    expect((res.body.sources as Array<Row>).map((s) => s.documentId)).toEqual([K_NORMAL])
    expect(h.gemini.prompts).toHaveLength(1)
    expect(h.gemini.prompts[0]).toContain("施工規範：管線需保持 30 公分間距")
    expect(h.gemini.prompts[0]).not.toContain("機密條款")
    expect(h.gemini.prompts[0]).not.toContain("秘密合約")
  })

  it("沒有歷史殘留時行為不變：全部段落照回", async () => {
    fake.db.knowledge_documents = [knowledgeDoc({ id: K_NORMAL, title: "施工規範", project_document_id: PD_NORMAL })]
    fake.rpcHandlers.match_knowledge_chunks = () => ({ data: [chunk(K_NORMAL, "施工規範", "A"), chunk(K_NORMAL, "施工規範", "B")], error: null })

    const res = await as(STAFF, request(app).get("/knowledge/search").query({ q: "x" }))

    expect((res.body.hits as Array<Row>)).toHaveLength(2)
  })
})

describe("搜尋排除合約掃描檔來源——關鍵字模式（沒設 Gemini 金鑰）", () => {
  // fake 不模擬 PostgREST 的內嵌關聯篩選（`knowledge_documents!inner(...)` ＋ `.eq("knowledge_documents.status", …)`），
  // 所以列上直接放那個欄位名來通過篩選；真正要驗的是搜尋結果裡合約掃描來源的段落有沒有被濾掉。
  const kwChunk = (id: string, documentId: string, content: string) => ({
    id, tenant_id: TENANT_ID, document_id: documentId, chunk_index: 0, content, "knowledge_documents.status": "indexed",
  })

  it("關鍵字命中合約掃描來源的段落：被濾掉，其他照回", async () => {
    h.gemini.configured = false
    fake.db.knowledge_chunks = [
      kwChunk("k1", K_SCAN, "違約金為總價 30%（機密條款）"),
      kwChunk("k2", K_NORMAL, "施工規範：違約金依合約辦理"),
    ]

    const res = await as(STAFF, request(app).get("/knowledge/search").query({ q: "違約金" }))

    expect(res.status).toBe(200)
    expect(res.body.mode).toBe("keyword")
    expect((res.body.hits as Array<Row>).map((x) => x.documentId)).toEqual([K_NORMAL])
    expect(JSON.stringify(res.body)).not.toContain("機密條款")
  })

  it("有向量金鑰但向量沒命中、退回關鍵字時也一樣濾掉", async () => {
    fake.rpcHandlers.match_knowledge_chunks = () => ({ data: [], error: null })
    fake.db.knowledge_chunks = [kwChunk("k1", K_SCAN, "違約金為總價 30%（機密條款）")]

    const res = await as(STAFF, request(app).get("/knowledge/search").query({ q: "違約金" }))

    expect(res.body.mode).toBe("keyword")
    expect(res.body.hits).toEqual([])
  })
})

describe("contractLinkedDocumentIds — 資料多時不漏擋（分頁、分批）", () => {
  it("超過一頁（1000 筆）與超過一批 .in()（100 個 id）：排在最後面的合約掃描文件也找得到，且每次 .in() 不超過 100 個", async () => {
    const actual = await vi.importActual<typeof import("../services/knowledge-store.js")>("../services/knowledge-store.js")
    const total = 1205
    const pad = (n: number) => String(n).padStart(4, "0")
    fake.db.project_documents = Array.from({ length: total }, (_, i) => ({
      id: `pd-${pad(i)}`, tenant_id: TENANT_ID, contract_id: i === total - 1 || i === 7 ? CONTRACT : null,
    }))
    fake.db.knowledge_documents = Array.from({ length: total }, (_, i) =>
      knowledgeDoc({ id: `kd-${pad(i)}`, title: `文件${i}`, project_document_id: `pd-${pad(i)}` }),
    )
    // 另一租戶的資料不能混進來
    fake.db.knowledge_documents.push(knowledgeDoc({ id: "kd-other", tenant_id: OTHER_TENANT_ID, project_document_id: "pd-0007" }))

    const inSizes: number[] = []
    const originalFrom = fake.from
    const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
      const builder = originalFrom(table)
      const originalIn = builder.in
      builder.in = (column: string, values: unknown[]) => {
        inSizes.push(values.length)
        return originalIn(column, values)
      }
      return builder
    })
    try {
      const ids = await actual.contractLinkedDocumentIds(TENANT_ID)
      expect([...ids].sort()).toEqual(["kd-0007", `kd-${pad(total - 1)}`].sort())
    } finally {
      spy.mockRestore()
    }
    expect(inSizes.length).toBe(Math.ceil(total / 100))
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(100)
  })

  it("沒有任何掛專案文件的知識庫文件：只查一次（不再去查 project_documents）", async () => {
    const actual = await vi.importActual<typeof import("../services/knowledge-store.js")>("../services/knowledge-store.js")
    fake.db.knowledge_documents = [knowledgeDoc({ id: K_TEXT, kind: "text", project_document_id: null })]
    fake.reads.length = 0

    expect((await actual.contractLinkedDocumentIds(TENANT_ID)).size).toBe(0)
    expect(fake.reads).toEqual(["knowledge_documents"])
  })
})

describe("indexDocument（重建索引）不處理合約掃描檔", () => {
  it("歷史殘留的合約掃描文件重建索引 → 失敗並留下原因，不去下載檔案", async () => {
    const actual = await vi.importActual<typeof import("../services/knowledge-store.js")>("../services/knowledge-store.js")

    const result = await actual.indexDocument(TENANT_ID, K_SCAN)

    expect(result).toEqual({ status: "failed", chunks: 0, error: "contract_document_not_allowed" })
    expect(fake.db.knowledge_documents.find((d) => d.id === K_SCAN)).toMatchObject({ status: "failed", error: "contract_document_not_allowed" })
  })
})
