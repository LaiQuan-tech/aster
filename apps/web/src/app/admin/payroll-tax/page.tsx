import { redirect } from "next/navigation";

/**
 * 舊網址：稅務申報已併入「費用與給付」（/admin/expenses，2026-11-09）。正式的轉址在 next.config 的
 * ADMIN_REDIRECTS；這個薄頁只是保底（轉址表還沒更新、或直接命中路由時），原本的查詢參數一併帶過去。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === "string") params.set(k, v);
  }
  params.set("section", "tax");
  redirect(`/admin/expenses?${params.toString()}`);
}
