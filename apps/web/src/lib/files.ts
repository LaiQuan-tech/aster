/**
 * 瀏覽器端檔案工具。走 JSON 上傳的 API（`{ fileName, dataBase64 }`）都用這裡的 fileToBase64。
 */

/** 把 File 讀成 base64 字串（不含 `data:...;base64,` 前綴）。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("讀取檔案失敗"));
    reader.readAsDataURL(file);
  });
}
