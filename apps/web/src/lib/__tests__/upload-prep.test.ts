import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 上傳前準備（2026-10-12 教育訓練驗收第 13 條）：
 *   • 報銷憑證、請假附件以 base64 隨 JSON 送，API 跑在 Vercel（請求上限約 4.5 MB）→ 準備後單檔 ≤ 3 MiB
 *   • 照片縮小後轉 JPEG 0.8（一般照片長邊 2000、長截圖短邊至少 1000、總像素 ≤ 16MP；EXIF 方向轉正、透明鋪白底）；
 *     GIF／SVG 不壓；解不開或壓完沒有比較小 → 用原檔；非圖片超過 3 MB → 前端擋下、不送任何請求
 *   • 報銷：先準備憑證 → （撤回上次留下的單）→ 建單 → 上傳；準備失敗不建單、上傳失敗自動撤回剛建的單
 *   • 請假：先準備每個附件 → 建單 → 逐檔上傳；任一個準備失敗不建單、某檔上傳失敗其餘照傳
 *   • 報銷留下的單（上傳＋撤回都失敗）：記在 sessionStorage，重新整理後下次送出照樣先重試撤回；
 *     重試撤回回 404／409（不存在、已核銷、月份已結算）→ 不卡住：清掉記錄、這次不送出
 *   • 申請頁的錯誤翻譯 describeError：認得的照舊；認不得的（[500] internal_server_error）只給中文通用說法
 * ⚠️ 識別碼、檔名都是明顯的假值（repo 是公開的）。
 */

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../api-client", () => ({ apiFetch: h.apiFetch }));
// describeError 在 form-shared.tsx，那支用 `@/` 別名 import（vitest 沒設別名）：別名接回真的模組；畫面元件（ess-ui）換成空殼——翻譯用不到它們。
vi.mock("@/components/ess-ui", () => ({ Button: null, Field: null, Icon: null, InlineError: null, Textarea: null }));
vi.mock("@/lib/attendance-sheets-api", () => import("../attendance-sheets-api"));
vi.mock("@/lib/request-forms", () => import("../request-forms"));
vi.mock("@/lib/upload-prep", () => import("../upload-prep"));

import {
  COMPRESSED_TOO_LARGE_MESSAGE,
  EMPTY_FILE_MESSAGE,
  FILE_TOO_LARGE_MESSAGE,
  IMAGE_MAX_EDGE,
  IMAGE_MAX_PIXELS,
  IMAGE_MIN_SHORT_EDGE,
  IMAGE_SOURCE_MAX_BYTES,
  IMAGE_SOURCE_TOO_LARGE_MESSAGE,
  JPEG_QUALITY,
  NETWORK_FAILURE_MESSAGE,
  UNCOMPRESSIBLE_TOO_LARGE_MESSAGE,
  UPLOAD_MAX_BYTES,
  UPLOAD_NETWORK_FAILURE_MESSAGE,
  UploadPrepError,
  apiErrorStatus,
  createThenUpload,
  createThenUploadAll,
  isLeftoverGone,
  isNetworkFailure,
  jpegFileName,
  leftoverAfter,
  pickedFileError,
  pickedFilesError,
  preferCompressed,
  prepareUploadFile,
  targetSize,
  uploadKindOf,
  withFileName,
  type CreateThenUploadResult,
  type DecodedImage,
  type ImageCodec,
} from "../upload-prep";
import { cancelExpense, createRequest, fileExpense, uploadAttachment, uploadExpenseReceipt } from "../ess-api";
import {
  LEFTOVER_STORAGE_KEY,
  RECEIPT_AUTO_CANCEL_REASON,
  leftoverGoneMessage,
  readLeftoverClaim,
  receiptUploadFailedMessage,
  saveLeftoverClaim,
  type LeftoverClaim,
  type StorageLike,
} from "../advance-view";
import { attachmentUploadWarning } from "../request-forms";
import { UNKNOWN_ERROR_MESSAGE, describeError } from "../../app/ess/requests/_components/form-shared";

const MiB = 1024 * 1024;

function fileOf(name: string, bytes: number, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** apiFetch 丟的錯誤長相：message 是 `[status] code`，另有 .status／.code／.body。 */
function apiError(status: number, code: string, body: Record<string, unknown> = { error: code }): Error {
  return Object.assign(new Error(`[${status}] ${code}`), { status, code, body });
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

  it("短邊至少 1000px（長截圖的小字）；總像素上限在 iOS canvas 的 4096×4096 之內", () => {
    expect(IMAGE_MIN_SHORT_EDGE).toBe(1000);
    expect(IMAGE_MAX_PIXELS).toBeLessThanOrEqual(4096 * 4096);
    expect(IMAGE_MAX_PIXELS).toBeGreaterThanOrEqual(15_000_000);
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

describe("targetSize（比例＝min(1, max(2000／長邊, 1000／短邊))，總像素 ≤ 16MP）", () => {
  it("一般照片：長邊剛好 2000、等比、四捨五入（橫式、直式、一億畫素都一樣）", () => {
    expect(targetSize(4032, 3024)).toEqual({ width: 2000, height: 1500 });
    expect(targetSize(3024, 4032)).toEqual({ width: 1500, height: 2000 });
    expect(targetSize(8064, 6048)).toEqual({ width: 2000, height: 1500 });
    expect(targetSize(12000, 9000)).toEqual({ width: 2000, height: 1500 });
  });

  it("長截圖收據 1080×8000 → 1000×7407（短邊留 1000，不是只看長邊縮成 270×2000）；手機截圖 1170×2532 → 1000×2164", () => {
    expect(targetSize(1080, 8000)).toEqual({ width: 1000, height: 7407 });
    expect(targetSize(8000, 1080)).toEqual({ width: 7407, height: 1000 });
    expect(targetSize(1170, 2532)).toEqual({ width: 1000, height: 2164 });
  });

  it("不放大：本來就不超過 2000、或短邊已比 1000 窄（3000×600、10000×3）→ 原尺寸", () => {
    expect(targetSize(2000, 1000)).toEqual({ width: 2000, height: 1000 });
    expect(targetSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(targetSize(3000, 600)).toEqual({ width: 3000, height: 600 });
    expect(targetSize(10000, 3)).toEqual({ width: 10000, height: 3 });
  });

  it("超大面積被夾到 16MP 以內（等比；四捨五入會超過時改捨去）", () => {
    // 900×20000（18MP）本來不必縮（短邊已窄），但超過面積上限 → 等比縮
    const tall = targetSize(900, 20000);
    expect(tall).toEqual({ width: 848, height: 18856 });
    expect(tall.width * tall.height).toBeLessThanOrEqual(IMAGE_MAX_PIXELS);
    // 1290×30000：照短邊算是 1000×23256（23MP）仍太大 → 夾到 16MP 內，長寬比不變
    const scroll = targetSize(1290, 30000);
    expect(scroll.width * scroll.height).toBeLessThanOrEqual(IMAGE_MAX_PIXELS);
    expect(scroll.width * scroll.height).toBeGreaterThan(IMAGE_MAX_PIXELS * 0.99);
    expect(scroll.height / scroll.width).toBeCloseTo(30000 / 1290, 1);
  });

  it("上下限可換（例如只看長邊）", () => {
    expect(targetSize(3000, 1500, { maxEdge: 1000, minShortEdge: 0 })).toEqual({ width: 1000, height: 500 });
    expect(targetSize(4000, 4000, { maxPixels: 1_000_000 })).toEqual({ width: 1000, height: 1000 });
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

  it("withFileName：兩個以上才加「檔名」", () => {
    expect(withFileName("IMG_0001.HEIC", "壓不了", true)).toBe("「IMG_0001.HEIC」壓不了");
    expect(withFileName("IMG_0001.HEIC", "壓不了", false)).toBe("壓不了");
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

  it("長截圖收據 1080×8000 → 畫成 1000×7407（不是 270×2000）", async () => {
    const { codec, toJpeg } = fakeCodec({ width: 1080, height: 8000, jpegBytes: 900_000 });
    const out = await prepareUploadFile(fileOf("收據截圖.png", 4 * MiB, "image/png"), codec);
    expect(toJpeg.mock.calls[0]!.slice(1)).toEqual([1000, 7407, 0.8]);
    expect(out.size).toBe(900_000);
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
      expect(message).toContain(UPLOAD_NETWORK_FAILURE_MESSAGE);
    }
  });
});

/* -------------------------------- 撤回留下的單：哪些失敗是「再撤也撤不掉」 --- */

describe("apiErrorStatus／isLeftoverGone", () => {
  it("狀態碼：.status 優先，沒有就取 `[409] code` 的前綴；斷線、字串、一般 Error、不是三位數 → null", () => {
    expect(apiErrorStatus(apiError(409, "already_settled"))).toBe(409);
    expect(apiErrorStatus(new Error("[404] not_found"))).toBe(404);
    expect(apiErrorStatus(Object.assign(new Error("[500] boom"), { status: 409 }))).toBe(409);
    expect(apiErrorStatus(Object.assign(new Error("[404] not_found"), { status: "404" }))).toBe(404); // .status 不是數字 → 看前綴
    expect(apiErrorStatus(new TypeError("Failed to fetch"))).toBeNull();
    expect(apiErrorStatus(new Error("boom"))).toBeNull();
    expect(apiErrorStatus(new Error("[40] x"))).toBeNull();
    expect(apiErrorStatus("[409] already_settled")).toBeNull();
    expect(apiErrorStatus(null)).toBeNull();
    expect(apiErrorStatus(undefined)).toBeNull();
  });

  it("404（不存在）、409（已核銷 already_settled／預支已核銷 advance_settled／月份已結算 period_closed）才算撤不掉", () => {
    expect(isLeftoverGone(apiError(404, "not_found"))).toBe(true);
    expect(isLeftoverGone(apiError(409, "already_settled"))).toBe(true);
    expect(isLeftoverGone(apiError(409, "advance_settled"))).toBe(true);
    expect(isLeftoverGone(apiError(409, "period_closed", { error: "period_closed", period: "2026-09" }))).toBe(true);
    expect(isLeftoverGone(new Error("[409] period_closed"))).toBe(true);
  });

  it("403、500、斷線、一般錯誤、非 Error 都可能是暫時的（或不是這邊判斷得了的）→ 不算", () => {
    for (const err of [
      apiError(403, "forbidden"),
      apiError(400, "invalid_body"),
      apiError(401, "unauthorized"),
      apiError(500, "internal_server_error"),
      apiError(502, "bad_gateway"),
      new TypeError("Failed to fetch"),
      new TypeError("Load failed"),
      new Error("boom"),
      "[409] already_settled",
      null,
    ]) {
      expect(isLeftoverGone(err), String(err)).toBe(false);
    }
  });
});

/* ------------------------------- 報銷：上傳＋撤回都失敗後再按送出（leftover） --- */

describe("createThenUpload 的 leftover（上次憑證沒傳上、撤回也失敗而留下的單）", () => {
  type Claim = { id: string; period: string };
  const LEFT: Claim = { id: "claim-left", period: "2026-09" };
  const steps = () => {
    const order: string[] = [];
    return {
      order,
      create: vi.fn(async (): Promise<Claim> => {
        order.push("create");
        return { id: "claim-new", period: "2026-10" };
      }),
      upload: vi.fn(async (created: Claim, _file: File) => {
        order.push(`upload ${created.id}`);
      }),
      rollback: vi.fn(async (created: Claim) => {
        order.push(`rollback ${created.id}`);
      }),
    };
  };
  const pdf = () => fileOf("發票.pdf", 10, "application/pdf");

  it("先撤回留下的單才建新單：順序 rollback(留下的) → create → upload", async () => {
    const s = steps();
    const result = await createThenUpload({ file: pdf(), leftover: LEFT, ...s });
    expect(result).toEqual({ ok: true, created: { id: "claim-new", period: "2026-10" } });
    expect(s.order).toEqual(["rollback claim-left", "create", "upload claim-new"]);
  });

  it("撤不掉留下的單 → 停在 leftover，不建新單（再按一次送出也不會多一筆）", async () => {
    const s = steps();
    s.rollback.mockRejectedValueOnce(new TypeError("Load failed"));
    const result = await createThenUpload({ file: pdf(), leftover: LEFT, ...s });
    expect(result).toMatchObject({ ok: false, stage: "leftover", leftover: LEFT });
    expect(s.create).not.toHaveBeenCalled();
    expect(s.upload).not.toHaveBeenCalled();
  });

  it("憑證準備不過 → 什麼都不動（留下的單也不撤）", async () => {
    const s = steps();
    const result = await createThenUpload({ file: fileOf("a.pdf", 3 * MiB + 1, "application/pdf"), leftover: LEFT, ...s });
    expect(result).toMatchObject({ ok: false, stage: "prepare" });
    expect(s.order).toEqual([]);
  });

  it("沒有留下的單（null／省略）→ 照原本流程", async () => {
    const s = steps();
    await createThenUpload({ file: pdf(), leftover: null, ...s });
    expect(s.order).toEqual(["create", "upload claim-new"]);
  });

  it("leftoverAfter：準備失敗／撤回留下的失敗 → 照記；走到建單以後 → 清掉；上傳失敗又撤不回 → 改記這次的單", () => {
    const NEW: Claim = { id: "claim-new", period: "2026-10" };
    const r = (x: CreateThenUploadResult<Claim>) => x;
    expect(leftoverAfter(LEFT, r({ ok: false, stage: "prepare", error: 1 }))).toBe(LEFT);
    expect(leftoverAfter(LEFT, r({ ok: false, stage: "leftover", error: 1, leftover: LEFT }))).toBe(LEFT);
    expect(leftoverAfter(LEFT, r({ ok: false, stage: "create", error: 1 }))).toBeNull();
    expect(leftoverAfter(LEFT, r({ ok: true, created: NEW }))).toBeNull();
    expect(leftoverAfter(LEFT, r({ ok: false, stage: "upload", error: 1, created: NEW, rolledBack: true }))).toBeNull();
    expect(leftoverAfter(LEFT, r({ ok: false, stage: "upload", error: 1, created: NEW, rolledBack: false }))).toBe(NEW);
    expect(leftoverAfter(null, r({ ok: false, stage: "upload", error: 1, created: NEW, rolledBack: false }))).toBe(NEW);
    expect(leftoverAfter(null, r({ ok: false, stage: "prepare", error: 1 }))).toBeNull();
  });

  it("撤回留下的單回 404（那筆已不存在）或 409（已核銷、月份已結算）→ stage leftover-gone：這次也不建新單、不上傳，回傳那一筆", async () => {
    for (const err of [
      apiError(404, "not_found"),
      apiError(409, "already_settled"),
      apiError(409, "advance_settled"),
      apiError(409, "period_closed", { error: "period_closed", period: "2026-09" }),
      new Error("[409] already_settled"), // 只剩訊息
    ]) {
      const s = steps();
      s.rollback.mockRejectedValueOnce(err);
      const result = await createThenUpload({ file: pdf(), leftover: LEFT, ...s });
      expect(result).toEqual({ ok: false, stage: "leftover-gone", error: err, leftover: LEFT });
      expect(s.rollback).toHaveBeenCalledTimes(1);
      expect(s.create).not.toHaveBeenCalled();
      expect(s.upload).not.toHaveBeenCalled();
    }
  });

  it("其他撤不掉的原因（500、403、斷線、一般錯誤）維持原樣：stage leftover（繼續記著，下次再試）", async () => {
    for (const err of [
      apiError(500, "internal_server_error"),
      apiError(403, "forbidden"),
      apiError(400, "invalid_body"),
      new TypeError("Failed to fetch"),
      new TypeError("Load failed"),
      new Error("boom"),
      "boom",
    ]) {
      const s = steps();
      s.rollback.mockRejectedValueOnce(err);
      const result = await createThenUpload({ file: pdf(), leftover: LEFT, ...s });
      expect(result).toEqual({ ok: false, stage: "leftover", error: err, leftover: LEFT });
      expect(s.create).not.toHaveBeenCalled();
    }
  });

  it("leftoverAfter：leftover-gone（撤不掉的單）→ 清掉記錄，不管之前記的是什麼", () => {
    const gone: CreateThenUploadResult<Claim> = { ok: false, stage: "leftover-gone", error: apiError(409, "period_closed"), leftover: LEFT };
    expect(leftoverAfter(LEFT, gone)).toBeNull();
    expect(leftoverAfter(null, gone)).toBeNull();
  });

  it("接上真正的 ess-api：留下的單回 409（月份已結算）→ 這次沒有 POST /expenses、記錄清掉；再按一次送出 → 直接建單＋上傳", async () => {
    const submit = (leftover: LeftoverClaim | null) =>
      createThenUpload({
        file: new File(["%PDF-1.4"], "發票.pdf", { type: "application/pdf" }),
        leftover,
        create: () => fileExpense({ categoryId: "cat-1", amount: 100, incurredOn: "2026-10-12" }),
        upload: (claim, file) => uploadExpenseReceipt(claim.id, file),
        rollback: (claim) => cancelExpense(claim.id, RECEIPT_AUTO_CANCEL_REASON),
      });
    const calls = () => h.apiFetch.mock.calls.map(([path, opts]) => `${opts.method} ${path}`);

    // 重試撤回上個月留下的單：那個月已發薪鎖定 → 409 period_closed
    let leftover: LeftoverClaim | null = { id: "claim-1", period: "2026-09" };
    h.apiFetch.mockRejectedValueOnce(apiError(409, "period_closed", { error: "period_closed", period: "2026-09" }));
    const first = await submit(leftover);
    expect(first).toMatchObject({ ok: false, stage: "leftover-gone", leftover: { id: "claim-1", period: "2026-09" } });
    expect(calls()).toEqual(["PATCH /expenses/claim-1"]); // 沒有再建新單
    if (!first.ok && first.stage === "leftover-gone") {
      expect(leftoverGoneMessage(first.error, first.leftover.period)).toContain("請洽 HR 確認，確認後再按一次送出");
    }
    leftover = leftoverAfter(leftover, first);
    expect(leftover).toBeNull();

    // 員工確認後再按一次送出：已經沒有留下的單 → 建單＋上傳
    h.apiFetch.mockReset();
    h.apiFetch
      .mockResolvedValueOnce({ id: "claim-2", period: "2026-10", nature: "reimbursement" })
      .mockResolvedValueOnce({ id: "att-1" });
    const second = await submit(leftover);
    expect(second).toMatchObject({ ok: true, created: { id: "claim-2" } });
    expect(calls()).toEqual(["POST /expenses", "POST /expenses/claim-2/attachments"]);
  });

  it("接上真正的 ess-api：留下的單回 404（已不存在）→ 同樣不卡住：只有一個 PATCH、記錄清掉", async () => {
    const leftover: LeftoverClaim = { id: "claim-gone", period: "2026-10" };
    h.apiFetch.mockRejectedValueOnce(apiError(404, "not_found"));
    const result = await createThenUpload({
      file: new File(["%PDF-1.4"], "發票.pdf", { type: "application/pdf" }),
      leftover,
      create: () => fileExpense({ categoryId: "cat-1", amount: 100, incurredOn: "2026-10-12" }),
      upload: (claim, file) => uploadExpenseReceipt(claim.id, file),
      rollback: (claim) => cancelExpense(claim.id, RECEIPT_AUTO_CANCEL_REASON),
    });
    expect(result).toMatchObject({ ok: false, stage: "leftover-gone" });
    expect(h.apiFetch.mock.calls.map(([path, opts]) => `${opts.method} ${path}`)).toEqual(["PATCH /expenses/claim-gone"]);
    expect(leftoverAfter(leftover, result)).toBeNull();
  });

  it("重新整理同一分頁：留下的單記在 sessionStorage，讀回來後下次送出照樣先重試撤回、不建第二筆；撤回成功後清掉", async () => {
    // 假的 sessionStorage；頁面的 useLeftoverClaim 在 state 變動後用 saveLeftoverClaim 寫入、掛載時用 readLeftoverClaim 讀回
    const data = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
    const submit = (leftover: LeftoverClaim | null) =>
      createThenUpload({
        file: new File(["%PDF-1.4"], "發票.pdf", { type: "application/pdf" }),
        leftover,
        create: () => fileExpense({ categoryId: "cat-1", amount: 100, incurredOn: "2026-10-12" }),
        upload: (claim, file) => uploadExpenseReceipt(claim.id, file),
        rollback: (claim) => cancelExpense(claim.id, RECEIPT_AUTO_CANCEL_REASON),
      });
    const calls = () => h.apiFetch.mock.calls.map(([path, opts]) => `${opts.method} ${path}`);

    // 第 1 次：建單成功、上傳斷線、自動撤回也斷線 → 單留著，記進 sessionStorage
    h.apiFetch
      .mockResolvedValueOnce({ id: "claim-1", period: "2026-10", nature: "reimbursement" })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const first = await submit(null);
    expect(first).toMatchObject({ ok: false, stage: "upload", rolledBack: false });
    saveLeftoverClaim(storage, leftoverAfter(null, first));
    expect([...data.keys()]).toEqual([LEFTOVER_STORAGE_KEY]);

    // 重新整理：頁面記憶體清空，掛載後從 sessionStorage 讀回
    let leftover = readLeftoverClaim(storage);
    expect(leftover).toEqual({ id: "claim-1", period: "2026-10" });

    // 第 2 次：撤回舊單仍斷線 → 只有 PATCH 舊單，沒有第二個 POST /expenses；記錄還在
    h.apiFetch.mockReset();
    h.apiFetch.mockRejectedValueOnce(new TypeError("Load failed"));
    const second = await submit(leftover);
    expect(second).toMatchObject({ ok: false, stage: "leftover" });
    expect(calls()).toEqual(["PATCH /expenses/claim-1"]);
    leftover = leftoverAfter(leftover, second);
    saveLeftoverClaim(storage, leftover);
    expect(readLeftoverClaim(storage)).toEqual({ id: "claim-1", period: "2026-10" });

    // 第 3 次：網路恢復 → 先撤回舊單 → 建新單 → 上傳；成功後記錄清掉
    h.apiFetch.mockReset();
    h.apiFetch
      .mockResolvedValueOnce({ id: "claim-1" })
      .mockResolvedValueOnce({ id: "claim-2", period: "2026-10", nature: "reimbursement" })
      .mockResolvedValueOnce({ id: "att-1" });
    const third = await submit(leftover);
    expect(third).toMatchObject({ ok: true, created: { id: "claim-2" } });
    expect(calls()).toEqual(["PATCH /expenses/claim-1", "POST /expenses", "POST /expenses/claim-2/attachments"]);
    saveLeftoverClaim(storage, leftoverAfter(leftover, third));
    expect(data.size).toBe(0);
    expect(readLeftoverClaim(storage)).toBeNull();
  });

  it("接上真正的 ess-api（同報銷頁）：上傳＋撤回都斷線 → 再按送出、撤回仍斷線 → 沒有第二個 POST /expenses；網路恢復 → 先撤回舊單再建一筆", async () => {
    const submit = (leftover: { id: string; period: string; nature: string } | null) =>
      createThenUpload({
        file: new File(["%PDF-1.4"], "發票.pdf", { type: "application/pdf" }),
        leftover,
        create: () => fileExpense({ categoryId: "cat-1", amount: 100, incurredOn: "2026-10-12" }),
        upload: (claim, file) => uploadExpenseReceipt(claim.id, file),
        rollback: (claim) => cancelExpense(claim.id, RECEIPT_AUTO_CANCEL_REASON),
      });
    const calls = () => h.apiFetch.mock.calls.map(([path, opts]) => `${opts.method} ${path}`);

    // 第 1 次：建單成功、上傳斷線、自動撤回也斷線 → 單留著
    h.apiFetch
      .mockResolvedValueOnce({ id: "claim-1", period: "2026-10", nature: "reimbursement" })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const first = await submit(null);
    expect(first).toMatchObject({ ok: false, stage: "upload", rolledBack: false });
    let leftover = leftoverAfter(null, first);
    expect(leftover).toMatchObject({ id: "claim-1" });

    // 第 2 次：撤回舊單仍斷線 → 停下，沒有再 POST /expenses
    h.apiFetch.mockReset();
    h.apiFetch.mockRejectedValueOnce(new TypeError("Load failed"));
    const second = await submit(leftover);
    expect(second).toMatchObject({ ok: false, stage: "leftover" });
    expect(calls()).toEqual(["PATCH /expenses/claim-1"]);
    leftover = leftoverAfter(leftover, second);
    expect(leftover).toMatchObject({ id: "claim-1" });

    // 第 3 次：網路恢復 → 撤回舊單 → 建新單 → 上傳憑證，全部成功
    h.apiFetch.mockReset();
    h.apiFetch
      .mockResolvedValueOnce({ id: "claim-1" })
      .mockResolvedValueOnce({ id: "claim-2", period: "2026-10", nature: "reimbursement" })
      .mockResolvedValueOnce({ id: "att-1" });
    const third = await submit(leftover);
    expect(third).toMatchObject({ ok: true, created: { id: "claim-2" } });
    expect(calls()).toEqual(["PATCH /expenses/claim-1", "POST /expenses", "POST /expenses/claim-2/attachments"]);
    expect(JSON.parse(h.apiFetch.mock.calls[0]![1].body)).toEqual({ status: "cancelled", statusReason: RECEIPT_AUTO_CANCEL_REASON });
    expect(leftoverAfter(leftover, third)).toBeNull();
  });
});

/* ------------------------------------------------ 請假：建單＋多個附件 --- */

describe("createThenUploadAll（請假頁：先準備每個附件 → 建單 → 逐檔上傳）", () => {
  const steps = () => {
    const order: string[] = [];
    return {
      order,
      create: vi.fn(async () => {
        order.push("create");
        return { requestId: "req-1" };
      }),
      upload: vi.fn(async (_created: { requestId: string }, file: File) => {
        order.push(`upload ${file.name}`);
      }),
    };
  };

  it("任一附件準備失敗（第 2 個 PDF 超過 3 MB）→ 不建單、一個都不傳，回報是哪個檔", async () => {
    const s = steps();
    const ok = fileOf("收據.pdf", 10, "application/pdf");
    const bad = fileOf("診斷證明.pdf", 3 * MiB + 1, "application/pdf");
    const result = await createThenUploadAll({ files: [ok, bad], ...s });
    expect(result).toMatchObject({ ok: false, stage: "prepare", file: bad });
    expect(!result.ok && result.error).toBeInstanceOf(UploadPrepError);
    expect(s.order).toEqual([]);
  });

  it("全部準備好才建單；上傳的是準備好的檔（照片是壓縮後的 JPEG）", async () => {
    const s = steps();
    const prepare = vi.fn(async (file: File) => {
      s.order.push(`prepare ${file.name}`);
      return file.name.endsWith(".HEIC") ? fileOf("IMG_0001.jpg", 100, "image/jpeg") : file;
    });
    const result = await createThenUploadAll({
      files: [fileOf("IMG_0001.HEIC", 5 * MiB, "image/heic"), fileOf("收據.pdf", 10, "application/pdf")],
      prepare,
      ...s,
    });
    expect(result).toEqual({ ok: true, created: { requestId: "req-1" }, failed: [] });
    expect(s.order).toEqual(["prepare IMG_0001.HEIC", "prepare 收據.pdf", "create", "upload IMG_0001.jpg", "upload 收據.pdf"]);
  });

  it("建單失敗 → 不上傳", async () => {
    const s = steps();
    s.create.mockRejectedValueOnce(new Error("[409] period_closed"));
    const result = await createThenUploadAll({ files: [fileOf("a.pdf", 10, "application/pdf")], ...s });
    expect(result).toMatchObject({ ok: false, stage: "create" });
    expect(s.upload).not.toHaveBeenCalled();
  });

  it("建單後第 1 個附件上傳失敗 → 其餘照傳，失敗的列在 failed（原檔、原本的檔名）", async () => {
    const s = steps();
    const a = fileOf("a.pdf", 10, "application/pdf");
    const b = fileOf("b.pdf", 10, "application/pdf");
    const c = fileOf("c.pdf", 10, "application/pdf");
    const boom = new TypeError("Failed to fetch");
    s.upload.mockImplementationOnce(async () => {
      s.order.push("upload a.pdf");
      throw boom;
    });
    const result = await createThenUploadAll({ files: [a, b, c], ...s });
    expect(s.order).toEqual(["create", "upload a.pdf", "upload b.pdf", "upload c.pdf"]);
    expect(result).toEqual({ ok: true, created: { requestId: "req-1" }, failed: [{ file: a, error: boom }] });
  });

  it("沒有附件 → 只建單", async () => {
    const s = steps();
    expect(await createThenUploadAll({ files: [], ...s })).toEqual({ ok: true, created: { requestId: "req-1" }, failed: [] });
    expect(s.order).toEqual(["create"]);
  });

  it("接上真正的 ess-api（同請假頁）：桌機 Chrome 解不開的 3.5 MB HEIC → 一個請求都沒送（沒建單）", async () => {
    // Node 沒有 createImageBitmap／Image，等同解不開 HEIC 的瀏覽器
    const heic = fileOf("IMG_0012.HEIC", 3.5 * MiB, "image/heic");
    const result = await createThenUploadAll({
      files: [fileOf("收據.pdf", 10, "application/pdf"), heic],
      create: () => createRequest({ kind: "leave" } as Parameters<typeof createRequest>[0]),
      upload: (created, file) => uploadAttachment(created.requestId, file),
    });
    expect(result).toMatchObject({ ok: false, stage: "prepare", file: heic });
    expect(!result.ok && (result.error as Error).message).toBe(UNCOMPRESSIBLE_TOO_LARGE_MESSAGE);
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it("接上真正的 ess-api：建單後第 1 個附件斷線、第 2 個照傳", async () => {
    h.apiFetch
      .mockResolvedValueOnce({ requestId: "req-9" }) // POST /requests
      .mockRejectedValueOnce(new TypeError("Failed to fetch")) // 第 1 個附件
      .mockResolvedValueOnce({ id: "att-2" }); // 第 2 個附件
    const result = await createThenUploadAll({
      files: [new File(["%PDF-1.4"], "a.pdf", { type: "application/pdf" }), new File(["%PDF-1.4"], "b.pdf", { type: "application/pdf" })],
      create: () => createRequest({ kind: "leave" } as Parameters<typeof createRequest>[0]),
      upload: (created, file) => uploadAttachment(created.requestId, file),
    });
    expect(h.apiFetch.mock.calls.map(([path]) => path)).toEqual([
      "/requests",
      "/requests/req-9/attachments",
      "/requests/req-9/attachments",
    ]);
    expect(result.ok && result.failed.map((f) => f.file.name)).toEqual(["a.pdf"]);
  });
});

/* ------------------------------------------------------------ 連線失敗 --- */

describe("isNetworkFailure／斷線的中文說法", () => {
  it("Chrome／Safari／Firefox 三種說法都認得；一般 API 錯誤、字串不算", () => {
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      expect(isNetworkFailure(new TypeError(message))).toBe(true);
    }
    expect(isNetworkFailure(new Error("[500] kaboom"))).toBe(false);
    expect(isNetworkFailure(new UploadPrepError(FILE_TOO_LARGE_MESSAGE))).toBe(false);
    expect(isNetworkFailure("Failed to fetch")).toBe(false);
  });

  it("一般說法不提檔案；上傳的說法才提「可能是檔案太大」；都沒有英文", () => {
    expect(NETWORK_FAILURE_MESSAGE).toContain("連線失敗");
    expect(NETWORK_FAILURE_MESSAGE).not.toContain("檔案");
    expect(UPLOAD_NETWORK_FAILURE_MESSAGE).toContain("檔案太大");
    expect(UPLOAD_NETWORK_FAILURE_MESSAGE).toContain("網路不穩");
    for (const text of [NETWORK_FAILURE_MESSAGE, UPLOAD_NETWORK_FAILURE_MESSAGE]) expect(text).not.toMatch(/[A-Za-z]/);
  });
});

/* -------------------------------------------- 申請頁的錯誤翻譯（describeError） --- */

describe("describeError（請假送出、我的申請補傳／撤回、載入共用）", () => {
  /** 畫面文字不該有英文（MB、KB 單位除外）。 */
  const noEnglish = (text: string) => expect(text.replace(/MB|KB/g, "")).not.toMatch(/[A-Za-z]/);
  /** 畫面不出現 `[數字] 英文代碼`。 */
  const noStatusCode = (text: string) => expect(text).not.toMatch(/\[\d+\]/);
  const silenceWarn = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("認得的照舊：文案不變，也不吵 console", () => {
    const warn = silenceWarn();
    const closed = apiError(409, "period_closed", { error: "period_closed", period: "2026-09" });
    expect(describeError(apiError(401, "unauthorized"), "x")).toBe("請重新登入");
    expect(describeError(apiError(403, "forbidden"), "x")).toBe("沒有權限執行此操作");
    expect(describeError(apiError(404, "not_found"), "x")).toBe("找不到這張申請");
    expect(describeError(apiError(409, "not_pending"), "x")).toBe("這張申請已不是待簽核狀態");
    expect(describeError(apiError(400, "attachment_required"), "x")).toBe("此假別需要附上憑證");
    expect(describeError(apiError(409, "locked"), "x")).toBe("此月表已鎖定，不可再變更"); // 出勤月表那套 friendlyError 的表
    expect(describeError(closed, "x")).toBe("2026-09 已結算，請洽管理者");
    expect(describeError(apiError(413, "file_too_large", { error: "file_too_large", maxBytes: 1 * MiB }), "x")).toBe(
      "附件太大，單檔限 1 MB",
    );
    expect(describeError(apiError(413, "file_too_large"), "x")).toBe("附件超過公司設定的大小上限，請縮小後再傳");
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      expect(describeError(new TypeError(message), "x")).toBe(NETWORK_FAILURE_MESSAGE);
    }
    // 前端自己擋下的、本來就是中文的訊息：原樣
    expect(describeError(new UploadPrepError(FILE_TOO_LARGE_MESSAGE), "x")).toBe(FILE_TOO_LARGE_MESSAGE);
    expect(describeError(new UploadPrepError(EMPTY_FILE_MESSAGE), "x")).toBe(EMPTY_FILE_MESSAGE);
    expect(describeError(new Error("讀取檔案失敗"), "x")).toBe("讀取檔案失敗");
    expect(warn).not.toHaveBeenCalled();
  });

  it("認不得的錯誤碼／英文訊息 → 只給中文通用說法，畫面沒有 [數字] 英文代碼；原始錯誤記在 console.warn", () => {
    for (const err of [
      apiError(500, "internal_server_error"),
      new Error("[500] internal_server_error"), // 只剩訊息
      apiError(409, "max_files_reached", { error: "max_files_reached", max: 3 }),
      apiError(400, "invalid_base64"),
      new Error("[502] Bad Gateway"),
      new TypeError("Cannot read properties of undefined (reading 'id')"), // 程式錯誤的英文訊息
    ]) {
      const warn = silenceWarn();
      const text = describeError(err, "上傳失敗");
      expect(text, String(err)).toBe(UNKNOWN_ERROR_MESSAGE);
      noStatusCode(text);
      noEnglish(text);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.any(String), err); // 原始錯誤原封不動記下來
      warn.mockRestore();
    }
  });

  it("fallback 只給不是 Error 的東西（字串、null、undefined）與沒有訊息的 Error；認不得的 Error 不用它", () => {
    const warn = silenceWarn();
    expect(describeError("boom", "送出失敗，請稍後再試")).toBe("送出失敗，請稍後再試");
    expect(describeError(undefined, "撤回失敗")).toBe("撤回失敗");
    expect(describeError(null, "載入申請失敗")).toBe("載入申請失敗");
    expect(describeError(new Error(""), "上傳憑證失敗")).toBe("上傳憑證失敗");
    expect(warn).not.toHaveBeenCalled();
  });

  it("每個呼叫點的 fallback 都適用：請假送出（建單、附件準備、附件上傳）、我的申請（補傳、撤回）、載入", () => {
    silenceWarn();
    for (const fallback of ["送出失敗，請稍後再試", "附件無法使用，請換一個檔案", "上傳失敗", "上傳憑證失敗", "撤回失敗", "載入申請失敗"]) {
      expect(describeError(apiError(500, "internal_server_error"), fallback)).toBe(UNKNOWN_ERROR_MESSAGE);
      expect(describeError(new UploadPrepError(FILE_TOO_LARGE_MESSAGE), fallback)).toBe(FILE_TOO_LARGE_MESSAGE);
      expect(describeError("boom", fallback)).toBe(fallback);
    }
  });

  it("通用說法本身：全中文，單獨顯示或放進「（…）」括號都通順", () => {
    noEnglish(UNKNOWN_ERROR_MESSAGE);
    expect(UNKNOWN_ERROR_MESSAGE).toContain("請稍後再試");
  });

  it("請假送出的成功畫面：附件上傳回 [500] internal_server_error → 括號裡只有中文通用說法（以前寫成「（[500] internal_server_error）」）", async () => {
    silenceWarn();
    h.apiFetch.mockResolvedValueOnce({ requestId: "req-9" }).mockRejectedValueOnce(apiError(500, "internal_server_error"));
    const result = await createThenUploadAll({
      files: [new File(["%PDF-1.4"], "診斷證明.pdf", { type: "application/pdf" })],
      create: () => createRequest({ kind: "leave" } as Parameters<typeof createRequest>[0]),
      upload: (created, file) => uploadAttachment(created.requestId, file),
    });
    expect(result.ok).toBe(true);
    const failed = result.ok ? result.failed : [];
    expect(failed).toHaveLength(1);
    // 同請假頁 submit：沒傳上的檔 → { name, reason: describeError(error, "上傳失敗") } → attachmentUploadWarning
    const warning = attachmentUploadWarning(
      failed.map(({ file, error }) => ({ name: file.name, reason: describeError(error, "上傳失敗") })),
      1,
    );
    expect(warning).toBe(
      `申請已送出，但附件「診斷證明.pdf」上傳失敗（${UNKNOWN_ERROR_MESSAGE}）。請在下方「我的申請」按「上傳憑證」補傳。`,
    );
    noStatusCode(warning!);
    expect(warning).not.toContain("internal_server_error");
  });

  it("我的申請補傳（uploadAttachment）：回 [500] → 中文通用說法；回 413 → 照回應的上限；斷線 → 連線失敗", async () => {
    silenceWarn();
    const file = new File(["%PDF-1.4"], "診斷證明.pdf", { type: "application/pdf" });
    h.apiFetch.mockRejectedValueOnce(apiError(500, "internal_server_error"));
    await expect(uploadAttachment("req-9", file).catch((err) => describeError(err, "上傳憑證失敗"))).resolves.toBe(UNKNOWN_ERROR_MESSAGE);
    h.apiFetch.mockRejectedValueOnce(apiError(413, "file_too_large", { error: "file_too_large", maxBytes: 2 * MiB }));
    await expect(uploadAttachment("req-9", file).catch((err) => describeError(err, "上傳憑證失敗"))).resolves.toBe("附件太大，單檔限 2 MB");
    h.apiFetch.mockRejectedValueOnce(new TypeError("Load failed"));
    await expect(uploadAttachment("req-9", file).catch((err) => describeError(err, "上傳憑證失敗"))).resolves.toBe(NETWORK_FAILURE_MESSAGE);
  });
});
