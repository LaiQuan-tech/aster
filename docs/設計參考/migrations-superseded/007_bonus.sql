-- 007_bonus.sql — 獎金（三節／年終／績效／專案）
-- 亞斯特 ERP / 2026-08-25
--
-- 設計要點：
-- 1. 系統算的金額與人工調整後的金額分兩欄並存，永不互相覆蓋。
--    老闆的裁示權是需求，但「調了多少、為什麼、誰調的」必須留得下來——
--    否則明年沒有人記得今年為何是這個數字。
-- 2. 獎金屬薪資所得，須併入當期薪資計稅，故發放一律經 payroll_items，
--    不另開一條繞過扣繳的給付管道。
-- 3. 專案連動（隨收款分期拆發）留待專案模組上線，此處先把資料結構備好：
--    bonus_batches.source_type = 'project' + bonus_awards.allocation_percentage。

create table bonus_types (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,
  name                  text not null,
  is_taxable            boolean not null default true,
  requires_boss_approval boolean not null default true,
  sort_order            int not null default 0,
  is_active             boolean not null default true
);

insert into bonus_types (code, name, sort_order) values
  ('year_end',    '年終獎金', 10),
  ('dragon_boat', '端午獎金', 20),
  ('mid_autumn',  '中秋獎金', 30),
  ('performance', '績效獎金', 40),
  ('project',     '專案獎金', 50),
  ('discretionary','特別獎金', 60);

-- 一次發放作業
create table bonus_batches (
  id                uuid primary key default gen_random_uuid(),
  bonus_type_id     uuid not null references bonus_types(id),
  name              text not null,          -- 「2026 年終獎金」
  year              int not null,
  source_type       text not null default 'discretionary',
                    -- discretionary 老闆核定 | formula 公式計算 | project 專案連動
  total_budget      numeric(14,2),
  -- 掛哪一期薪資發放（獎金併入該期計稅）
  payroll_period_id uuid references payroll_periods(id),
  status            text not null default 'draft',
                    -- draft|allocating|pending_approval|approved|paid
  is_imported       boolean not null default false,   -- 系統上線前的歷史資料
  created_by        uuid references employees(id),
  approved_by       uuid references employees(id),
  approved_at       timestamptz,
  paid_at           date,
  notes             text,
  created_at        timestamptz not null default now(),
  constraint bonus_batch_status_check
    check (status in ('draft','allocating','pending_approval','approved','paid'))
);

create index idx_bonus_batch_year on bonus_batches(year desc, bonus_type_id);

-- 個人獎金
create table bonus_awards (
  id                    uuid primary key default gen_random_uuid(),
  batch_id              uuid not null references bonus_batches(id) on delete cascade,
  employee_id           uuid not null references employees(id),
  role_in_batch         text,                       -- manager|lead|support（專案獎金用）
  allocation_percentage numeric(6,3),               -- 分配趴數（專案獎金用）

  -- ★ 系統算的 vs 老闆調的，兩欄並存
  calculated_amount     numeric(14,2) not null default 0,
  calculation_note      text,                       -- 怎麼算出來的
  adjusted_amount       numeric(14,2),
  adjustment_reason     text,
  adjusted_by           uuid references employees(id),
  adjusted_at           timestamptz,
  final_amount          numeric(14,2)
                          generated always as
                          (coalesce(adjusted_amount, calculated_amount)) stored,

  status                text not null default 'pending',
                        -- pending|approved|paid|withheld
  withhold_reason       text,                       -- 保留：離職待議、考績未定
  payroll_item_id       uuid references payroll_items(id),
  paid_at               date,
  created_at            timestamptz not null default now(),
  unique (batch_id, employee_id, role_in_batch)
);

create index idx_bonus_award_emp on bonus_awards(employee_id);
create index idx_bonus_award_batch on bonus_awards(batch_id);
create index idx_bonus_award_adjusted on bonus_awards(batch_id)
  where adjusted_amount is not null;

comment on column bonus_awards.adjustment_reason is
  '調整理由。UI 應設為必填——沒有理由的調整在明年爭議時等於沒有調整過。';

-- 分配比例合計檢核（專案獎金：同批次同角色群總和應為 100%）
create or replace function check_bonus_allocation(p_batch_id uuid)
returns table (total_percentage numeric, is_valid boolean, message text)
language sql stable
as $$
  select
    coalesce(sum(allocation_percentage), 0),
    coalesce(sum(allocation_percentage), 0) = 100,
    case
      when coalesce(sum(allocation_percentage), 0) = 100 then '分配比例正確'
      when coalesce(sum(allocation_percentage), 0) = 0 then '未使用比例分配'
      else format('分配比例合計 %s%%，應為 100%%',
                  coalesce(sum(allocation_percentage), 0))
    end
  from bonus_awards
  where batch_id = p_batch_id and allocation_percentage is not null;
$$;

-- 依總額與比例試算各人金額
create or replace function calculate_bonus_by_allocation(p_batch_id uuid)
returns int
language plpgsql
as $$
declare
  v_batch bonus_batches%rowtype;
  v_count int;
begin
  select * into v_batch from bonus_batches where id = p_batch_id;
  if v_batch.status in ('approved','paid') then
    raise exception '批次已核定，不得重算';
  end if;
  if v_batch.total_budget is null then
    raise exception '未設定獎金總額，無法依比例計算';
  end if;

  update bonus_awards
     set calculated_amount = round(v_batch.total_budget * allocation_percentage / 100, 0),
         calculation_note = format('總額 %s × %s%%',
                                   v_batch.total_budget, allocation_percentage)
   where batch_id = p_batch_id
     and allocation_percentage is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 老闆裁示調整（留痕）
create or replace function adjust_bonus_award(
  p_award_id uuid, p_new_amount numeric, p_reason text, p_operator_id uuid
) returns void
language plpgsql
as $$
declare v_award bonus_awards%rowtype;
begin
  select * into v_award from bonus_awards where id = p_award_id for update;
  if v_award.id is null then
    raise exception '獎金紀錄不存在';
  end if;
  if v_award.status = 'paid' then
    raise exception '已發放的獎金不得調整';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 2 then
    raise exception '調整獎金必須填寫理由';
  end if;

  update bonus_awards
     set adjusted_amount = p_new_amount,
         adjustment_reason = p_reason,
         adjusted_by = p_operator_id,
         adjusted_at = now()
   where id = p_award_id;
end;
$$;

-- ============================================================
-- 歷史對比（發放前一鍵拉出該員歷年獎金）
-- ============================================================

create view v_employee_bonus_history as
select
  ba.employee_id,
  e.employee_no,
  e.name as employee_name,
  bb.year,
  bt.code as bonus_type_code,
  bt.name as bonus_type_name,
  sum(ba.final_amount) as amount,
  max(bb.paid_at) as paid_at,
  bool_or(ba.adjusted_amount is not null) as was_adjusted
from bonus_awards ba
join bonus_batches bb on bb.id = ba.batch_id
join bonus_types bt on bt.id = bb.bonus_type_id
join employees e on e.id = ba.employee_id
where ba.status <> 'withheld'
group by ba.employee_id, e.employee_no, e.name, bb.year, bt.code, bt.name;

-- 某員工近 N 年各類獎金，供發放時對比
create or replace function get_bonus_comparison(
  p_employee_id uuid, p_years int default 3
) returns table (
  year int, bonus_type_name text, amount numeric, was_adjusted boolean
)
language sql stable
as $$
  select h.year, h.bonus_type_name, h.amount, h.was_adjusted
  from v_employee_bonus_history h
  where h.employee_id = p_employee_id
    and h.year >= extract(year from current_date)::int - p_years
  order by h.year desc, h.bonus_type_name;
$$;

-- ============================================================
-- 併入薪資：覆蓋 006 的 stub
-- ============================================================

create or replace function get_period_bonus(p_employee_id uuid, p_period_id uuid)
returns numeric
language sql stable
as $$
  select coalesce(sum(ba.final_amount), 0)
  from bonus_awards ba
  join bonus_batches bb on bb.id = ba.batch_id
  where ba.employee_id = p_employee_id
    and bb.payroll_period_id = p_period_id
    and bb.status in ('approved','paid')
    and ba.status in ('approved','paid');
$$;

-- 核定批次：鎖定金額並掛入薪資期間
create or replace function approve_bonus_batch(
  p_batch_id uuid, p_approver_id uuid
) returns int
language plpgsql
as $$
declare
  v_batch bonus_batches%rowtype;
  v_count int;
begin
  select * into v_batch from bonus_batches where id = p_batch_id for update;
  if v_batch.status = 'paid' then
    raise exception '批次已發放';
  end if;
  if v_batch.payroll_period_id is null then
    raise exception '尚未指定發放的薪資期間，獎金無法併入計稅';
  end if;

  update bonus_awards
     set status = 'approved'
   where batch_id = p_batch_id and status = 'pending';
  get diagnostics v_count = row_count;

  update bonus_batches
     set status = 'approved', approved_by = p_approver_id, approved_at = now()
   where id = p_batch_id;

  return v_count;
end;
$$;
