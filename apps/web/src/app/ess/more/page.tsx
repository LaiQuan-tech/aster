"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEssState } from "@/lib/ess-state";
import { moreGroups } from "@/lib/ess-tabs";
import { Button, Card, Icon, Skeleton } from "@/components/ess-ui";
import { essLogout } from "@/components/EssShell";
import {
  getNotifyChannels,
  putNotifyChannels,
  type NotifyChannelPrefs,
} from "@/lib/people-extras-api";

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
 * 通知偏好（M13）：站內通知一律照收，這裡只管**外部通道**（Email／LINE）。
 *
 * 語意是「只有明示關掉才停送」——所以沒設過的人顯示為開啟，存的是明確的
 * true／false。設定存在 `user_preferences` 的 `notify.channels.v1`，投遞端
 * （apps/api/src/services/notification-delivery.ts）在送出前過濾。
 */
function NotifyChannelCard() {
  const [prefs, setPrefs] = useState<NotifyChannelPrefs | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getNotifyChannels()
      .then((value) => {
        if (active) setPrefs(value);
      })
      .catch(() => {
        if (active) setPrefs({});
      });
    return () => {
      active = false;
    };
  }, []);

  async function toggle(channel: "email" | "line") {
    if (!prefs) return;
    const next = { ...prefs, [channel]: prefs[channel] === false };
    setPrefs(next);
    setSaving(channel);
    setError(null);
    try {
      await putNotifyChannels(next);
    } catch (err) {
      setPrefs(prefs); // 存不進去就退回原狀，別讓畫面說謊
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setSaving(null);
    }
  }

  const rows: Array<{ key: "email" | "line"; label: string; hint: string }> = [
    { key: "email", label: "Email 通知", hint: "簽核、公告、提醒寄到你的公司信箱" },
    { key: "line", label: "LINE 通知", hint: "需要先在「我的資料」綁定 LINE" },
  ];

  return (
    <Card title="通知偏好">
      {prefs === null ? (
        <Skeleton lines={2} />
      ) : (
        <ul className="-my-1 divide-y divide-gray-100">
          {rows.map((row) => {
            const on = prefs[row.key] !== false;
            return (
              <li key={row.key} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-base text-gray-800 sm:text-sm">{row.label}</p>
                  <p className="mt-0.5 text-xs text-gray-400">{row.hint}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={row.label}
                  disabled={saving === row.key}
                  onClick={() => void toggle(row.key)}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50 ${
                    on ? "" : "bg-gray-200"
                  }`}
                  style={on ? { backgroundColor: "var(--brand)" } : undefined}
                >
                  <span
                    className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      on ? "left-6" : "left-1"
                    }`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <p className="mt-3 text-xs text-gray-400">站內通知不受這裡影響，一律會收到。</p>
    </Card>
  );
}

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

      <NotifyChannelCard />

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
