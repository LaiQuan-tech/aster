/**
 * Gemini（Google Generative Language API）薄封裝，AI 模組共用：
 *   generateText   純文字（示警摘要、知識庫問答）
 *   generateJson   要求回 JSON（名片欄位抽取，可附影像）
 *   embedTexts     文字向量（知識庫索引與查詢）
 *
 * 金鑰只從環境變數讀（GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY）；
 * 沒設就丟 GeminiNotConfiguredError，呼叫端回 503，功能可以「沒 AI 也能用」的部分照常。
 * 模型可由 GEMINI_MODEL（生成）與 GEMINI_EMBED_MODEL（向量）覆寫。
 */

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super("gemini_not_configured")
  }
}

const BASE = "https://generativelanguage.googleapis.com/v1beta"

/** 向量維度固定 768（knowledge_chunks.embedding vector(768)）；換維度要重建索引。 */
export const EMBED_DIMS = 768

function apiKey(): string {
  const key =
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GOOGLE_API_KEY
  if (!key) throw new GeminiNotConfiguredError()
  return key
}

export function isGeminiConfigured(): boolean {
  return !!(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY)
}

/**
 * 預設用 Google 的浮動別名 `gemini-flash-latest`，不釘死版本：2026-09-14 實測
 * `gemini-2.0-flash` 已被下架（API 直接回「no longer available」），釘死版本等於
 * 給自己埋一顆會炸的雷。要固定行為就在環境變數 GEMINI_MODEL 指定版本。
 */
export function generationModel(): string {
  return process.env.GEMINI_MODEL ?? "gemini-flash-latest"
}
export function embeddingModel(): string {
  return process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001"
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  error?: { message?: string }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
    body: JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } }
  if (!res.ok) throw new Error(payload.error?.message ?? `gemini_failed_${res.status}`)
  return payload
}

export interface InlineImage {
  mimeType: string
  /** base64（不含 data: 前綴） */
  data: string
}

export async function generateText(
  system: string,
  prompt: string,
  opts: { temperature?: number; maxOutputTokens?: number; images?: InlineImage[]; json?: boolean } = {},
): Promise<{ text: string; model: string }> {
  const model = generationModel()
  const parts: Array<Record<string, unknown>> = []
  for (const img of opts.images ?? []) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } })
  parts.push({ text: prompt })
  const payload = await post<GeminiResponse>(`models/${encodeURIComponent(model)}:generateContent`, {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      // 2.5 之後的 flash 預設會「思考」，思考 token 也算在 maxOutputTokens 裡，
      // 預算太小答案會被截斷（實測 60 只吐得出三個字）。給寬一點，成本差異很小。
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
  })
  const text =
    payload.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim() ?? ""
  if (!text) throw new Error("gemini_empty_response")
  return { text, model }
}

/** 要模型回 JSON 物件；模型偶爾會包 ```json 圍欄，這裡剝掉再 parse。 */
export async function generateJson<T = unknown>(
  system: string,
  prompt: string,
  opts: { images?: InlineImage[]; temperature?: number } = {},
): Promise<{ data: T; model: string }> {
  const { text, model } = await generateText(system, prompt, { ...opts, json: true, maxOutputTokens: 4096 })
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
  try {
    return { data: JSON.parse(cleaned) as T, model }
  } catch {
    throw new Error("gemini_invalid_json")
  }
}

interface EmbedBatchResponse {
  embeddings?: Array<{ values?: number[] }>
}

/**
 * 文字向量。taskType 依用途：索引文件用 RETRIEVAL_DOCUMENT、查詢用 RETRIEVAL_QUERY
 * （Gemini embedding 對兩者有不同的投影，混用會降低召回）。一次最多 100 段，
 * 這裡自動分批；回傳與輸入同序、每個長度 EMBED_DIMS。
 */
export async function embedTexts(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT",
): Promise<number[][]> {
  if (texts.length === 0) return []
  const model = embeddingModel()
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100)
    const payload = await post<EmbedBatchResponse>(`models/${encodeURIComponent(model)}:batchEmbedContents`, {
      requests: batch.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBED_DIMS,
      })),
    })
    const vecs = payload.embeddings ?? []
    if (vecs.length !== batch.length) throw new Error("gemini_embedding_count_mismatch")
    for (const v of vecs) {
      const values = v.values ?? []
      if (values.length !== EMBED_DIMS) throw new Error(`gemini_embedding_dims_${values.length}`)
      out.push(normalize(values))
    }
  }
  return out
}

/** gemini-embedding-001 降維後的向量沒有正規化；cosine 距離要先正規化才準。 */
function normalize(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  return norm > 0 ? v.map((x) => x / norm) : v
}
