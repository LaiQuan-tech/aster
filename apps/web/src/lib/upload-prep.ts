/**
 * 上傳前準備（2026-10-12 教育訓練驗收第 13 條：手機照片超過約 3 MB 就上傳失敗）。
 * 報銷憑證（POST /expenses/:id/attachments）與請假附件（POST /requests/:id/attachments）共用：
 * ess-api.ts 的 uploadExpenseReceipt／uploadAttachment 送出前一律經過 {@link prepareUploadFile}。
 *
 *   1. 照片（JPEG／PNG／WebP／HEIC…瀏覽器解得開的點陣圖）→ 縮小後轉 JPEG 品質 0.8（尺寸見 {@link targetSize}：
 *      一般照片長邊約 2000px；長截圖收據短邊至少約 1000px，小字才看得清；總像素不超過約 16MP）。
 *      GIF（可能是動圖）與 SVG（向量圖）不壓；解不開（例如 Chrome 上的 HEIC）或壓完沒有比較小 → 用原檔。
 *   2. 大小判斷：準備好的檔案超過 3 MB → 前端擋下（丟 {@link UploadPrepError}），不送任何請求。
 *   3. 建單＋附檔的順序：先準備、過了才建單（報銷 {@link createThenUpload}、請假 {@link createThenUploadAll}）。
 *
 * 為什麼是 3 MB：API 跑在 Vercel serverless，請求 body 上限約 4.5 MB；檔案轉 base64 隨 JSON 送會膨脹 4/3，
 * 3 MB × 4/3 ≈ 4 MB，加上其他 JSON 欄位仍在上限內。超過時平台直接回 413、而且沒有 CORS 標頭，瀏覽器只看到
 * 「Failed to fetch」，程式拿不到錯誤碼（與 projects-api／knowledge-api 的 base64 上限同一個理由）。
 * API 自己的上限（報銷 5 MB、請假附件依租戶設定）都比這寬，實際卡住的是 Vercel。
 *
 * 種類判斷、目標尺寸、檔名、大小判斷是純函式；解碼與畫圖的瀏覽器 API 收在 {@link ImageCodec}，
 * 單元測試換成假的（__tests__/upload-prep.test.ts）。
 */

/* ------------------------------------------------------------ 上限 --- */

/** 經 API 上傳（base64 JSON）的單檔上限：3 MiB（理由見檔頭）。 */
export const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;

/**
 * 照片原檔的寬鬆上限：照片會先壓縮，不拿原始大小套 3 MB；但太大的圖在手機上解碼可能吃光記憶體、讓分頁當掉
 * （一億畫素的圖解開要約 400 MB），也多半不是一張單據。手機照片原檔多在 2–15 MB，25 MB 綽綽有餘。
 */
export const IMAGE_SOURCE_MAX_BYTES = 25 * 1024 * 1024;

/** 一般照片壓縮後的長邊：A4 拍滿畫面約 170 dpi，發票、收據上的字看得清楚。 */
export const IMAGE_MAX_EDGE = 2000;
/**
 * 縮小時短邊至少留這麼寬（原圖本來就比較窄就不放大）：長截圖收據（例如 1080×8000）若只看長邊縮到 2000，
 * 寬度只剩 270px、小字糊掉；照短邊算是 1000×7407，字跟在手機上看到的差不多大。
 */
export const IMAGE_MIN_SHORT_EDGE = 1000;
/**
 * 輸出的總像素上限：iOS Safari 的 canvas 面積上限約 16.7MP（4096×4096），超過就畫不出來（只能退回原檔）。
 * 極長的截圖照短邊算仍超過時，再等比縮到這個面積內。
 */
export const IMAGE_MAX_PIXELS = 16_000_000;
/** 輸出 JPEG 的品質（0–1）。 */
export const JPEG_QUALITY = 0.8;

export const EMPTY_FILE_MESSAGE = "檔案是空的（0 bytes），請重新選擇";
export const FILE_TOO_LARGE_MESSAGE = "檔案超過 3 MB，請縮小或改傳照片／截圖";
export const IMAGE_SOURCE_TOO_LARGE_MESSAGE = "照片超過 25 MB，請改傳較小的照片或截圖";
export const COMPRESSED_TOO_LARGE_MESSAGE = "照片壓縮後仍超過 3 MB，請改傳截圖或較小的照片";
export const UNCOMPRESSIBLE_TOO_LARGE_MESSAGE =
  "這張照片無法在這個瀏覽器壓縮（例如 HEIC 格式），而且超過 3 MB；請改傳 JPG 照片或截圖";

/* ------------------------------------------------------- 純函式 --- */

/** 只看名稱、類型、大小（File 也符合）；純函式收這個，測試不必造真的檔案。 */
export interface FileLike {
  name: string;
  type?: string | null;
  size: number;
}

/** compress＝會壓縮的照片；keep-image＝不壓的圖（GIF／SVG）；other＝非圖片（PDF…）。 */
export type UploadKind = "compress" | "keep-image" | "other";

const KEEP_IMAGE_TYPES = ["image/gif", "image/svg+xml"];
const KEEP_IMAGE_EXTS = [".gif", ".svg"];
/** 瀏覽器沒給類型（Windows 上的 .heic 常是空字串）或給 octet-stream 時，靠副檔名認照片。 */
const COMPRESS_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".avif", ".bmp"];
const HEIF_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
const HEIF_EXTS = [".heic", ".heif"];

function normalizedType(type: string | null | undefined): string {
  return (type ?? "").split(";")[0].trim().toLowerCase();
}

function extOf(name: string): string {
  return (name.trim().match(/\.[A-Za-z0-9]{1,8}$/) ?? [""])[0].toLowerCase();
}

/** 這個檔要不要壓縮：類型是 image/*（GIF、SVG 除外）就壓；沒有可信的類型時看副檔名。 */
export function uploadKindOf(file: Pick<FileLike, "name" | "type">): UploadKind {
  const type = normalizedType(file.type);
  if (type && type !== "application/octet-stream") {
    if (KEEP_IMAGE_TYPES.includes(type)) return "keep-image";
    return type.startsWith("image/") ? "compress" : "other";
  }
  const ext = extOf(file.name);
  if (KEEP_IMAGE_EXTS.includes(ext)) return "keep-image";
  return COMPRESS_EXTS.includes(ext) ? "compress" : "other";
}

function isHeif(file: Pick<FileLike, "name" | "type">): boolean {
  return HEIF_TYPES.includes(normalizedType(file.type)) || HEIF_EXTS.includes(extOf(file.name));
}

/** 壓縮尺寸的三個上下限（預設 {@link IMAGE_MAX_EDGE}／{@link IMAGE_MIN_SHORT_EDGE}／{@link IMAGE_MAX_PIXELS}）。 */
export interface SizeLimits {
  maxEdge: number;
  minShortEdge: number;
  maxPixels: number;
}

/**
 * 壓縮後的尺寸（等比、四捨五入、至少 1px；不放大）：
 *   縮放比例＝min(1, max(長邊上限／長邊, 短邊下限／短邊))——
 *   一般照片 4032×3024 → 2000×1500（長邊 2000）；長截圖 1080×8000 → 1000×7407（短邊留 1000）；
 *   本來就窄的 3000×600 不縮。縮完總像素仍超過上限 → 再等比縮到上限內（iOS canvas 畫不出太大的圖）。
 */
export function targetSize(width: number, height: number, limits: Partial<SizeLimits> = {}): { width: number; height: number } {
  const { maxEdge = IMAGE_MAX_EDGE, minShortEdge = IMAGE_MIN_SHORT_EDGE, maxPixels = IMAGE_MAX_PIXELS } = limits;
  const area = width * height;
  let scale = Math.min(1, Math.max(maxEdge / Math.max(width, height), minShortEdge / Math.min(width, height)));
  if (area * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / area);
  if (scale >= 1) return { width, height };
  const scaled = (round: (n: number) => number) => ({
    width: Math.max(1, round(width * scale)),
    height: Math.max(1, round(height * scale)),
  });
  const rounded = scaled(Math.round);
  // 四捨五入可能多出幾個像素而超過面積上限 → 改無條件捨去
  return rounded.width * rounded.height > maxPixels ? scaled(Math.floor) : rounded;
}

/** 壓成 JPEG 後的檔名：副檔名改 .jpg（「IMG_0001.HEIC」→「IMG_0001.jpg」）；沒有副檔名就補上。 */
export function jpegFileName(name: string): string {
  const base = name.trim().replace(/\.[A-Za-z0-9]{1,8}$/, "");
  return `${base || "photo"}.jpg`;
}

/**
 * 壓完的 JPEG 要不要用：比原檔小才用，沒有比較小 → 用原檔。
 * 例外：HEIC／HEIF 多數瀏覽器看不了（HR 在 Chrome 上審核時打不開），JPEG 只要在 3 MB 內就用 JPEG。
 */
export function preferCompressed(original: FileLike, compressed: Pick<FileLike, "size">): boolean {
  if (compressed.size < original.size) return true;
  return isHeif(original) && compressed.size <= UPLOAD_MAX_BYTES;
}

/**
 * 選檔當下（還沒壓縮）的大小檢查，回中文錯誤或 null：
 *   • 空檔 → 擋（API 會回 400／413，訊息看不懂）；
 *   • 會壓縮的照片 → 只擋原檔超過 25 MB 的，其餘壓縮後再判斷（見 prepareUploadFile）；
 *   • 其他（PDF、GIF、SVG…不壓縮）→ 超過 3 MB 就擋。
 */
export function pickedFileError(file: FileLike): string | null {
  if (!(file.size > 0)) return EMPTY_FILE_MESSAGE;
  if (uploadKindOf(file) === "compress") return file.size > IMAGE_SOURCE_MAX_BYTES ? IMAGE_SOURCE_TOO_LARGE_MESSAGE : null;
  return file.size > UPLOAD_MAX_BYTES ? FILE_TOO_LARGE_MESSAGE : null;
}

/** 多個附件時訊息前面加檔名（「IMG_0001.HEIC」…），才知道是哪一個；只有一個就不加。 */
export function withFileName(name: string, message: string, multiple: boolean): string {
  return multiple ? `「${name}」${message}` : message;
}

/** 多個附件：回第一個有問題的（兩個以上時前面加檔名）；都沒問題 → null。 */
export function pickedFilesError(files: readonly FileLike[]): string | null {
  for (const file of files) {
    const problem = pickedFileError(file);
    if (problem) return withFileName(file.name, problem, files.length > 1);
  }
  return null;
}

/* ------------------------------------------------------------ 壓縮 --- */

/** 解碼後的圖（已照 EXIF 方向轉正）。 */
export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  /** 用完釋放（ImageBitmap.close／revokeObjectURL）。 */
  release(): void;
}

/** 解碼與輸出 JPEG 的瀏覽器操作；單元測試換成假的。 */
export interface ImageCodec {
  /** 解碼並照 EXIF 方向轉正；解不開就 reject。 */
  decode(file: Blob): Promise<DecodedImage>;
  /** 先鋪白底再把圖畫成 width×height，輸出 JPEG；做不到回 null。 */
  toJpeg(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob | null>;
}

/**
 * 瀏覽器實作。
 *   • EXIF 方向：手機直拍的照片多半存成橫的像素＋EXIF「要轉 90°」。解碼時就套用方向（createImageBitmap 明確帶
 *     imageOrientation: "from-image"），畫上 canvas 的像素已經是正的；canvas 輸出的 JPEG 不帶 EXIF，看圖程式
 *     不會再轉一次（順便拿掉拍攝地點等中繼資料）。不認得 "from-image" 的瀏覽器會丟 TypeError → 改用 <img> 解碼：
 *     現行瀏覽器（Chrome 81+、Safari 13.1+、Firefox 77+）的 <img> 與 drawImage 預設就照 EXIF 轉正。
 *   • 透明：PNG／WebP 的透明處轉 JPEG 會變黑，先鋪白底再畫。
 *   • HEIC：只有 Safari 解得開；其他瀏覽器兩條路都失敗 → prepareUploadFile 用原檔。
 */
export const browserImageCodec: ImageCodec = {
  async decode(file) {
    if (typeof globalThis.createImageBitmap === "function") {
      try {
        const bitmap = await globalThis.createImageBitmap(file, { imageOrientation: "from-image" });
        return { width: bitmap.width, height: bitmap.height, source: bitmap, release: () => bitmap.close() };
      } catch {
        // 不認得 "from-image"，或這種格式 createImageBitmap 解不開 → 改用 <img>
      }
    }
    if (typeof Image === "undefined") throw new Error("這個環境無法解碼圖片");
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      img.src = url;
      await img.decode();
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    return { width: img.naturalWidth, height: img.naturalHeight, source: img, release: () => URL.revokeObjectURL(url) };
  },

  async toJpeg(image, width, height, quality) {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image.source, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      // 不支援 JPEG 輸出的瀏覽器會改給 PNG：當作失敗，免得檔名 .jpg 內容卻是 PNG。
      return blob && blob.type === "image/jpeg" ? blob : null;
    } finally {
      // iOS Safari 的 canvas 記憶體要等回收才釋放，先把尺寸歸零。
      canvas.width = 0;
      canvas.height = 0;
    }
  },
};

/** 壓成 {@link targetSize} 尺寸的 JPEG（品質 0.8）；解不開、畫不出來 → null（呼叫端用原檔）。 */
async function compressImage(file: File, codec: ImageCodec): Promise<File | null> {
  let image: DecodedImage | null = null;
  try {
    image = await codec.decode(file);
    if (!(image.width > 0 && image.height > 0)) return null;
    const size = targetSize(image.width, image.height);
    const blob = await codec.toJpeg(image, size.width, size.height, JPEG_QUALITY);
    if (!blob || blob.size === 0) return null;
    return new File([blob], jpegFileName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return null;
  } finally {
    image?.release();
  }
}

/** 準備階段擋下的錯誤：訊息已是中文、可直接顯示；沒有 `.code`，不會被當成 API 錯誤碼翻譯。 */
export class UploadPrepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadPrepError";
  }
}

/** 準備過的檔（原檔 → 結果、結果 → 自己）：同一個檔再經過一次（報銷頁送出前先準備、上傳時又經過）不重壓。 */
const preparedFiles = new WeakMap<File, File>();

/**
 * 上傳前準備：照片壓縮＋大小判斷。回可以直接上傳的檔案；過不了就丟 {@link UploadPrepError}（訊息是中文）。
 * 壓縮失敗不算失敗：解不開、畫不出來、壓完沒有比較小 → 用原檔，再照原檔大小判斷。
 */
export async function prepareUploadFile(file: File, codec: ImageCodec = browserImageCodec): Promise<File> {
  const cached = preparedFiles.get(file);
  if (cached) return cached;
  const problem = pickedFileError(file);
  if (problem) throw new UploadPrepError(problem);

  const kind = uploadKindOf(file);
  let result = file;
  let compressFailed = false;
  if (kind === "compress") {
    const jpeg = await compressImage(file, codec);
    if (!jpeg) compressFailed = true;
    else if (preferCompressed(file, jpeg)) result = jpeg;
  }
  if (result.size > UPLOAD_MAX_BYTES) {
    throw new UploadPrepError(
      kind !== "compress"
        ? FILE_TOO_LARGE_MESSAGE
        : compressFailed
          ? UNCOMPRESSIBLE_TOO_LARGE_MESSAGE
          : COMPRESSED_TOO_LARGE_MESSAGE,
    );
  }
  preparedFiles.set(file, result);
  preparedFiles.set(result, result);
  return result;
}

/* ------------------------------------------------- 建單＋附檔順序 --- */

export type CreateThenUploadResult<T> =
  | { ok: true; created: T }
  | { ok: false; stage: "prepare"; error: unknown }
  | { ok: false; stage: "leftover"; error: unknown; leftover: T }
  | { ok: false; stage: "create"; error: unknown }
  | { ok: false; stage: "upload"; error: unknown; created: T; rolledBack: boolean };

/**
 * 建單＋附檔的順序（報銷頁用）：
 *   1. 先準備檔案（壓縮＋大小判斷）——過不了就停，不建單；
 *   2. 有 `leftover`（上一次憑證沒傳上、自動撤回也失敗而留下的單）→ 先用 rollback 撤掉它；撤不掉就停，不建新單
 *      （以前員工不知道單已建好、再按送出就多一筆沒有憑證的單）；
 *   3. 建單；
 *   4. 上傳；失敗就呼叫 rollback（報銷＝撤回剛建的單），免得留下一筆沒有附檔的單、員工重送又多一筆。
 * 不丟錯，用 `stage` 說停在哪一步；`rolledBack` 為 false＝撤回也失敗、單還在——呼叫端把它記成下一次的
 * `leftover`（見 {@link leftoverAfter}）。
 */
export async function createThenUpload<T>(steps: {
  file: File | null;
  leftover?: T | null;
  create: () => Promise<T>;
  upload: (created: T, file: File) => Promise<unknown>;
  rollback: (created: T) => Promise<unknown>;
  prepare?: (file: File) => Promise<File>;
}): Promise<CreateThenUploadResult<T>> {
  const prepare = steps.prepare ?? ((file: File) => prepareUploadFile(file));
  let upload: File | null = null;
  if (steps.file) {
    try {
      upload = await prepare(steps.file);
    } catch (error) {
      return { ok: false, stage: "prepare", error };
    }
  }
  if (steps.leftover) {
    try {
      await steps.rollback(steps.leftover);
    } catch (error) {
      return { ok: false, stage: "leftover", error, leftover: steps.leftover };
    }
  }
  let created: T;
  try {
    created = await steps.create();
  } catch (error) {
    return { ok: false, stage: "create", error };
  }
  if (upload) {
    try {
      await steps.upload(created, upload);
    } catch (error) {
      let rolledBack = true;
      try {
        await steps.rollback(created);
      } catch {
        rolledBack = false;
      }
      return { ok: false, stage: "upload", error, created, rolledBack };
    }
  }
  return { ok: true, created };
}

/**
 * {@link createThenUpload} 之後要記住的「留下的單」（下一次送出的 `leftover`）：
 *   • 停在準備、或撤回上一筆失敗 → 上一筆沒動到，照記；
 *   • 走到建單以後（建單失敗、成功、上傳失敗但撤回成功）→ 上一筆已撤回，清掉；
 *   • 上傳失敗而且撤回也失敗 → 改記這次建的單。
 */
export function leftoverAfter<T>(previous: T | null, result: CreateThenUploadResult<T>): T | null {
  if (result.ok) return null;
  if (result.stage === "prepare" || result.stage === "leftover") return previous;
  if (result.stage === "upload" && !result.rolledBack) return result.created;
  return null;
}

export type CreateThenUploadAllResult<T> =
  | { ok: true; created: T; failed: { file: File; error: unknown }[] }
  | { ok: false; stage: "prepare"; file: File; error: unknown }
  | { ok: false; stage: "create"; error: unknown };

/**
 * 建單＋多個附件的順序（請假頁用）：
 *   1. 逐一準備每個附件（壓縮＋大小判斷）——任一個過不了就停，不建單（`file`＝哪一個）。
 *      以前先建單才壓縮：桌機 Chrome 壓不了 HEIC，假單已建好卻缺憑證，同批其他檔也沒傳；
 *   2. 建單；
 *   3. 逐一上傳準備好的檔；某一個失敗不中斷，其餘照傳，沒傳上的列在 `failed`（原檔，畫面用原本的檔名）。
 * 不撤回：請假單缺附件仍是有效的單（列表標「缺憑證」、可補傳）。一個接一個做，不同時解多張大圖（手機記憶體）。
 */
export async function createThenUploadAll<T>(steps: {
  files: readonly File[];
  create: () => Promise<T>;
  upload: (created: T, file: File) => Promise<unknown>;
  prepare?: (file: File) => Promise<File>;
}): Promise<CreateThenUploadAllResult<T>> {
  const prepare = steps.prepare ?? ((file: File) => prepareUploadFile(file));
  const prepared: { original: File; upload: File }[] = [];
  for (const file of steps.files) {
    try {
      prepared.push({ original: file, upload: await prepare(file) });
    } catch (error) {
      return { ok: false, stage: "prepare", file, error };
    }
  }
  let created: T;
  try {
    created = await steps.create();
  } catch (error) {
    return { ok: false, stage: "create", error };
  }
  const failed: { file: File; error: unknown }[] = [];
  for (const { original, upload } of prepared) {
    try {
      await steps.upload(created, upload);
    } catch (error) {
      failed.push({ file: original, error });
    }
  }
  return { ok: true, created, failed };
}

/* -------------------------------------------------------- 連線失敗 --- */

/**
 * fetch 本身失敗、沒拿到任何回應：Chrome「Failed to fetch」、Safari「Load failed」、Firefox「NetworkError when
 * attempting to fetch resource.」。多半是網路不穩或中斷；上傳時也可能是請求超過 Vercel 約 4.5 MB 的上限
 * （平台回 413 但沒有 CORS 標頭，見檔頭）。這幾句英文不該直接出現在畫面上。
 */
const NETWORK_FAILURE_RE = /^(failed to fetch|load failed|networkerror when attempting to fetch resource)/i;

/** 斷線的一般說法（建單、撤回、載入…）。 */
export const NETWORK_FAILURE_MESSAGE = "連線失敗，請確認網路連線後再試";
/** 上傳檔案時斷線的說法：多提「可能是檔案太大」。 */
export const UPLOAD_NETWORK_FAILURE_MESSAGE = "連線失敗，可能是檔案太大或網路不穩；請換小一點的檔案或稍後再試";

export function isNetworkFailure(err: unknown): boolean {
  return err instanceof Error && NETWORK_FAILURE_RE.test(err.message.trim());
}
