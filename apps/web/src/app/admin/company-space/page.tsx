"use client";

/**
 * 站台與內部連結（/admin/company-space）：站台名稱／品牌色（tenants.branding）與員工端「更多」頁的
 * 內部連結（tenants.features.internalLinks）。2026-09 後台簡化：權限項目設定、Dashboard Widget 與
 * 三張統計卡已移除（features.permissions／dashboardWidgets 變 legacy 鍵，後端 zod 與 DB 仍保留）。
 * PUT /api/tenant/settings 的 features 是後端淺層合併，這裡只送 internalLinks（與租戶本來就有的 site），
 * 其他鍵不動；存成功後 invalidateBranding() 讓 AdminShell 側欄的站台名稱同一頁更新。
 * 頁面標題與說明由 AdminShell 依路由表渲染。
 */
import { useEffect, useState, type FormEvent } from "react";
import { Card, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getBranding,
  saveTenantSettings,
  type Branding,
  type InternalLink,
  type TenantFeatures,
} from "@/lib/admin-api";
import { invalidateBranding } from "@/lib/ess-state";

const DEFAULT_BRANDING: Branding = { appName: "亞斯特設計顧問 數位化系統", primaryColor: "#4f46e5" };

type SitePaths = NonNullable<TenantFeatures["site"]>;

/**
 * 送出前只留字串欄位：DB 的 branding 可能帶 logoUrl: null（後端 zod 的 logoUrl 只收 url／""／缺席），
 * 原樣送回去會 400。
 */
function cleanBranding(input: Branding): Branding {
  const out: Branding = {};
  for (const key of ["appName", "primaryColor", "logoUrl"] as const) {
    const value = input[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export default function CompanySpacePage() {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  /** 租戶現有的 features.site（員工入口／管理後台路徑，唯讀顯示）；沒有就不送，靠後端淺層合併保留其他鍵。 */
  const [site, setSite] = useState<SitePaths | undefined>(undefined);
  const [links, setLinks] = useState<InternalLink[]>([]);
  const [linkName, setLinkName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBranding()
      .then((res) => {
        setBranding({ ...DEFAULT_BRANDING, ...(res.branding ?? {}) });
        setSite(res.features?.site ?? undefined);
        setLinks([...(res.features?.internalLinks ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "載入站台設定失敗"));
  }, []);

  async function persist(next?: { branding?: Branding; links?: InternalLink[] }) {
    setError(null);
    setMessage(null);
    const nextBranding = cleanBranding(next?.branding ?? branding);
    const nextLinks = next?.links ?? links;
    try {
      const saved = await saveTenantSettings({
        branding: nextBranding,
        features: { internalLinks: nextLinks, ...(site ? { site } : {}) },
      });
      setBranding({ ...DEFAULT_BRANDING, ...(saved.branding ?? {}) });
      setSite(saved.features?.site ?? site);
      setLinks(saved.features?.internalLinks ?? nextLinks);
      invalidateBranding();
      setMessage("設定已儲存");
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    }
  }

  function addLink(event: FormEvent) {
    event.preventDefault();
    if (!linkName.trim() || !linkUrl.trim()) {
      setError("請輸入連結名稱與 URL");
      return;
    }
    const next = [
      ...links,
      { name: linkName.trim(), url: linkUrl.trim(), enabled: true, sort: links.length + 1 },
    ];
    setLinks(next);
    setLinkName("");
    setLinkUrl("");
    void persist({ links: next });
  }

  function toggleLink(index: number) {
    const next = links.map((link, i) => (i === index ? { ...link, enabled: link.enabled === false } : link));
    setLinks(next);
    void persist({ links: next });
  }

  function removeLink(index: number) {
    const next = links.filter((_, i) => i !== index).map((link, sort) => ({ ...link, sort: sort + 1 }));
    setLinks(next);
    void persist({ links: next });
  }

  return (
    <>
      {message && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}
      {error && <ErrorText>{error}</ErrorText>}

      <Card title="站台設定">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>站台名稱</label>
            <input
              className={inputCls}
              value={branding.appName ?? ""}
              onChange={(event) => setBranding({ ...branding, appName: event.target.value })}
            />
          </div>
          <div>
            <label className={labelCls}>品牌色</label>
            <input
              type="color"
              className="h-10 w-full rounded-md border border-gray-300"
              value={branding.primaryColor ?? "#4f46e5"}
              onChange={(event) => setBranding({ ...branding, primaryColor: event.target.value })}
            />
          </div>
          <div>
            <label className={labelCls}>員工入口</label>
            <input className={inputCls} value={site?.employeePortalPath ?? "/ess"} readOnly />
          </div>
          <div>
            <label className={labelCls}>管理後台</label>
            <input className={inputCls} value={site?.adminPortalPath ?? "/admin"} readOnly />
          </div>
        </div>
        <div className="mt-4">
          <PrimaryButton onClick={() => void persist({ branding })}>儲存站台設定</PrimaryButton>
        </div>
      </Card>

      <Card title="內部連結">
        <form onSubmit={addLink} className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <input className={inputCls} placeholder="連結名稱" value={linkName} onChange={(event) => setLinkName(event.target.value)} />
          <input className={inputCls} placeholder="https://example.com" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} />
          <PrimaryButton type="submit">新增</PrimaryButton>
        </form>
        {links.length === 0 ? (
          <Empty>尚無內部連結</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {links.map((link, index) => (
              <li key={`${link.name}-${index}`} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-gray-800">{link.name}</p>
                  <a className="break-all text-gray-500 hover:underline" href={link.url} target="_blank" rel="noreferrer">
                    {link.url}
                  </a>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <button type="button" onClick={() => toggleLink(index)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                    {link.enabled === false ? "啟用" : "停用"}
                  </button>
                  <button type="button" onClick={() => removeLink(index)} className="text-sm text-red-600 hover:underline">
                    刪除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
