/**
 * 名冊列表（客戶／廠商）表格的共用樣式（2026-10-27 業主：表頭列往下捲時要釘在上方）。
 *
 * - 外層容器同時負責左右與上下捲動（max-h＋overflow-auto），sticky top／left 才會以它為準。
 * - 表格用 border-separate＋border-spacing-0、框線畫在儲存格上：border-collapse 下 sticky 儲存格的框線與背景
 *   會脫節，捲動時底下的文字會從縫隙透出來。
 * - 疊放順序：一般表頭 z-20；左側凍結欄與右側操作欄的表頭（同時 sticky top＋left/right）z-30；
 *   內容列的凍結欄／操作欄 z-10。凍結格一律不透明底色。
 */
export const ROSTER_TABLE_WRAP = "max-h-[calc(100vh-14rem)] overflow-auto rounded-md border border-gray-100";
export const ROSTER_TABLE = "w-max min-w-full border-separate border-spacing-0 text-sm";
export const ROSTER_HEAD_ROW = "text-left text-xs font-medium text-gray-600";
/** 一般表頭格。 */
export const ROSTER_TH = "sticky top-0 z-20 whitespace-nowrap border-b border-gray-200 bg-gray-50 py-2 pr-3";
/** 凍結欄／操作欄的表頭格（再加 left-* 或 right-0）。 */
export const ROSTER_TH_FROZEN = "sticky top-0 z-30 whitespace-nowrap border-b border-gray-200 bg-gray-50 py-2 pr-3";
export const ROSTER_BODY_ROW = "group align-top [&>*]:border-b [&>*]:border-gray-100 last:[&>*]:border-b-0";
/** 內容列的凍結格（再加 left-*；不透明底，hover 時跟著整列變色）。 */
export const ROSTER_TD_FROZEN = "sticky z-10 bg-white group-hover:bg-gray-50";
/** 右側操作欄（內容列）。 */
export const ROSTER_TD_ACTIONS = "sticky right-0 z-10 whitespace-nowrap border-l border-l-gray-100 bg-white py-2 pl-3 pr-2 text-right group-hover:bg-gray-50";
/** 一般內容格（hover 底色由 tr 帶不到 sticky 格，所以一般格也各自上色，顏色才一致）。 */
export const ROSTER_TD_HOVER = "group-hover:bg-gray-50";
