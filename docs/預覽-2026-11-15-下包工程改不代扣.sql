-- ═══════════════════════════════════════════════════════════════════════════
-- 預覽（唯讀）：舊「下包工程」副委託改為不代扣 — 2026-11-15
-- ═══════════════════════════════════════════════════════════════════════════
-- 用途：在跑「套用-2026-11-15-下包工程改不代扣.sql」之前，先看會改哪幾筆、哪幾筆不在範圍。
-- 本檔只有 SELECT，第一行就把交易設成唯讀，不會改任何資料。
-- 只輸出副委託 id、專案編號（projects.code）、代扣率與金額，不含廠商名稱等個資。
--
-- 資料模型（見 apps/api/src/routes/subcontracts.ts、services/project-money.ts）：
--   project_subcontracts          kind='subcontract'（下包工程）／'technician'（技師簽證費）／'firm'（事務所）
--                                 withholding_rate（numeric，0.10＝10%）、withholding_threshold（預設 20000）
--                                 withholding_date（代扣日期，只有 firm 會填）、deleted_at（軟刪除）
--   project_subcontract_payments  每期：amount（系統試算毛額）、override_amount、withheld_amount（代扣）、
--                                 paid_on／paid_amount（已付）、accepted_on（已驗收）、disbursement_id（放款單）
--   disbursements／disbursement_allocations：放款單與分攤；status ∈ draft／pending_approval／approved／paid／void
--
-- 系統重算規則（recomputePayments）：未付期別 withheld_amount = 每期毛額 > 門檻 ? round(毛額 × 代扣率) : 0；
-- 代扣率改 0 ⇒ 所有未付期別的 withheld_amount 一律 0；期款 amount 只跟下包金額與百分比有關，不受代扣率影響。
-- 實付淨額不落 DB（顯示時＝毛額 − withheld_amount），所以只有 withheld_amount 要動。
--
-- 分類（每個 kind='subcontract' 的副委託一列）：
--   A 本次會改      ：活列、活專案，(代扣率≠0 或 有未付期別仍存代扣金額)，且沒有任何一期已付款／已驗收／
--                     排入非作廢放款單，也沒有代扣日期
--   B 不在範圍      ：同上但「任一期已付款／已驗收／排入非作廢放款單，或已有代扣日期」→ 改了會與已發生的錢不一致
--   C 已刪除        ：副委託或所屬專案已軟刪除（觸發器會擋，也不需要改）
--   D 已是不代扣    ：代扣率已是 0、未付期別也沒有代扣金額
-- ═══════════════════════════════════════════════════════════════════════════
set transaction read only;

with params as (
  select '0507ad78-27f4-480e-b99f-a72db2aee50c'::uuid as tid
),
subs as (
  select s.id, s.project_id, p.code as project_code, s.withholding_rate, s.withholding_threshold,
         s.withholding_date, s.amount as contract_amount,
         (s.deleted_at is not null) as sub_deleted, (p.deleted_at is not null) as project_deleted
    from public.project_subcontracts s
    join params on s.tenant_id = params.tid
    join public.projects p on p.id = s.project_id and p.tenant_id = s.tenant_id
   where s.kind = 'subcontract'
),
pay as (
  select sp.subcontract_id,
         count(*)                                                                as n_payments,
         coalesce(sum(sp.withheld_amount), 0)                                    as withheld_all,
         coalesce(sum(sp.withheld_amount) filter (where sp.paid_on is null), 0)  as withheld_unpaid,
         count(*) filter (where sp.paid_on is not null or sp.paid_amount is not null) as n_paid,
         count(*) filter (where sp.accepted_on is not null)                      as n_accepted,
         count(*) filter (where
              exists (select 1 from public.disbursements d
                       where d.id = sp.disbursement_id and d.status <> 'void')
           or exists (select 1 from public.disbursement_allocations a
                        join public.disbursements d on d.id = a.disbursement_id
                       where a.subcontract_payment_id = sp.id and d.status <> 'void')) as n_in_disbursement
    from public.project_subcontract_payments sp
    join params on sp.tenant_id = params.tid
   group by sp.subcontract_id
),
sub_alloc as (  -- 分攤直接掛在副委託上（沒指定期別）的非作廢放款單
  select a.subcontract_id, count(*) as n
    from public.disbursement_allocations a
    join params on a.tenant_id = params.tid
    join public.disbursements d on d.id = a.disbursement_id and d.status <> 'void'
   where a.subcontract_id is not null
   group by a.subcontract_id
),
classified as (
  select s.*,
         coalesce(pay.n_payments, 0)        as n_payments,
         coalesce(pay.withheld_all, 0)      as withheld_all,
         coalesce(pay.withheld_unpaid, 0)   as withheld_unpaid,
         coalesce(pay.n_paid, 0)            as n_paid,
         coalesce(pay.n_accepted, 0)        as n_accepted,
         coalesce(pay.n_in_disbursement, 0) + coalesce(sa.n, 0) as n_in_disbursement,
         case
           when s.sub_deleted or s.project_deleted then 'C 已刪除（排除）'
           when s.withholding_rate = 0 and coalesce(pay.withheld_unpaid, 0) = 0 then 'D 已是不代扣（不需改）'
           when coalesce(pay.n_paid, 0) > 0 or coalesce(pay.n_accepted, 0) > 0
             or coalesce(pay.n_in_disbursement, 0) + coalesce(sa.n, 0) > 0
             or s.withholding_date is not null then 'B 不在範圍（已付款／已驗收／已排放款單／已有代扣日期）'
           else 'A 本次會改'
         end as grp
    from subs s
    left join pay on pay.subcontract_id = s.id
    left join sub_alloc sa on sa.subcontract_id = s.id
)
select *
  from (
    -- 明細：每個副委託一列
    select grp                                   as "分類",
           id::text                              as "副委託id",
           project_code                          as "專案編號",
           contract_amount                       as "下包金額",
           withholding_rate                      as "目前代扣率",
           n_payments                            as "期數",
           withheld_all                          as "目前代扣金額(全部期)",
           withheld_unpaid                       as "目前代扣金額(未付期)",
           case when grp like 'A%' then 0::numeric else null end as "改後代扣金額",
           concat_ws('、',
             case when n_paid > 0 then '已付款 ' || n_paid || ' 期' end,
             case when n_accepted > 0 then '已驗收 ' || n_accepted || ' 期' end,
             case when n_in_disbursement > 0 then '放款單 ' || n_in_disbursement || ' 筆' end,
             case when withholding_date is not null then '已有代扣日期' end,
             case when sub_deleted then '副委託已刪' end,
             case when project_deleted then '專案已刪' end) as "不在範圍原因",
           0 as sort_key
      from classified
     where grp not like 'D%'
    union all
    -- 合計：每個分類一列
    select grp, '（合計）', count(*)::text || ' 筆副委託', sum(contract_amount), null,
           sum(n_payments), sum(withheld_all), sum(withheld_unpaid),
           case when grp like 'A%' then 0::numeric else null end, null, 1
      from classified
     group by grp
  ) x
 order by sort_key, "分類", "專案編號", "副委託id";

-- 結果空白＝這個租戶目前沒有任何 kind='subcontract' 的副委託。
-- 只看到「D 已是不代扣」的合計列＝已經全部是不代扣，套用檔不需要跑（跑了也是 0 列）。
