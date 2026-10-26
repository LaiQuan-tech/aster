-- 客供商名冊搬遷：唯讀匯出（給 docs/test/roster-excel-fields-migrate.ts 的 --db）。
-- 只匯出指定租戶（下面 t 的 tenant_id；預設＝正式租戶 0507ad78-…，要換租戶改這一行）未刪除的客戶／廠商；
-- 銀行帳戶與名片路徑不匯出。搬遷腳本的 --tenant 要給同一個值（不一致會直接報錯）。
-- ⚠️ 結果含個資：存到 repo 外（例：bash ~/.cache/aster-mgmt/q.sh docs/test/roster-excel-fields-dump.sql > <scratch>/roster-db.json）。
set transaction read only;
with t as (
  select '0507ad78-27f4-480e-b99f-a72db2aee50c'::uuid as tenant_id
)
select json_build_object(
  'tenantId', (select tenant_id from t),
  'vendors', coalesce((
    select json_agg(to_jsonb(v) - 'bank_name' - 'bank_code' - 'bank_account' - 'account_holder' - 'card_storage_path' order by v.created_at)
    from public.vendors v where v.deleted_at is null and v.tenant_id in (select tenant_id from t)
  ), '[]'::json),
  'clients', coalesce((
    select json_agg(to_jsonb(c) order by c.created_at)
    from public.clients c where c.deleted_at is null and c.tenant_id in (select tenant_id from t)
  ), '[]'::json)
) as dump;
