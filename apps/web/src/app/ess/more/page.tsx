"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEssState } from "@/lib/ess-state";
import { moreGroups } from "@/lib/ess-tabs";
import { Button, Card, Icon, Skeleton } from "@/components/ess-ui";
import { essLogout } from "@/components/EssShell";

/** tenants.features.internalLinks 的一筆（後台「模組設定」維護）。 */
interface InternalLink {
  name: string;
  url: string;
  enabled?: boolean;
  sort?: number;
}

/** 讀法沿用舊首頁：略過 enabled === false，依 sort 排序；格式不對就當沒有。 */
function internalLinksOf(features: Record<string, unknown> | null): InternalLink[] {
  const raw = features?.internalLinks;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .filter(
      (link): link is InternalLink =>
        !!link &&
        typeof link === "object" &&
        typeof (link as InternalLink).name === "string" &&
        typeof (link as InternalLink).url === "string",
    )
    .filter((link) => link.enabled !== false)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
}

const rowCls =
  "flex min-h-12 items-center justify-between gap-3 px-1 py-2.5 text-base text-gray-800 active:bg-gray-50 sm:text-sm";

/**
 * 「更多」頁：底列放不下的分頁分組列出（依 essTabs 限縮、空組不顯示、底列 key 不重列）、
 * 內部連結、使用者卡、後台管理（isAdmin）、登出。本頁不受 essTabs 限縮。
 */
export default function EssMorePage() {
  const state = useEssState();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  const groups = moreGroups(state.essTabs);
  const links = internalLinksOf(state.features);
  const me = state.me;

  async function onLogout() {
    setLoggingOut(true);
    await essLogout(router);
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <Card key={group.title} title={group.title}>
          <ul className="-my-1 divide-y divide-gray-100">
            {group.items.map((item) => (
              <li key={item.key}>
                <Link href={item.href} className={rowCls}>
                  <span>{item.label}</span>
                  <Icon name="chevron" className="h-5 w-5 text-gray-300" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ))}

      {links.length > 0 && (
        <Card title="內部連結">
          <ul className="-my-1 divide-y divide-gray-100">
            {links.map((link) => (
              <li key={`${link.name}-${link.url}`}>
                <a href={link.url} target="_blank" rel="noreferrer" className={rowCls}>
                  <span className="truncate">{link.name}</span>
                  <Icon name="chevron" className="h-5 w-5 shrink-0 text-gray-300" />
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        {state.loaded || me ? (
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-gray-900">{me?.name ?? "—"}</p>
            <p className="mt-0.5 truncate text-sm text-gray-500">
              {[me?.empNo, me?.email].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
        ) : (
          <Skeleton lines={2} />
        )}
        {state.isAdmin && (
          <Link
            href="/admin"
            className="mt-4 flex min-h-11 items-center justify-center rounded-xl border text-sm font-medium"
            style={{ borderColor: "var(--brand)", color: "var(--brand)" }}
          >
            後台管理
          </Link>
        )}
        <Button variant="ghost" size="md" block className="mt-3 text-gray-600" onClick={onLogout} loading={loggingOut}>
          <Icon name="logout" className="h-5 w-5" />
          登出
        </Button>
      </Card>
    </div>
  );
}
