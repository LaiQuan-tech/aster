"use client";

import { inputCls } from "@/components/admin-ui";
import type { Vendor } from "@/lib/company-api";

/** 廠商挑選：可選名冊裡的 vendor，也可以直接輸入自由文字名稱。兩者並存
 * （選了 vendor 就把名稱一併帶入，之後改名冊不影響這裡已存的字串）。 */
export function VendorCombo({
  vendors,
  vendorId,
  name,
  onChange,
}: {
  vendors: Vendor[];
  vendorId: string | null | undefined;
  name: string | null | undefined;
  onChange: (v: { vendorId: string | null; name: string | null }) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <select
        className={`${inputCls} text-xs`}
        value={vendorId ?? ""}
        onChange={(e) => {
          const vid = e.target.value || null;
          const v = vendors.find((x) => x.id === vid);
          onChange({ vendorId: vid, name: v ? v.name : (name ?? null) });
        }}
      >
        <option value="">自由輸入／未建檔</option>
        {vendors.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </select>
      <input
        className={`${inputCls} text-xs`}
        value={name ?? ""}
        placeholder="名稱"
        onChange={(e) => onChange({ vendorId: vendorId ?? null, name: e.target.value })}
      />
    </div>
  );
}
