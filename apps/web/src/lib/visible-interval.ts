/**
 * 「畫面可見時才定時執行」（2026-10-12，打卡首頁的背景對齊用；不碰 React，有單元測試）。
 *
 *   - 開始時畫面可見 → 起算計時，不立刻執行（進頁時呼叫端自己已經抓過一次）。
 *   - 畫面變隱藏 → 停止計時（PWA 收到背景不空轉）。
 *   - 回到可見 → 先立刻執行 `onVisible`（沒給就用 `tick`）一次，再重新起算。
 *   - 回傳的函式：移除監聽並清掉計時器（元件卸載時呼叫）。
 *
 * `tick`＝計時到了要做的事；`onVisible`＝回到前景時要做的事（打卡首頁兩者規則不同：輪詢只認正面證據、
 * 回到前景照舊整個套用）。`doc` 只要有 visibilityState 與 visibilitychange 的監聽（瀏覽器傳 `document`，測試傳假的）。
 */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function runWhileVisible(
  doc: VisibilitySource,
  intervalMs: number,
  tick: () => void,
  onVisible: () => void = tick,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    timer = setInterval(tick, intervalMs);
  };
  const onVisibilityChange = () => {
    if (doc.visibilityState === "visible") {
      onVisible();
      start();
    } else {
      stop();
    }
  };
  if (doc.visibilityState === "visible") start();
  doc.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    stop();
  };
}
