-- 客供商名冊搬遷：唯讀匯出（給 docs/test/roster-excel-fields-migrate.ts 的 --db）。
-- 只匯出「有 10/12 匯入標記的租戶」未刪除的客戶／廠商；銀行帳戶與名片路徑不匯出。
-- ⚠️ 結果含個資：存到 repo 外（例：bash ~/.cache/aster-mgmt/q.sh docs/test/roster-excel-fields-dump.sql > <scratch>/roster-db.json）。
set transaction read only;
with t as (
  select tenant_id from public.vendors where note like '%由客供商基本資料匯入%'
  union
  select tenant_id from public.clients where note like '%由客供商基本資料匯入%'
)
select json_build_object(
  'vendors', coalesce((
    select json_agg(to_jsonb(v) - 'bank_name' - 'bank_code' - 'bank_account' - 'account_holder' - 'card_storage_path' order by v.created_at)
    from public.vendors v where v.deleted_at is null and v.tenant_id in (select tenant_id from t)
  ), '[]'::json),
  'clients', coalesce((
    select json_agg(to_jsonb(c) order by c.created_at)
    from public.clients c where c.deleted_at is null and c.tenant_id in (select tenant_id from t)
  ), '[]'::json)
) as dump;
