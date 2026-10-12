import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 上傳前準備（2026-10-12 教育訓練驗收第 13 條）：
 *   • 報銷憑證、請假附件以 base64 隨 JSON 送，API 跑在 Vercel（請求上限約 4.5 MB）→ 準備後單檔 ≤ 3 MiB
 *   • 照片長邊縮到 2000px、轉 JPEG 0.8（EXIF 方向轉正、透明鋪白底）；GIF／SVG 不壓；
 *     解不開或壓完沒有比較小 → 用原檔；非圖片超過 3 MB → 前端擋下、不送任何請求
 *   • 報銷：先準備憑證 → 建單 → 上傳；準備失敗不建單、上傳失敗自動撤回剛建的單
 * ⚠️ 識別碼、檔名都是明顯的假值（repo 是公開的）。
 */

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../api-client", () => ({ apiFetch: h.apiFetch }));

import {
  COMPRESSED_TOO_LARGE_MESSAGE,
  EMPTY_FILE_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  IMAGE_MAX_EDGE,
  IMAGE_SOURCE_MAX_BYTES,
  IMAGE_SOURCE_TOO_LARGE_MESSAGE,
  JPEG_QUALITY,
  UNCOMPRESSIBLE_TOO_LARGE_MESSAGE,
  UPLOAD_MAX_BYTES,
  UploadPrepError,
  createThenUpload,
  jpegFileName,
  pickedFileError,
  pickedFilesError,
  preferCompressed,
  prepareUploadFile,
  targetSize,
  uploadKindOf,
  type DecodedImage,
  type ImageCodec,
} from "../upload-prep";
import { cancelExpense, fileExpense, uploadAttachment, uploadExpenseReceipt } from "../ess-api";
import { NETWORK_FAILURE_MESSAGE, RECEIPT_AUTO_CANCEL_REASON, receiptUploadFailedMessage } from "../advance-view";

const MiB = 1024 * 1024;

function fileOf(name: string, bytes: number, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** 假的解碼器：記下呼叫，解出指定尺寸、輸出指定大小的 JPEG。 */
function fakeCodec(
  opts: { width?: number; height?: number; jpegBytes?: number; decodeFails?: boolean; encodeFails?: boolean } = {},
) {
  const release = vi.fn();
  const decode = vi.fn(async (_file: Blob): Promise<DecodedImage> => {
    if (opts.decodeFails) throw new Error("decode failed");
    return { width: opts.width ?? 4032, height: opts.height ?? 3024, source: {} as CanvasImageSource, release };
  });
  const toJpeg = vi.fn(
    async (_image: DecodedImage, _width: number, _height: number, _quality: number): Promise<Blob | null> =>
      opts.encodeFails ? null : new Blob([new Uint8Array(opts.jpegBytes ?? 600_000)], { type: "image/jpeg" }),
  );
  const codec: ImageCodec = { decode, toJpeg };
  return { codec, decode, toJpeg, release };
}

/** ess-api 用 FileReader.readAsDataURL 轉 base64；Node 沒有 FileReader，換成同樣行為的假的。 */
class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob): void {
    blob.arrayBuffer().then(
      (buf) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`;
        this.onload?.();
      },
      () => this.onerror?.(),
    );
  }
}

beforeEach(() => {
  h.apiFetch.mockReset();
  vi.stubGlobal("FileReader", FakeFileReader);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("上限與常數", () => {
  it("單檔 3 MiB：base64 膨脹 4/3 後仍在 Vercel 約 4.5 MB 的請求上限內；照片原檔寬鬆上限 25 MiB；長邊 2000、JPEG 0.8", () => {
    expect(UPLOAD_MAX_BYTES).toBe(3 * MiB);
    expect(Math.ceil(UPLOAD_MAX_BYTES / 3) * 4).toBeLessThan(4_500_000);
    expect(IMAGE_SOURCE_MAX_BYTES).toBe(25 * MiB);
    expect(IMAGE_MAX_EDGE).toBe(2000);
    expect(JPEG_QUALITY).toBe(0.8);
  });
});

describe("uploadKindOf（要不要壓）", () => {
  it("image/*（JPEG／PNG／WebP／HEIC…）壓；GIF、SVG 不壓；PDF 等非圖片不壓", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "IMAGE/JPEG"]) {
      expect(uploadKindOf({ name: "x", type })).toBe("compress");
    }
    expect(uploadKindOf({ name: "a.gif", type: "image/gif" })).toBe("keep-image");
    expect(uploadKindOf({ name: "a.svg", type: "image/svg+xml" })).toBe("keep-image");
    expect(uploadKindOf({ name: "a.pdf", type: "application/pdf" })).toBe("other");
    expect(uploadKindOf({ name: "a.txt", type: "text/plain" })).toBe("other");
  });

  it("瀏覽器沒給類型或給 octet-stream（Windows 上的 .heic）→ 看副檔名", () => {
    expect(uploadKindOf({ name: "IMG_0001.HEIC", type: "" })).toBe("compress");
    expect(uploadKindOf({ name: "photo.jpg", type: "application/octet-stream" })).toBe("compress");
    expect(uploadKindOf({ name: "anim.gif", type: "" })).toBe("keep-image");
    expect(uploadKindOf({ name: "doc.pdf", type: null })).toBe("other");
    expect(uploadKindOf({ name: "noext", type: "" })).toBe("other");
  });
});

describe("targetSize（長邊縮到 2000px）", () => {
  it("橫式、直式、手機截圖：長邊剛好 2000、等比、四捨五入", () => {
    expect(targetSize(4032, 3024)).toEqual({ width: 2000, height: 1500 });
    expect(targetSize(3024, 4032)).toEqual({ width: 1500, height: 2000 });
    expect(targetSize(1170, 2532)).toEqual({ width: 924, height: 2000 });
    expect(targetSize(8064, 6048)).toEqual({ width: 2000, height: 1500 });
  });

  it("本來就不超過 2000 → 原尺寸；極細長的圖短邊至少 1px；可指定別的長邊", () => {
    expect(targetSize(2000, 1000)).toEqual({ width: 2000, height: 1000 });
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(targetSize(10000, 3)).toEqual({ width: 2000, height: 1 });
    expect(targetSize(3000, 1500, 1000)).toEqual({ width: 1000, height: 500 });
  });
});

describe("jpegFileName（檔名改 .jpg）", () => {
  it("換掉副檔名、沒有就補上", () => {
    expect(jpegFileName("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
    expect(jpegFileName("收據.png")).toBe("收據.jpg");
    expect(jpegFileName("photo.jpeg")).toBe("photo.jpg");
    expect(jpegFileName("a.b.webp")).toBe("a.b.jpg");
    expect(jpegFileName("scan")).toBe("scan.jpg");
    expect(jpegFileName(".png")).toBe("photo.jpg");
  });
});

describe("pickedFileError／pickedFilesError（選檔當下的大小判斷）", () => {
  it("非圖片（PDF）與不壓的圖（GIF）：剛好 3 MiB 可以、多 1 byte 就擋", () => {
    expect(pickedFileError({ name: "a.pdf", type: "application/pdf", size: 3 * MiB })).toBeNull();
    expect(pickedFileError({ name: "a.pdf", type: "application/pdf", size: 3 * MiB + 1 })).toBe(FILE_TOO_LARGE_MESSAGE);
    expect(pickedFileError({ name: "a.gif", type: "image/gif", size: 3 * MiB + 1 })).toBe(FILE_TOO_LARGE_MESSAGE);
    expect(FILE_TOO_LARGE_MESSAGE).toContain("3 MB");
  });

  it("會壓縮的照片不拿原始大小套 3 MB，只擋原檔超過 25 MB 的；空檔一律擋", () => {
    expect(pickedFileError({ name: "IMG.jpg", type: "image/jpeg", size: 12 * MiB })).toBeNull();
    expect(pickedFileError({ name: "IMG.jpg", type: "image/jpeg", size: 25 * MiB })).toBeNull();
    expect(pickedFileError({ name: "IMG.jpg", type: "image/jpeg", size: 25 * MiB + 1 })).toBe(IMAGE_SOURCE_TOO_LARGE_MESSAGE);
    expect(pickedFileError({ name: "a.pdf", type: "application/pdf", size: 0 })).toBe(EMPTY_FILE_MESSAGE);
  });

  it("多個附件：回第一個有問題的，兩個以上時加檔名；都沒問題 → null", () => {
    const photo = { name: "IMG.jpg", type: "image/jpeg", size: 8 * MiB };
    const bigPdf = { name: "報告.pdf", type: "application/pdf", size: 4 * MiB };
    expect(pickedFilesError([photo, bigPdf])).toBe(`「報告.pdf」${FILE_TOO_LARGE_MESSAGE}`);
    expect(pickedFilesError([bigPdf])).toBe(FILE_TOO_LARGE_MESSAGE);
    expect(pickedFilesError([photo])).toBeNull();
    expect(pickedFilesError([])).toBeNull();
  });
});

describe("preferCompressed（壓完沒有比較小就用原檔）", () => {
  it("比原檔小才用；一樣大或更大 → 原檔", () => {
    const original = { name: "a.png", type: "image/png", size: 200_000 };
    expect(preferCompressed(original, { size: 150_000 })).toBe(true);
    expect(preferCompressed(original, { size: 200_000 })).toBe(false);
    expect(preferCompressed(original, { size: 260_000 })).toBe(false);
  });

  it("例外：HEIC 多數瀏覽器看不了，JPEG 只要在 3 MB 內就用 JPEG", () => {
    const heic = { name: "IMG_0001.HEIC", type: "image/heic", size: 200_000 };
    expect(preferCompressed(heic, { size: 260_000 })).toBe(true);
    expect(preferCompressed({ ...heic, size: 2 * MiB }, { size: 3 * MiB + 1 })).toBe(false);
  });
});

describe("prepareUploadFile（假解碼器）", () => {
  it("壓縮成功：4032×3024 → 2000×1500、品質 0.8，回 .jpg／image/jpeg 的新檔；解碼結果有釋放", async () => {
    const { codec, toJpeg, release } = fakeCodec({ width: 4032, height: 3024, jpegBytes: 600_000 });
    const original = fileOf("IMG_0001.jpeg", 5 * MiB, "image/jpeg");

    const out = await prepareUploadFile(original, codec);

    expect(toJpeg).toHaveBeenCalledTimes(1);
    expect(toJpeg.mock.calls[0]!.slice(1)).toEqual([2000, 1500, 0.8]);
    expect(out).not.toBe(original);
    expect(out.name).toBe("IMG_0001.jpg");
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBe(600_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("小圖也轉 JPEG（不放大）：PNG 截圖 800×600 → 800×600", async () => {
    const { codec, toJpeg } = fakeCodec({ width: 800, height: 600, jpegBytes: 90_000 });
    const out = await prepareUploadFile(fileOf("截圖.png", 400_000, "image/png"), codec);
    expect(toJpeg.mock.calls[0]!.slice(1)).toEqual([800, 600, 0.8]);
    expect(out.name).toBe("截圖.jpg");
  });

  it("解碼失敗（例如 Chrome 上的 HEIC）→ 用原檔；原檔超過 3 MB 才擋", async () => {
    const small = fileOf("IMG_0002.HEIC", 2 * MiB, "image/heic");
    const { codec, toJpeg } = fakeCodec({ decodeFails: true });
    await expect(prepareUploadFile(small, codec)).resolves.toBe(small);
    expect(toJpeg).not.toHaveBeenCalled();

    const big = fileOf("IMG_0003.HEIC", 4 * MiB, "image/heic");
    await expect(prepareUploadFile(big, fakeCodec({ decodeFails: true }).codec)).rejects.toThrow(UNCOMPRESSIBLE_TOO_LARGE_MESSAGE);
  });

  it("畫不出來（toJpeg 回 null）→ 用原檔", async () => {
    const original = fileOf("IMG.png", 1 * MiB, "image/png");
    await expect(prepareUploadFile(original, fakeCodec({ encodeFails: true }).codec)).resolves.toBe(original);
  });

  it("壓完反而更大 → 用原檔", async () => {
    const original = fileOf("logo.png", 200_000, "image/png");
    const { codec, toJpeg } = fakeCodec({ width: 600, height: 400, jpegBytes: 260_000 });
    await expect(prepareUploadFile(original, codec)).resolves.toBe(original);
    expect(toJpeg).toHaveBeenCalledTimes(1);
  });

  it("壓縮後仍超過 3 MB → 擋（UploadPrepError，中文訊息、沒有錯誤碼）", async () => {
    const original = fileOf("IMG.jpg", 6 * MiB, "image/jpeg");
    const err = await prepareUploadFile(original, fakeCodec({ jpegBytes: 3 * MiB + 1 }).codec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadPrepError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(COMPRESSED_TOO_LARGE_MESSAGE);
    expect((err as { code?: unknown }).code).toBeUndefined();
  });

  it("非圖片超過 3 MB → 擋，不解碼；3 MB 內 → 原檔照用", async () => {
    const { codec, decode } = fakeCodec();
    await expect(prepareUploadFile(fileOf("報告.pdf", 3 * MiB + 1, "application/pdf"), codec)).rejects.toThrow(FILE_TOO_LARGE_MESSAGE);
    const pdf = fileOf("報告.pdf", 3 * MiB, "application/pdf");
    await expect(prepareUploadFile(pdf, codec)).resolves.toBe(pdf);
    expect(decode).not.toHaveBeenCalled();
  });

  it("GIF／SVG 不壓（可能是動圖、向量圖）", async () => {
    const { codec, decode } = fakeCodec();
    const gif = fileOf("anim.gif", 500_000, "image/gif");
    await expect(prepareUploadFile(gif, codec)).resolves.toBe(gif);
    expect(decode).not.toHaveBeenCalled();
  });

  it("照片原檔超過 25 MB → 直接擋，不解碼（手機上解碼可能吃光記憶體）；空檔也擋", async () => {
    const { codec, decode } = fakeCodec();
    await expect(prepareUploadFile(fileOf("huge.jpg", 25 * MiB + 1, "image/jpeg"), codec)).rejects.toThrow(IMAGE_SOURCE_TOO_LARGE_MESSAGE);
    await expect(prepareUploadFile(fileOf("empty.pdf", 0, "application/pdf"), codec)).rejects.toThrow(EMPTY_FILE_MESSAGE);
    expect(decode).not.toHaveBeenCalled();
  });

  it("同一個檔再準備一次不重壓（報銷頁先準備、上傳時又經過）；準備好的結果再準備 → 原樣", async () => {
    const { codec, decode } = fakeCodec();
    const original = fileOf("IMG_0004.jpg", 5 * MiB, "image/jpeg");
    const first = await prepareUploadFile(original, codec);
    expect(await prepareUploadFile(original, codec)).toBe(first);
    expect(await prepareUploadFile(first, codec)).toBe(first);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------ 瀏覽器實作（stub） --- */

type BitmapStub = { width: number; height: number } | "type-error" | "decode-error";
type ImageStub = { width: number; height: number } | "decode-error";

/** 用假的 createImageBitmap／Image／canvas 跑預設的 browserImageCodec，記下畫圖的順序。 */
function stubBrowser(opts: { bitmap?: BitmapStub; image?: ImageStub; jpegBytes?: number; outputType?: string }) {
  const log: string[] = [];
  const close = vi.fn();
  const createImageBitmap = vi.fn(async (_source: Blob, _options?: ImageBitmapOptions) => {
    if (opts.bitmap === "type-error") throw new TypeError("not a valid enum value of type ImageOrientation");
    if (!opts.bitmap || opts.bitmap === "decode-error") throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    return { width: opts.bitmap.width, height: opts.bitmap.height, close };
  });
  class FakeImage {
    src = "";
    naturalWidth = 0;
    naturalHeight = 0;
    async decode(): Promise<void> {
      if (!opts.image || opts.image === "decode-error") throw new DOMException("The source image cannot be decoded.", "EncodingError");
      this.naturalWidth = opts.image.width;
      this.naturalHeight = opts.image.height;
    }
  }
  const ctx = {
    fillStyle: "",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    fillRect: vi.fn((x: number, y: number, w: number, hgt: number) => log.push(`fillRect ${ctx.fillStyle} ${x},${y},${w},${hgt}`)),
    drawImage: vi.fn((_src: unknown, x: number, y: number, w: number, hgt: number) => log.push(`drawImage ${x},${y},${w},${hgt}`)),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn((_kind: string) => ctx),
    toBlob: vi.fn((cb: (blob: Blob | null) => void, type: string, quality: number) => {
      log.push(`toBlob ${canvas.width}x${canvas.height} ${type} ${quality}`);
      cb(new Blob([new Uint8Array(opts.jpegBytes ?? 500_000)], { type: opts.outputType ?? type }));
    }),
  };
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("createImageBitmap", createImageBitmap);
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", { createElement: vi.fn((_tag: string) => canvas) });
  return { log, close, createImageBitmap, ctx, canvas, createObjectURL, revokeObjectURL };
}

describe("browserImageCodec（預設實作，stub 瀏覽器 API）", () => {
  it("createImageBitmap 帶 imageOrientation: from-image（照 EXIF 轉正）；先鋪白底再畫（透明 PNG 不變黑）；輸出 JPEG 0.8", async () => {
    const b = stubBrowser({ bitmap: { width: 4032, height: 3024 }, jpegBytes: 500_000 });
    const original = fileOf("IMG_0005.png", 5 * MiB, "image/png");

    const out = await prepareUploadFile(original);

    expect(b.createImageBitmap).toHaveBeenCalledWith(original, { imageOrientation: "from-image" });
    expect(b.log).toEqual([
      "fillRect #ffffff 0,0,2000,1500",
      "drawImage 0,0,2000,1500",
      "toBlob 2000x1500 image/jpeg 0.8",
    ]);
    expect(b.ctx.imageSmoothingQuality).toBe("high");
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(b.canvas.width).toBe(0); // 用完歸零，釋放 canvas 記憶體
    expect(out.name).toBe("IMG_0005.jpg");
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBe(500_000);
  });

  it("不認得 from-image 的瀏覽器（TypeError）→ 改用 <img> 解碼（一樣照 EXIF 轉正），用完 revoke 網址", async () => {
    const b = stubBrowser({ bitmap: "type-error", image: { width: 3000, height: 4000 } });
    const out = await prepareUploadFile(fileOf("IMG_0006.jpg", 4 * MiB, "image/jpeg"));
    expect(b.log).toContain("toBlob 1500x2000 image/jpeg 0.8");
    expect(b.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    expect(out.name).toBe("IMG_0006.jpg");
  });

  it("兩條路都解不開（非 Safari 的 HEIC）→ 用原檔；超過 3 MB 才擋", async () => {
    const b = stubBrowser({ bitmap: "decode-error", image: "decode-error" });
    const heic = fileOf("IMG_0007.HEIC", 2 * MiB, "image/heic");
    await expect(prepareUploadFile(heic)).resolves.toBe(heic);
    expect(b.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    await expect(prepareUploadFile(fileOf("IMG_0008.HEIC", 4 * MiB, "image/heic"))).rejects.toThrow(UNCOMPRESSIBLE_TOO_LARGE_MESSAGE);
  });

  it("canvas 給不出 JPEG（回 PNG）→ 當作失敗、用原檔，免得檔名 .jpg 內容卻是 PNG", async () => {
    stubBrowser({ bitmap: { width: 1000, height: 800 }, outputType: "image/png" });
    const original = fileOf("IMG_0009.jpg", 1 * MiB, "image/jpeg");
    await expect(prepareUploadFile(original)).resolves.toBe(original);
  });

  it("沒有任何瀏覽器 API（伺服器端／測試環境）→ 不壞，用原檔", async () => {
    const original = fileOf("IMG_0010.jpg", 1 * MiB, "image/jpeg");
    await expect(prepareUploadFile(original)).resolves.toBe(original);
  });
});

/* ------------------------------------------- ess-api 的兩個上傳函式 --- */

describe("uploadAttachment／uploadExpenseReceipt：送出前一律經過準備", () => {
  it("非圖片超過 3 MB → 丟中文錯誤、不送任何請求（請假送出與補傳都走 uploadAttachment）", async () => {
    const pdf = () => fileOf("診斷證明.pdf", 3 * MiB + 1, "application/pdf");
    await expect(uploadAttachment("req-1", pdf())).rejects.toThrow(FILE_TOO_LARGE_MESSAGE);
    await expect(uploadExpenseReceipt("claim-1", pdf())).rejects.toThrow(FILE_TOO_LARGE_MESSAGE);
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("3 MB 內的 PDF：照原檔送 base64（去掉 data: 前綴）", async () => {
    h.apiFetch.mockResolvedValue({ id: "att-1" });
    await uploadAttachment("req-1", new File(["%PDF-1.4"], "收據.pdf", { type: "application/pdf" }));
    expect(h.apiFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = h.apiFetch.mock.calls[0]!;
    expect(path).toBe("/requests/req-1/attachments");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      fileName: "收據.pdf",
      contentType: "application/pdf",
      dataBase64: Buffer.from("%PDF-1.4").toString("base64"),
    });
  });

  it("照片：送出的是壓縮後的 JPEG（檔名 .jpg、image/jpeg、內容是壓縮結果）", async () => {
    stubBrowser({ bitmap: { width: 4032, height: 3024 }, jpegBytes: 700_000 });
    h.apiFetch.mockResolvedValue({ id: "att-2" });
    await uploadExpenseReceipt("claim-1", fileOf("IMG_0011.HEIC", 6 * MiB, "image/heic"));
    const [path, opts] = h.apiFetch.mock.calls[0]!;
    expect(path).toBe("/expenses/claim-1/attachments");
    const body = JSON.parse(opts.body);
    expect(body.fileName).toBe("IMG_0011.jpg");
    expect(body.contentType).toBe("image/jpeg");
    expect(Buffer.from(body.dataBase64, "base64").length).toBe(700_000);
  });
});

/* ---------------------------------------------- 報銷頁的建單＋憑證 --- */

describe("createThenUpload（報銷頁：先準備憑證 → 建單 → 上傳，失敗自動撤回）", () => {
  const steps = () => {
    const order: string[] = [];
    return {
      order,
      create: vi.fn(async () => {
        order.push("create");
        return { id: "claim-1", period: "2026-10" };
      }),
      upload: vi.fn(async (_created: { id: string }, _file: File) => {
        order.push("upload");
      }),
      rollback: vi.fn(async (_created: { id: string }) => {
        order.push("rollback");
      }),
    };
  };

  it("憑證準備失敗（PDF 超過 3 MB）→ 不建單、不上傳", async () => {
    const s = steps();
    const result = await createThenUpload({ file: fileOf("a.pdf", 3 * MiB + 1, "application/pdf"), ...s });
    expect(result).toMatchObject({ ok: false, stage: "prepare" });
    expect(!result.ok && result.error).toBeInstanceOf(UploadPrepError);
    expect(s.create).not.toHaveBeenCalled();
    expect(s.upload).not.toHaveBeenCalled();
  });

  it("建單失敗 → 不上傳、不撤回", async () => {
    const s = steps();
    s.create.mockRejectedValueOnce(new Error("[409] period_settled"));
    const result = await createThenUpload({ file: fileOf("a.pdf", 10, "application/pdf"), ...s });
    expect(result).toMatchObject({ ok: false, stage: "create" });
    expect(s.upload).not.toHaveBeenCalled();
    expect(s.rollback).not.toHaveBeenCalled();
  });

  it("上傳失敗 → 自動撤回剛建的單（rolledBack: true）", async () => {
    const s = steps();
    s.upload.mockImplementationOnce(async () => {
      s.order.push("upload");
      throw new TypeError("Failed to fetch");
    });
    const result = await createThenUpload({ file: fileOf("a.pdf", 10, "application/pdf"), ...s });
    expect(s.order).toEqual(["create", "upload", "rollback"]);
    expect(s.rollback).toHaveBeenCalledWith({ id: "claim-1", period: "2026-10" });
    expect(result).toMatchObject({ ok: false, stage: "upload", rolledBack: true, created: { id: "claim-1" } });
  });

  it("上傳失敗、撤回也失敗 → rolledBack: false（單還在，畫面請員工自己撤回）", async () => {
    const s = steps();
    s.upload.mockRejectedValueOnce(new Error("[500] boom"));
    s.rollback.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await createThenUpload({ file: fileOf("a.pdf", 10, "application/pdf"), ...s });
    expect(result).toMatchObject({ ok: false, stage: "upload", rolledBack: false });

    // 撤回同步丟錯也一樣回結果、不往外丟
    const s2 = steps();
    s2.upload.mockRejectedValueOnce(new Error("[500] boom"));
    const result2 = await createThenUpload({
      file: fileOf("a.pdf", 10, "application/pdf"),
      create: s2.create,
      upload: s2.upload,
      rollback: () => {
        throw new Error("sync");
      },
    });
    expect(result2).toMatchObject({ ok: false, stage: "upload", rolledBack: false });
  });

  it("成功：先準備再建單，上傳的是準備好的檔；沒附檔就只建單", async () => {
    const s = steps();
    const prepared = fileOf("IMG.jpg", 100, "image/jpeg");
    const prepare = vi.fn(async (_file: File) => {
      s.order.push("prepare");
      return prepared;
    });
    const result = await createThenUpload({ file: fileOf("IMG.HEIC", 5 * MiB, "image/heic"), prepare, ...s });
    expect(result).toEqual({ ok: true, created: { id: "claim-1", period: "2026-10" } });
    expect(s.order).toEqual(["prepare", "create", "upload"]);
    expect(s.upload.mock.calls[0]![1]).toBe(prepared);

    const s2 = steps();
    expect(await createThenUpload({ file: null, ...s2 })).toMatchObject({ ok: true });
    expect(s2.order).toEqual(["create"]);
  });

  it("接上真正的 ess-api（同報銷頁的接法）：PDF 超過 3 MB → 一個請求都沒送（沒建單）", async () => {
    const result = await createThenUpload({
      file: fileOf("發票.pdf", 3 * MiB + 1, "application/pdf"),
      create: () => fileExpense({ categoryId: "cat-1", amount: 100, incurredOn: "2026-10-12" }),
      upload: (claim, file) => uploadExpenseReceipt(claim.id, file),
      rollback: (claim) => cancelExpense(claim.id, RECEIPT_AUTO_CANCEL_REASON),
    });
    expect(result).toMatchObject({ ok: false, stage: "prepare" });
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("接上真正的 ess-api：上傳 Failed to fetch → PATCH 撤回剛建的單；畫面訊息說已自動撤回", async () => {
    h.apiFetch
      .mockResolvedValueOnce({ id: "claim-9", period: "2026-10", nature: "reimbursement" }) // POST /expenses
      .mockRejectedValueOnce(new TypeError("Failed to fetch")) // POST /expenses/claim-9/attachments
      .mockResolvedValueOnce({ id: "claim-9" }); // PATCH /expenses/claim-9
    const result = await createThenUpload({
      file: new File(["%PDF-1.4"], "發票.pdf", { type: "application/pdf" }),
      create: () => fileExpense({ categoryId: "cat-1", amount: 100, incurredOn: "2026-10-12" }),
      upload: (claim, file) => uploadExpenseReceipt(claim.id, file),
      rollback: (claim) => cancelExpense(claim.id, RECEIPT_AUTO_CANCEL_REASON),
    });

    expect(h.apiFetch.mock.calls.map(([path, opts]) => `${opts.method} ${path}`)).toEqual([
      "POST /expenses",
      "POST /expenses/claim-9/attachments",
      "PATCH /expenses/claim-9",
    ]);
    expect(JSON.parse(h.apiFetch.mock.calls[2]![1].body)).toEqual({ status: "cancelled", statusReason: RECEIPT_AUTO_CANCEL_REASON });
    expect(result).toMatchObject({ ok: false, stage: "upload", rolledBack: true });
    if (!result.ok && result.stage === "upload") {
      const message = receiptUploadFailedMessage(result.error, result.rolledBack);
      expect(message).toContain("這筆報銷已自動撤回，請重新送出");
      expect(message).toContain(NETWORK_FAILURE_MESSAGE);
    }
  });
});
