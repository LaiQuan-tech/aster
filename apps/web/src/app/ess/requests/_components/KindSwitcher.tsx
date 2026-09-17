"use client";

import { Segmented } from "@/components/ess-ui";
import type { RequestKind } from "@/lib/ess-api";
import { KIND_ORDER, KIND_SHORT } from "@/lib/request-forms";

const OPTIONS = KIND_ORDER.map((kind) => ({ value: kind, label: KIND_SHORT[kind] }));

/** 申請種類切換：請假｜補卡｜加班｜公出｜預支（深連結 `?kind=`）。 */
export function KindSwitcher({ value, onChange }: { value: RequestKind; onChange: (kind: RequestKind) => void }) {
  return <Segmented<RequestKind> aria-label="申請種類" options={OPTIONS} value={value} onChange={onChange} />;
}
