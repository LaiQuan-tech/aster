/**
 * 知識庫的文字層：從檔案抽純文字、把長文切成可向量化的塊。
 * chunkText 是純函式（有測試）；extractText 依 contentType 分派到解析器。
 */
// pdf-parse（含 pdfjs）與 mammoth 都用動態 import：它們只在索引 PDF／DOCX 時才需要，
// 而且是這支 API 裡最重、最可能在 serverless 環境出狀況的相依——靜態 import 一壞整個
// API 起不來；動態 import 壞了只有那一份文件標 failed。

export const SUPPORTED_TYPES: Record<string, "text" | "pdf" | "docx"> = {
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
  "application/json": "text",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}

export function kindOf(contentType: string, fileName: string): "text" | "pdf" | "docx" | null {
  const ct = contentType.toLowerCase().split(";")[0].trim()
  if (SUPPORTED_TYPES[ct]) return SUPPORTED_TYPES[ct]
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext === "txt" || ext === "md" || ext === "csv" || ext === "json") return "text"
  if (ext === "pdf") return "pdf"
  if (ext === "docx") return "docx"
  return null
}

export class UnsupportedFileError extends Error {
  constructor(public readonly contentType: string) {
    super("unsupported_file_type")
  }
}

/** 抽純文字。掃描 PDF（無文字層）會回空字串，呼叫端要把它當失敗處理。 */
export async function extractText(bytes: Buffer, contentType: string, fileName: string): Promise<string> {
  const kind = kindOf(contentType, fileName)
  if (kind === "text") return bytes.toString("utf8")
  if (kind === "pdf") {
    const { PDFParse } = await import("pdf-parse")
    const parser = new PDFParse({ data: new Uint8Array(bytes) })
    try {
      const r = await parser.getText()
      // pdf-parse 會在頁與頁之間塞 "-- 1 of 3 --"，那不是內容
      return r.text.replace(/\n?-- \d+ of \d+ --\n?/g, "\n")
    } finally {
      await parser.destroy()
    }
  }
  if (kind === "docx") {
    const { default: mammoth } = await import("mammoth")
    const r = await mammoth.extractRawText({ buffer: bytes })
    return r.value
  }
  throw new UnsupportedFileError(contentType)
}

export interface ChunkOptions {
  /** 每塊目標字元數（中文一字一 char；Gemini embedding 上限 2048 tokens，1200 字很安全） */
  maxChars?: number
  /** 相鄰塊重疊字元數，讓跨塊的句子兩邊都找得到 */
  overlap?: number
}

/**
 * 切塊：先照空行分段，段落太長再照句號／換行切，最後硬切。
 * 塊與塊之間帶 overlap（取前一塊的尾巴），中文沒有空白可切所以用標點。
 * 回傳的每塊都 trim 過且非空；整篇空白回 []。
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? 1200
  const overlap = Math.min(opts.overlap ?? 150, Math.floor(maxChars / 3))
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  if (!normalized) return []

  // 1. 先切成不超過 maxChars 的「片」
  const pieces: string[] = []
  for (const para of normalized.split(/\n\s*\n/)) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= maxChars) {
      pieces.push(p)
      continue
    }
    // 段落太長：照句子切（中英文句末標點、換行）
    let buf = ""
    for (const sent of p.split(/(?<=[。！？!?；;\n])/)) {
      if (buf.length + sent.length > maxChars && buf) {
        pieces.push(buf.trim())
        buf = ""
      }
      if (sent.length > maxChars) {
        // 單句仍超長：硬切
        for (let i = 0; i < sent.length; i += maxChars) pieces.push(sent.slice(i, i + maxChars).trim())
        continue
      }
      buf += sent
    }
    if (buf.trim()) pieces.push(buf.trim())
  }

  // 2. 把短片合併到接近 maxChars，減少塊數（塊太碎召回會差）
  const merged: string[] = []
  let cur = ""
  for (const piece of pieces) {
    if (!cur) {
      cur = piece
      continue
    }
    if (cur.length + 1 + piece.length <= maxChars) cur = `${cur}\n${piece}`
    else {
      merged.push(cur)
      cur = piece
    }
  }
  if (cur) merged.push(cur)

  // 3. 加 overlap：每塊前面補上一塊的尾巴
  if (overlap <= 0 || merged.length <= 1) return merged.filter((c) => c.length > 0)
  return merged.map((c, i) => (i === 0 ? c : `${merged[i - 1].slice(-overlap)}\n${c}`)).filter((c) => c.length > 0)
}
