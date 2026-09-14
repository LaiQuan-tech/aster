"use client";

/**
 * 月份選擇器：<input type="month"> + 上下月按鈕。value/onChange 一律用 'YYYY-MM'
 * 字串，跟 admin-api / attendance-sheets-api 的 period 參數格式一致。
 */
export function MonthPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  function shift(delta: number) {
    const [y, m] = value.split("-").map(Number);
    if (!y || !m) return;
    const next = new Date(Date.UTC(y, m - 1 + delta, 1));
    onChange(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => shift(-1)}
        disabled={disabled}
        aria-label="上個月"
        className="rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
      >
        ‹
      </button>
      <input
        type="month"
        value={value}
        disabled={disabled}
        onChange={(event) => event.target.value && onChange(event.target.value)}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-gray-400 focus:outline-none disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => shift(1)}
        disabled={disabled}
        aria-label="下個月"
        className="rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
      >
        ›
      </button>
    </div>
  );
}
