import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 知識庫檔案上傳（HR）：
 *   • API 跑在 Vercel serverless，request body 上限約 4.5 MB → ≤ 3 MiB 走 base64、
 *     3～10 MiB 走簽名上傳網址直傳 Storage，> 10 MiB 直接擋（不送任何請求）
 *   • 以前程式與註解寫上限 12 MB，但線上實際只傳得動 3 MB 上下——超過的請求到不了程式
 *   • 錯誤訊息翻成中文
 */

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  uploadToSignedUrl: vi.fn(),
}));

vi.mock("../api-client", () => ({ apiFetch: h.apiFetch }));
vi.mock("../supabase-browser", () => ({
  getSupabaseBrowser: () => ({ storage: { from: (bucket: string) => ({ uploadToSignedUrl: (...args: unknown[]) => h.uploadToSignedUrl(bucket, ...args) }) } }),
}));

import {
  KNOWLEDGE_BASE64_MAX_BYTES,
  KNOWLEDGE_FILE_ACCEPT,
  KNOWLEDGE_MAX_BYTES,
  KNOWLEDGE_SUPPORTED_LABEL,
  humanizeKnowledgeError,
  uploadKnowledgeFile,
} from "../knowledge-api";

const MiB = 1024 * 1024;

function fileOf(name: string, bytes: number, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function apiError(status: number, code: string): Error {
  return Object.assign(new Error(`[${status}] ${code}`), { status, code });
}

const CREATED = { document: { id: "k1", title: "規章" }, index: { status: "indexed", chunks: 3 } };

beforeEach(() => {
  h.apiFetch.mockReset();
  h.uploadToSignedUrl.mockReset();
});

describe("上傳大小的常數（與後端 knowledge.ts 的 BASE64_MAX_BYTES／MAX_BYTES 同步）", () => {
  it("base64 路徑 3 MiB（Vercel request body 約 4.5 MB，base64 膨脹 4/3）、直傳 10 MiB", () => {
    expect(KNOWLEDGE_BASE64_MAX_BYTES).toBe(3 * MiB);
    expect(KNOWLEDGE_MAX_BYTES).toBe(10 * MiB);
    expect(Math.ceil(KNOWLEDGE_BASE64_MAX_BYTES / 3) * 4).toBeLessThan(4_500_000);
  });

  it("收的檔案類型：txt／md／csv／json／pdf／docx（給 <input accept> 與說明文字用）", () => {
    for (const ext of ["txt", "md", "csv", "json", "pdf", "docx"]) {
      expect(KNOWLEDGE_FILE_ACCEPT.split(",")).toContain(`.${ext}`);
      expect(KNOWLEDGE_SUPPORTED_LABEL).toContain(ext);
    }
  });
});

describe("uploadKnowledgeFile — 小檔走 base64", () => {
  it("≤ 3 MiB：只打一次 POST /knowledge/documents，帶 dataBase64、沒有 storagePath、不要簽名網址", async () => {
    h.apiFetch.mockResolvedValue(CREATED);

    const res = await uploadKnowledgeFile(fileOf("規章.docx", 5, "application/octet-stream"));

    expect(res).toEqual(CREATED);
    expect(h.apiFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = h.apiFetch.mock.calls[0]!;
    expect(path).toBe("/knowledge/documents");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ kind: "file", fileName: "規章.docx", contentType: "application/octet-stream", dataBase64: "AAAAAAA=" });
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("剛好 3 MiB 仍走 base64（分段轉碼不爆呼叫堆疊）；瀏覽器沒給 MIME 時補 octet-stream；有給標題就帶", async () => {
    h.apiFetch.mockResolvedValue(CREATED);

    await uploadKnowledgeFile(fileOf("筆記.md", 3 * MiB, ""), "我的筆記");

    expect(h.apiFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(h.apiFetch.mock.calls[0]![1].body);
    expect(body.title).toBe("我的筆記");
    expect(body.contentType).toBe("application/octet-stream");
    expect(body.dataBase64).toHaveLength(Math.ceil((3 * MiB) / 3) * 4);
  });
});

describe("uploadKnowledgeFile — 大檔（3～10 MiB）簽名網址直傳 Storage", () => {
  it("取網址 → 直傳（File 帶正確的 type）→ 建檔（只帶 storagePath，檔案內容不再經過 API）", async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/upload-url")) return { bucket: "knowledge-files", path: "t/uuid.pdf", token: "tok", maxBytes: KNOWLEDGE_MAX_BYTES };
      return CREATED;
    });
    h.uploadToSignedUrl.mockResolvedValue({ data: { path: "t/uuid.pdf" }, error: null });

    const res = await uploadKnowledgeFile(fileOf("年度報告.pdf", 6 * MiB, "application/pdf"), "年度報告");

    expect(res).toEqual(CREATED);
    expect(h.apiFetch).toHaveBeenCalledTimes(2);
    // 1) 取網址：帶大小與類型，讓後端在發網址前先驗權限、類型與大小
    const [urlPath, urlOpts] = h.apiFetch.mock.calls[0]!;
    expect(urlPath).toBe("/knowledge/documents/upload-url");
    expect(JSON.parse(urlOpts.body)).toEqual({ fileName: "年度報告.pdf", contentType: "application/pdf", sizeBytes: 6 * MiB });
    // 2) 直傳：bucket／path／token 取自後端；檔案是帶正確 type 的 File
    expect(h.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    const [bucket, path, token, body, options] = h.uploadToSignedUrl.mock.calls[0]!;
    expect([bucket, path, token]).toEqual(["knowledge-files", "t/uuid.pdf", "tok"]);
    expect(body).toBeInstanceOf(File);
    expect((body as File).type).toBe("application/pdf");
    expect((body as File).size).toBe(6 * MiB);
    expect(options).toEqual({ contentType: "application/pdf" });
    // 3) 建檔：只帶路徑
    const [docPath, docOpts] = h.apiFetch.mock.calls[1]!;
    expect(docPath).toBe("/knowledge/documents");
    const registered = JSON.parse(docOpts.body);
    expect(registered).toEqual({ kind: "file", fileName: "年度報告.pdf", contentType: "application/pdf", storagePath: "t/uuid.pdf", title: "年度報告" });
    expect(registered).not.toHaveProperty("dataBase64");
  });

  it("剛好 10 MiB 可以直傳；多 1 byte → 不送任何請求，訊息寫明上限", async () => {
    h.apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/upload-url") ? { bucket: "knowledge-files", path: "t/u.pdf", token: "tok", maxBytes: KNOWLEDGE_MAX_BYTES } : CREATED,
    );
    h.uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });
    await uploadKnowledgeFile(fileOf("a.pdf", 10 * MiB, "application/pdf"));
    expect(h.apiFetch).toHaveBeenCalledTimes(2);

    h.apiFetch.mockClear();
    h.uploadToSignedUrl.mockClear();
    await expect(uploadKnowledgeFile(fileOf("b.pdf", 10 * MiB + 1, "application/pdf"))).rejects.toThrow("單檔上限 10 MB");
    expect(h.apiFetch).not.toHaveBeenCalled();
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("後端拒發網址（不支援的類型 400）：不嘗試直傳，訊息是中文並列出支援的類型", async () => {
    h.apiFetch.mockRejectedValue(apiError(400, "unsupported_file_type"));

    await expect(uploadKnowledgeFile(fileOf("簡報.pptx", 5 * MiB, "application/vnd.ms-powerpoint"))).rejects.toThrow("不支援的檔案類型");
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled();
    await expect(uploadKnowledgeFile(fileOf("簡報.pptx", 5 * MiB, ""))).rejects.toThrow(KNOWLEDGE_SUPPORTED_LABEL);
  });

  it("後端拒發網址（非 HR 403）：不嘗試直傳，說只有 HR 能新增", async () => {
    h.apiFetch.mockRejectedValue(apiError(403, "forbidden"));

    await expect(uploadKnowledgeFile(fileOf("a.pdf", 5 * MiB, "application/pdf"))).rejects.toThrow("只有 HR");
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("直傳 Storage 失敗：不建檔，訊息帶 Storage 的原因", async () => {
    h.apiFetch.mockResolvedValue({ bucket: "knowledge-files", path: "t/u.pdf", token: "tok", maxBytes: KNOWLEDGE_MAX_BYTES });
    h.uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: "The object exceeded the maximum allowed size" } });

    await expect(uploadKnowledgeFile(fileOf("a.pdf", 5 * MiB, "application/pdf"))).rejects.toThrow(
      "檔案傳到儲存空間失敗：The object exceeded the maximum allowed size",
    );
    expect(h.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("建檔被後端擋（Storage 實際類型不合格 400／太大 413）：中文訊息", async () => {
    h.apiFetch
      .mockResolvedValueOnce({ bucket: "knowledge-files", path: "t/u.pdf", token: "tok", maxBytes: KNOWLEDGE_MAX_BYTES })
      .mockRejectedValueOnce(apiError(413, "file_too_large"));
    h.uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });

    await expect(uploadKnowledgeFile(fileOf("a.pdf", 5 * MiB, "application/pdf"))).rejects.toThrow("單檔上限 10 MB");
  });
});

describe("uploadKnowledgeFile — 空檔", () => {
  it("0 bytes 的檔案：不送任何請求（以前會被後端 invalid_body 擋掉，畫面顯示英文原碼），訊息說檔案是空的", async () => {
    await expect(uploadKnowledgeFile(fileOf("空.txt", 0, "text/plain"))).rejects.toThrow("檔案是空的");
    expect(h.apiFetch).not.toHaveBeenCalled();
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled();
  });
});

describe("humanizeKnowledgeError", () => {
  it("API 錯誤碼翻中文（認 .code，也認 [status] code 格式的訊息）；其他錯誤原樣；不是 Error 用備用訊息", () => {
    expect(humanizeKnowledgeError(apiError(413, "file_too_large"))).toContain("單檔上限 10 MB");
    expect(humanizeKnowledgeError(new Error("[400] unsupported_file_type"))).toContain("不支援的檔案類型");
    expect(humanizeKnowledgeError(apiError(400, "upload_not_found"))).toContain("沒有傳完整");
    expect(humanizeKnowledgeError(apiError(400, "invalid_storage_path"))).toContain("重新上傳");
    expect(humanizeKnowledgeError(apiError(409, "already_registered"))).toContain("已經上傳過");
    // 後端欄位驗證失敗（例如檔名超過 200 字）不再顯示英文原碼
    expect(humanizeKnowledgeError(apiError(400, "invalid_body"))).toContain("上傳內容不完整");
    expect(humanizeKnowledgeError(apiError(400, "invalid_body"))).not.toContain("invalid_body");
    expect(humanizeKnowledgeError(new Error("網路中斷"))).toBe("網路中斷");
    expect(humanizeKnowledgeError("字串", "備用")).toBe("備用");
    expect(humanizeKnowledgeError("字串")).toBe("上傳失敗");
  });
});
