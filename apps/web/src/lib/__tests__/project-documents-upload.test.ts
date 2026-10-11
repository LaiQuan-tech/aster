import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 專案文件上傳（業主 2026-09-30 會議 A 批）：
 *   • 合約掃描檔只收 PDF 與圖片；一般專案文件不限類型
 *   • API 跑在 Vercel serverless，request body 上限約 4.5 MB → ≤ 3 MiB 走 base64、
 *     3～10 MiB 走簽名上傳網址直傳 Storage，> 10 MiB 直接擋
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
  BASE64_UPLOAD_MAX_BYTES,
  CONTRACT_SCAN_ACCEPT,
  CONTRACT_SCAN_TYPE_MESSAGE,
  MAX_DOCUMENT_BYTES,
  getProjectDocuments,
  humanizeDocumentError,
  isContractScanFile,
  uploadContentType,
  uploadProjectDocument,
  visibleProjectDocuments,
  type ProjectDocument,
} from "../projects-api";

const MiB = 1024 * 1024;
const PROJECT = "project-1";
const CONTRACT = "contract-1";

function fileOf(name: string, bytes: number, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function apiError(status: number, code: string): Error {
  return Object.assign(new Error(`[${status}] ${code}`), { status, code });
}

beforeEach(() => {
  h.apiFetch.mockReset();
  h.uploadToSignedUrl.mockReset();
});

describe("合約掃描檔的類型", () => {
  it("isContractScanFile：pdf／jpg／jpeg／png／heic／heif／webp（大小寫不拘）收，其他不收", () => {
    for (const name of ["a.pdf", "a.PDF", "a.jpg", "a.JPEG", "a.png", "a.heic", "a.HEIF", "a.webp"]) {
      expect(isContractScanFile({ name }), name).toBe(true);
    }
    for (const name of ["setup.exe", "a.docx", "a.gif", "a.svg", "a.zip", "scan.pdf.exe", "noext"]) {
      expect(isContractScanFile({ name }), name).toBe(false);
    }
  });

  it("CONTRACT_SCAN_ACCEPT 涵蓋所有收的副檔名與 MIME（給 <input accept> 用）", () => {
    for (const token of [".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", "application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"]) {
      expect(CONTRACT_SCAN_ACCEPT.split(",")).toContain(token);
    }
  });

  it("uploadContentType：瀏覽器沒給（空字串／octet-stream）時依副檔名補；有給就照用；image/jpg 正規化", () => {
    expect(uploadContentType({ name: "IMG_1.HEIC", type: "" })).toBe("image/heic");
    expect(uploadContentType({ name: "scan.pdf", type: "application/octet-stream" })).toBe("application/pdf");
    expect(uploadContentType({ name: "a.jpg", type: "image/jpg" })).toBe("image/jpeg");
    expect(uploadContentType({ name: "a.PNG", type: "image/PNG; charset=binary" })).toBe("image/png");
    expect(uploadContentType({ name: "報告.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(uploadContentType({ name: "圖面.dwg", type: "" })).toBe("application/octet-stream");
  });
});

describe("上傳大小的常數（與後端 BASE64_MAX_BYTES／MAX_BYTES 同步）", () => {
  it("base64 路徑 3 MiB（Vercel request body 約 4.5 MB，base64 膨脹 4/3）、直傳 10 MiB", () => {
    expect(BASE64_UPLOAD_MAX_BYTES).toBe(3 * MiB);
    expect(MAX_DOCUMENT_BYTES).toBe(10 * MiB);
    expect(Math.ceil(BASE64_UPLOAD_MAX_BYTES / 3) * 4).toBeLessThan(4_500_000);
  });
});

describe("uploadProjectDocument — 小檔走 base64", () => {
  it("≤ 3 MiB 一般文件：只打一次 POST /documents，帶 dataBase64、沒有 contractId", async () => {
    h.apiFetch.mockResolvedValue({ id: "d1", sizeBytes: 5 });

    await uploadProjectDocument(PROJECT, fileOf("報告.docx", 5, "application/octet-stream"));

    expect(h.apiFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = h.apiFetch.mock.calls[0]!;
    expect(path).toBe(`/projects/${PROJECT}/documents`);
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ fileName: "報告.docx", contentType: "application/octet-stream", dataBase64: "AAAAAAA=" });
    expect(body).not.toHaveProperty("contractId");
    expect(body).not.toHaveProperty("storagePath");
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("剛好 3 MiB 仍走 base64（分段轉碼不爆呼叫堆疊）", async () => {
    h.apiFetch.mockResolvedValue({ id: "d1", sizeBytes: 3 * MiB });

    await uploadProjectDocument(PROJECT, fileOf("a.pdf", 3 * MiB, "application/pdf"), CONTRACT);

    expect(h.apiFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(h.apiFetch.mock.calls[0]![1].body);
    expect(body.contractId).toBe(CONTRACT);
    expect(body.dataBase64).toHaveLength(Math.ceil((3 * MiB) / 3) * 4);
  });

  it("合約掃描：瀏覽器沒給 MIME 的 .heic 補成 image/heic", async () => {
    h.apiFetch.mockResolvedValue({ id: "d1", sizeBytes: 5 });

    await uploadProjectDocument(PROJECT, fileOf("IMG_0001.HEIC", 5, ""), CONTRACT);

    expect(JSON.parse(h.apiFetch.mock.calls[0]![1].body).contentType).toBe("image/heic");
  });
});

describe("uploadProjectDocument — 擋在送出前", () => {
  it("合約掃描選到 .exe：不送任何請求，訊息說只收 PDF 與圖片", async () => {
    await expect(uploadProjectDocument(PROJECT, fileOf("setup.exe", 10, "application/x-msdownload"), CONTRACT)).rejects.toThrow(
      CONTRACT_SCAN_TYPE_MESSAGE,
    );
    expect(h.apiFetch).not.toHaveBeenCalled();
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("一般文件不受類型限制（.exe 前端不擋；是否收由後端決定）", async () => {
    h.apiFetch.mockResolvedValue({ id: "d1", sizeBytes: 10 });
    await uploadProjectDocument(PROJECT, fileOf("圖面.dwg", 10, ""));
    expect(h.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("超過 10 MiB：不送任何請求，訊息寫明上限", async () => {
    await expect(uploadProjectDocument(PROJECT, fileOf("big.pdf", 10 * MiB + 1, "application/pdf"))).rejects.toThrow("單檔上限 10 MB");
    expect(h.apiFetch).not.toHaveBeenCalled();
  });
});

describe("uploadProjectDocument — 大檔（3～10 MiB）簽名網址直傳 Storage", () => {
  it("取網址 → 直傳（File 帶正確的 type）→ 登記（storagePath、沒有 dataBase64）", async () => {
    h.apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/upload-url")) return { bucket: "project-documents", path: "t/p/uuid.pdf", token: "tok", maxBytes: MAX_DOCUMENT_BYTES };
      return { id: "d1", sizeBytes: 5 * MiB };
    });
    h.uploadToSignedUrl.mockResolvedValue({ data: { path: "t/p/uuid.pdf" }, error: null });

    const res = await uploadProjectDocument(PROJECT, fileOf("大合約.pdf", 5 * MiB, "application/pdf"), CONTRACT);

    expect(res).toEqual({ id: "d1", sizeBytes: 5 * MiB });
    expect(h.apiFetch).toHaveBeenCalledTimes(2);
    // 1) 取網址：帶大小與類型，讓後端在發網址前先驗權限、類型與大小
    const [urlPath, urlOpts] = h.apiFetch.mock.calls[0]!;
    expect(urlPath).toBe(`/projects/${PROJECT}/documents/upload-url`);
    expect(JSON.parse(urlOpts.body)).toEqual({ fileName: "大合約.pdf", contentType: "application/pdf", sizeBytes: 5 * MiB, contractId: CONTRACT });
    // 2) 直傳：bucket／path／token 取自後端；檔案是帶正確 type 的 File
    expect(h.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    const [bucket, path, token, body, options] = h.uploadToSignedUrl.mock.calls[0]!;
    expect([bucket, path, token]).toEqual(["project-documents", "t/p/uuid.pdf", "tok"]);
    expect(body).toBeInstanceOf(File);
    expect((body as File).type).toBe("application/pdf");
    expect((body as File).size).toBe(5 * MiB);
    expect(options).toEqual({ contentType: "application/pdf" });
    // 3) 登記：只帶路徑，檔案內容不再經過 API
    const [docPath, docOpts] = h.apiFetch.mock.calls[1]!;
    expect(docPath).toBe(`/projects/${PROJECT}/documents`);
    const registered = JSON.parse(docOpts.body);
    expect(registered).toEqual({ fileName: "大合約.pdf", contentType: "application/pdf", storagePath: "t/p/uuid.pdf", contractId: CONTRACT });
    expect(registered).not.toHaveProperty("dataBase64");
  });

  it("沒給 MIME 的大 .heic：直傳的 File 與登記都帶 image/heic", async () => {
    h.apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/upload-url") ? { bucket: "b", path: "t/p/u.heic", token: "tok", maxBytes: MAX_DOCUMENT_BYTES } : { id: "d", sizeBytes: 4 * MiB },
    );
    h.uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });

    await uploadProjectDocument(PROJECT, fileOf("IMG_9.HEIC", 4 * MiB, ""), CONTRACT);

    expect((h.uploadToSignedUrl.mock.calls[0]![3] as File).type).toBe("image/heic");
    expect(JSON.parse(h.apiFetch.mock.calls[1]![1].body).contentType).toBe("image/heic");
  });

  it("後端拒發網址（無權限 403）：不嘗試直傳，訊息是中文", async () => {
    h.apiFetch.mockRejectedValue(apiError(403, "forbidden"));

    await expect(uploadProjectDocument(PROJECT, fileOf("a.pdf", 5 * MiB, "application/pdf"), CONTRACT)).rejects.toThrow("沒有上傳權限");
    expect(h.uploadToSignedUrl).not.toHaveBeenCalled();
  });

  it("直傳 Storage 失敗：不登記，訊息帶 Storage 的原因", async () => {
    h.apiFetch.mockResolvedValue({ bucket: "b", path: "t/p/u.pdf", token: "tok", maxBytes: MAX_DOCUMENT_BYTES });
    h.uploadToSignedUrl.mockResolvedValue({ data: null, error: { message: "The object exceeded the maximum allowed size" } });

    await expect(uploadProjectDocument(PROJECT, fileOf("a.pdf", 5 * MiB, "application/pdf"))).rejects.toThrow(
      "檔案傳到儲存空間失敗：The object exceeded the maximum allowed size",
    );
    expect(h.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("登記被後端擋（Storage 實際類型不合格 400）：中文訊息", async () => {
    h.apiFetch
      .mockResolvedValueOnce({ bucket: "b", path: "t/p/u.pdf", token: "tok", maxBytes: MAX_DOCUMENT_BYTES })
      .mockRejectedValueOnce(apiError(400, "unsupported_file_type"));
    h.uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });

    await expect(uploadProjectDocument(PROJECT, fileOf("a.pdf", 5 * MiB, "application/pdf"), CONTRACT)).rejects.toThrow(CONTRACT_SCAN_TYPE_MESSAGE);
  });
});

describe("humanizeDocumentError", () => {
  it("API 錯誤碼翻中文（認 .code，也認 [status] code 格式的訊息）；其他錯誤原樣；不是 Error 用備用訊息", () => {
    expect(humanizeDocumentError(apiError(413, "file_too_large"))).toContain("單檔上限 10 MB");
    expect(humanizeDocumentError(apiError(400, "unsupported_file_type"))).toBe(CONTRACT_SCAN_TYPE_MESSAGE);
    expect(humanizeDocumentError(new Error("[400] contract_not_in_project"))).toContain("不屬於這個專案");
    expect(humanizeDocumentError(new Error("網路中斷"))).toBe("網路中斷");
    expect(humanizeDocumentError("字串", { fallback: "備用" })).toBe("備用");
    expect(humanizeDocumentError("字串")).toBe("上傳失敗");
  });

  it("403 的說法跟著上傳的是什麼：一般專案文件不能講成「合約掃描檔只有經理…」，合約掃描才講窄的授權", () => {
    const general = humanizeDocumentError(apiError(403, "forbidden"));
    expect(general).toContain("專案文件只有該案成員、負責人、所屬部門主管與 HR／會計能上傳");
    expect(general).not.toContain("合約掃描檔");
    expect(humanizeDocumentError(apiError(403, "forbidden"), { contract: true })).toBe("沒有上傳權限（合約掃描檔只有該案經理、承辦與 HR 能上傳）。");
  });

  it("uploadProjectDocument 依上傳類型帶入：一般文件被 403 → 一般說法；合約掃描被 403 → 合約說法", async () => {
    h.apiFetch.mockRejectedValue(apiError(403, "forbidden"));
    await expect(uploadProjectDocument(PROJECT, fileOf("a.docx", 10, ""))).rejects.toThrow("專案文件只有該案成員");
    await expect(uploadProjectDocument(PROJECT, fileOf("a.pdf", 10, "application/pdf"), CONTRACT)).rejects.toThrow(
      "合約掃描檔只有該案經理、承辦與 HR 能上傳",
    );
  });
});

describe("visibleProjectDocuments — 沒權限的人不顯示合約掃描檔", () => {
  const doc = (id: string, contractId: string | null): ProjectDocument => ({
    id, contractId, fileName: `${id}.pdf`, sizeBytes: 1, contentType: "application/pdf", createdAt: "x", url: "u",
  });
  const docs = [doc("general", null), doc("scan", "contract-1")];

  it("無權者：只剩一般文件（就算後端萬一多回了合約掃描檔也濾掉）", () => {
    expect(visibleProjectDocuments(docs, false).map((d) => d.id)).toEqual(["general"]);
  });

  it("有權者：全部顯示", () => {
    expect(visibleProjectDocuments(docs, true).map((d) => d.id)).toEqual(["general", "scan"]);
  });
});

describe("getProjectDocuments — canSeeContractDocs 旗標", () => {
  it("後端明確回 true 才是 true；沒回（舊版後端）或 false 都當 false（寧可少顯示）", async () => {
    h.apiFetch.mockResolvedValueOnce({ documents: [], canSeeContractDocs: true });
    expect((await getProjectDocuments(PROJECT)).canSeeContractDocs).toBe(true);
    h.apiFetch.mockResolvedValueOnce({ documents: [], canSeeContractDocs: false });
    expect((await getProjectDocuments(PROJECT)).canSeeContractDocs).toBe(false);
    h.apiFetch.mockResolvedValueOnce({ documents: [{ id: "d" }] });
    const legacy = await getProjectDocuments(PROJECT);
    expect(legacy.canSeeContractDocs).toBe(false);
    expect(legacy.documents).toEqual([{ id: "d" }]);
  });
});
