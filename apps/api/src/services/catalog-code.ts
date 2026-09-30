import { createHash } from "node:crypto"

/** Stable storage key for tenant-maintained options; users only need to provide a label. */
export function catalogCode(label: string): string {
  const normalized = label.trim().normalize("NFKC").toLocaleLowerCase("en-US")
  return `option_${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`
}
