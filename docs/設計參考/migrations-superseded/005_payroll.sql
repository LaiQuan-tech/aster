-- 005_payroll.sql — 薪資（月薪僱傭）與外包承攬給付
-- 亞斯特 ERP / 2026-08-25
--
-- 兩條給付路徑，資料完全分開：
--   僱傭員工 → payroll_items（薪資所得，勞健保、勞退、扣繳稅額表）
--   外包承攬 → contractor_payments（執行業務所得 9B，扣繳 10% + 補充保費 2.11%）
-- 混用這兩條是「假承攬真僱傭」的起點，schema 層面就不給混。
--
-- 導入期採平行雙軌：payroll_periods.parallel_run = true 時，
-- 系統照算但不視為正式數字，與會計的 Excel 逐人比對，差異歸零才切換。

-- ============================================================
-- 薪資基本設定
-- ============================================================

create table salary_profiles (
  id                      uuid primary key default gen_random_uuid(),
  employee_id             uuid not null references employees(id),
  effective_from          date not null,
  effective_to            date,                    -- null = 現行
  base_salary             numeric(14,2) not null,  -- 月薪（本薪）
  meal_allowance          numeric(14,2) not null default 0,   -- 伙食津貼（免稅額度內）
  position_allowance      numeric(14,2) not null default 0,
  other_allowance         numeric(14,2) not null default 0,
  -- 投保：實際投保金額可能與本薪不同（級距制），故獨立存放並記錄依據
  labor_insured_amount    numeric(14,2),
  health_insured_amount   numeric(14,2),
  pension_insured_amount  numeric(14,2),
  pension_self_rate       numeric(5,4) not null default 0,    -- 勞退自提 0-0.06
  dependents_count        int not null default 0,             -- 眷屬健保（計費上限 3 口）
  tax_dependents          int not null default 0,             -- 扶養親屬數（查扣繳稅額表用）
  bank_account_enc        text,
  change_reason           text,
  created_by              uuid references employees(id),
  created_at              timestamptz not null default now(),
  constraint pension_self_rate_range check (pension_self_rate between 0 and 0.06),
  constraint dependents_nonneg check (dependents_count >= 0)
);

create index idx_salary_profile_emp on salary_profiles(employee_id, effective_from desc);

-- 某日生效的薪資設定
create or replace function get_salary_profile(p_employee_id uuid, p_date date)
returns salary_profiles
language sql stable
as $$
  select * from salary_profiles
  where employee_id = p_employee_id
    and effective_from <= p_date
    and (effective_to is null or effective_to >= p_date)
  order by effective_from desc
  limit 1;
$$;

-- 薪資所得扣繳稅額表（財政部年度公告，須匯入）
create table withholding_tax_table (
  id              uuid primary key default gen_random_uuid(),
  tax_year        int not null,
  dependents      int not null,            -- 扶養親屬數 0..N
  salary_from     numeric(14,2) not null,
  salary_to       numeric(14,2),
  tax_amount      numeric(14,2) not null,
  unique (tax_year, dependents, salary_from)
);
comment on table withholding_tax_table is
  '[需匯入] 財政部「薪資所得扣繳稅額表」。未匯入時 calculate_payroll_item 的所得稅為 0，'
  '並在薪資單標記 tax_table_missing——寧可標記缺漏，不要用猜的稅額發薪。';

-- ============================================================
-- 薪資期間與薪資單
-- ============================================================

create table payroll_periods (
  id                uuid primary key default gen_random_uuid(),
  year              int not null,
  month             int not null,
  period_start      date not null,
  period_end        date not null,
  pay_date          date,
  status            text not null default 'draft',
                    -- draft 試算 | pending_review 待審 | approved 已核定 | paid 已發放
  parallel_run      boolean not null default true,   -- 導入期雙軌
  calculated_at     timestamptz,
  calculated_by     uuid references employees(id),
  reviewed_by       uuid references employees(id),
  approved_by       uuid references employees(id),
  approved_at       timestamptz,
  paid_at           timestamptz,
  notes             text,
  unique (year, month),
  constraint payroll_status_check
    check (status in ('draft','pending_review','approved','paid'))
);

create table payroll_items (
  id                  uuid primary key default gen_random_uuid(),
  period_id           uuid not null references payroll_periods(id) on delete cascade,
  employee_id         uuid not null references employees(id),
  paying_company_id   uuid not null references companies(id),

  -- 給付項目
  base_salary         numeric(14,2) not null default 0,
  overtime_pay        numeric(14,2) not null default 0,
  meal_allowance      numeric(14,2) not null default 0,
  other_allowance     numeric(14,2) not null default 0,
  bonus_amount        numeric(14,2) not null default 0,   -- 由獎金模組帶入
  gross_pay           numeric(14,2) not null default 0,

  -- 扣除項目
  labor_insurance     numeric(14,2) not null default 0,
  health_insurance    numeric(14,2) not null default 0,
  pension_self        numeric(14,2) not null default 0,   -- 勞退自提
  income_tax          numeric(14,2) not null default 0,
  leave_deduction     numeric(14,2) not null default 0,
  advance_offset      numeric(14,2) not null default 0,
  other_deduction     numeric(14,2) not null default 0,
  total_deduction     numeric(14,2) not null default 0,

  net_pay             numeric(14,2) not null default 0,

  -- 雇主負擔（不進員工薪資條，但公司要看成本）
  employer_labor      numeric(14,2) not null default 0,
  employer_health     numeric(14,2) not null default 0,
  employer_pension    numeric(14,2) not null default 0,

  -- 平行雙軌比對
  manual_net_pay      numeric(14,2),
  variance            numeric(14,2)
                        generated always as
                        (net_pay - coalesce(manual_net_pay, net_pay)) stored,
  variance_note       text,

  calc_flags          text[] not null default '{}',
                      -- tax_table_missing | grade_missing | no_attendance | partial_month
  email_sent_at       timestamptz,
  calculated_at       timestamptz not null default now(),
  unique (period_id, employee_id)
);

create index idx_payroll_item_emp on payroll_items(employee_id);
create index idx_payroll_item_variance on payroll_items(period_id)
  where variance <> 0;

create table payroll_item_details (
  id              uuid primary key default gen_random_uuid(),
  payroll_item_id uuid not null references payroll_items(id) on delete cascade,
  category        text not null,      -- earning | deduction | employer_cost
  code            text not null,
  label           text not null,
  quantity        numeric(10,2),      -- 時數/日數
  rate            numeric(14,4),      -- 單價/倍率
  amount          numeric(14,2) not null,
  source_ref      text,               -- 追溯：哪幾天的加班、哪張請假單
  sort_order      int not null default 0
);
comment on table payroll_item_details is
  '薪資條明細。員工問「為什麼這個月少了 1,200」時，要能直接指出是哪一筆——'
  '只給總額的薪資條會把每次疑問變成一次人工查帳。';

-- ============================================================
-- 外包承攬給付（執行業務所得）
-- ============================================================

create table contractor_payments (
  id                  uuid primary key default gen_random_uuid(),
  payment_no          text unique,
  contractor_id       uuid not null references contractors(id),
  paying_company_id   uuid not null references companies(id),
  paying_bank_account_id uuid references bank_accounts(id),
  project_ref         text,                    -- 專案模組上線後轉 FK
  service_period_start date,
  service_period_end   date,
  description         text,

  gross_amount        numeric(14,2) not null,
  -- 依 withholding_rules 計算；未達起扣點者為 0
  withholding_tax     numeric(14,2) not null default 0,
  supplement_premium  numeric(14,2) not null default 0,
  other_deduction     numeric(14,2) not null default 0,
  net_amount          numeric(14,2) not null,

  income_type         text not null default '9B',
  tax_year            int,                     -- 各類所得扣繳暨免扣繳憑單年度
  status              text not null default 'pending',
                      -- pending|approved|paid
  approved_by         uuid references employees(id),
  approved_at         timestamptz,
  paid_at             date,
  voucher_url         text,
  created_at          timestamptz not null default now()
);

create index idx_contractor_pay_ctr on contractor_payments(contractor_id, paid_at desc);
create index idx_contractor_pay_year on contractor_payments(tax_year, contractor_id);

-- 依規則計算扣繳與補充保費
create or replace function calc_contractor_deductions(
  p_gross numeric, p_income_type text, p_date date
) returns table (withholding numeric, supplement numeric, net numeric)
language plpgsql stable
as $$
declare v_rule withholding_rules%rowtype;
        v_wh numeric := 0;
        v_sp numeric := 0;
begin
  select * into v_rule
  from withholding_rules
  where income_type = p_income_type
    and effective_from <= p_date
    and (effective_to is null or effective_to >= p_date)
  order by effective_from desc
  limit 1;

  if v_rule.id is null then
    raise exception '找不到 % 於 % 適用的扣繳規則', p_income_type, p_date;
  end if;

  -- 起扣點：未達門檻不扣繳（非一律 10%）
  if p_gross >= v_rule.min_payment then
    v_wh := round(p_gross * v_rule.withholding_rate, 0);
  end if;

  if v_rule.supplement_min is not null and p_gross >= v_rule.supplement_min then
    v_sp := round(p_gross * v_rule.supplement_rate, 0);
  end if;

  return query select v_wh, v_sp, p_gross - v_wh - v_sp;
end;
$$;

create or replace function trg_contractor_payment_calc()
returns trigger language plpgsql as $$
declare r record;
begin
  select * into r from calc_contractor_deductions(
    new.gross_amount, new.income_type,
    coalesce(new.paid_at, current_date));
  new.withholding_tax := r.withholding;
  new.supplement_premium := r.supplement;
  new.net_amount := r.net - coalesce(new.other_deduction, 0);
  new.tax_year := extract(year from coalesce(new.paid_at, current_date))::int;
  return new;
end;
$$;

create trigger trg_contractor_payment_before
  before insert or update of gross_amount, income_type, paid_at, other_deduction
  on contractor_payments
  for each row execute function trg_contractor_payment_calc();
