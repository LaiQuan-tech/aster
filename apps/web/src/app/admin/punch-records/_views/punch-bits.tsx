"use client";

import { useEffect, useRef, useState } from "react";
import { TONE_CLASS, locationIssue, punchDetail, punchTimeLabel, type OverviewTag, type PunchBrief } from "@/lib/punch-overview";

export function Tag({ tag, small = false }: { tag: Pick<OverviewTag, "label" | "tone">; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full ring-1 ring-inset ${TONE_CLASS[tag.tone]} ${
        small ? "px-1.5 py-0 text-[11px] leading-[18px]" : "px-2 py-0.5 text-xs font-medium"
      }`}
    >
      {tag.label}
    </span>
  );
}

/** 無定位／定位逾時的小圖示（補登、LINE 不標）。 */
export function LocationIcon({ punch }: { punch: PunchBrief | null }) {
  const issue = locationIssue(punch);
  if (!issue) return null;
  const title = issue === "timeout" ? "定位逾時" : "無定位";
  return (
    <span title={title} aria-label={title} className="ml-1 inline-flex align-middle text-amber-600">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 1 0-9 0C3.5 9.8 8 14 8 14Z" />
        {issue === "timeout" ? <path d="M8 4.5v2.2l1.4 1" /> : <path d="M3 3l10 10" />}
      </svg>
    </span>
  );
}

/** 打卡時間：點開看該筆打卡的方式、地點與 IP（popover）。 */
export function PunchTime({
  punch,
  dayKey,
  tz,
  label,
  showIp = false,
  className = "",
}: {
  punch: PunchBrief | null;
  dayKey: string;
  tz: string;
  label: string;
  /** 只有 HR 拿得到 IP；非 HR 整行不顯示。 */
  showIp?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!punch) return <span className={`text-gray-300 ${className}`}>--:--</span>;
  const detail = punchDetail(punch);
  return (
    <span ref={ref} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${label} ${punchTimeLabel(punch.at, dayKey, tz)}，查看${showIp ? "地點與 IP" : "地點"}`}
        className="rounded px-0.5 font-medium tabular-nums text-gray-900 underline decoration-gray-300 decoration-dotted underline-offset-4 hover:bg-gray-100"
      >
        {punchTimeLabel(punch.at, dayKey, tz)}
      </button>
      <LocationIcon punch={punch} />
      {open && (
        <span
          role="dialog"
          aria-label={`${label}打卡明細`}
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-gray-200 bg-white p-3 text-left text-xs text-gray-700 shadow-lg"
        >
          <span className="mb-1 block font-semibold text-gray-900">{label}　{punchTimeLabel(punch.at, dayKey, tz)}</span>
          <span className="block">方式：{detail.source}{punch.wfh ? "（在家）" : ""}</span>
          <span className="block">地點：{detail.location}</span>
          {showIp && <span className="block break-all">IP：<span className="font-mono">{detail.ip}</span></span>}
        </span>
      )}
    </span>
  );
}
