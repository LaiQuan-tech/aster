-- 001_core_org.sql — 組織、人員、法規參數
-- 亞斯特 ERP / 2026-08-25
--
-- 設計要點：
-- 1. 法規參數（勞健保級距、加班費率、扣繳率）一律進表並帶生效日，不寫死在程式。
--    費率年年變，寫死的系統第二年就是錯的。
-- 2. 僱傭與承攬分成兩張表（employees / contractors），不共用。
--    承攬人員不得出現在 attendance/leave/payroll——出勤紀錄是「受指揮監督」的證據。

-- gen_random_uuid() 自 PostgreSQL 13 起為內建，不需 pgcrypto。
-- 若日後要在資料庫層加密 *_enc 欄位（pgp_sym_encrypt），再於 Supabase 啟用 pgcrypto。
-- 目前 *_enc 欄位由應用層加密後存入。

-- ============================================================
-- 法規參數
-- ============================================================

-- 通用參數（單值型）
create table system_parameters (
  id              uuid primary key default gen_random_uuid(),
  category        text not null,
  param_key       text not null,
  param_value     jsonb not null,
  effective_from  date not null,
  effective_to    date,
  source_note     text,          -- 出處：哪份公告/法條，方便日後查核
  created_at      timestamptz not null default now(),
  unique (category, param_key, effective_from)
);

comment on table system_parameters is
  '法規參數。修改一律用「新增一筆帶新生效日」，不要 UPDATE 舊值——舊薪資期間必須能重算出當時的數字。';

-- 勞保／健保／勞退 投保級距表
create table insurance_grades (
  id              uuid primary key default gen_random_uuid(),
  insurance_type  text not null,          -- 'labor' 勞保 | 'health' 健保 | 'pension' 勞退
  grade_no        int not null,
  salary_min      numeric(14,2) not null, -- 月投保薪資下限
  salary_max      numeric(14,2),          -- 上限；null = 最高級距無上限
  insured_amount  numeric(14,2) not null, -- 投保金額（級距代表值，非實薪）
  effective_from  date not null,
  effective_to    date,
  unique (insurance_type, grade_no, effective_from)
);

-- 保費分擔比例（勞保/就保/健保/勞退各自不同，且會調整）
create table insurance_rates (
  id                uuid primary key default gen_random_uuid(),
  insurance_type    text not null,   -- labor|employment|health|pension|supplement
  total_rate        numeric(8,5) not null,   -- 總費率，如健保 0.0517
  employee_share    numeric(8,5) not null,   -- 受僱者負擔比例，如 0.30
  employer_share    numeric(8,5) not null,
  government_share  numeric(8,5) not null default 0,
  effective_from    date not null,
  effective_to      date,
  source_note       text,
  unique (insurance_type, effective_from)
);

-- 加班費倍率（勞基法 §24、§39）——用表驅動，因為分段規則複雜且會修法
create table overtime_rates (
  id              uuid primary key default gen_random_uuid(),
  day_type        text not null,   -- 'workday'平日 | 'rest_day'休息日
                                   -- 'regular_off'例假 | 'holiday'國定假日
  tier_from_hour  numeric(5,2) not null,   -- 該倍率起算時數（含）
  tier_to_hour    numeric(5,2),            -- 迄（不含）；null = 無上限
  multiplier      numeric(5,3) not null,   -- 平日前2h = 1.340
  effective_from  date not null,
  effective_to    date,
  notes           text
);

-- 扣繳與補充保費（外包承攬給付用）
create table withholding_rules (
  id                uuid primary key default gen_random_uuid(),
  income_type       text not null,           -- '9B'執行業務 | '50'薪資 | '9A'租賃
  min_payment       numeric(14,2) not null,  -- 起扣點：未達此金額不扣繳
  withholding_rate  numeric(8,5) not null,   -- 如 9B = 0.10
  supplement_min    numeric(14,2),           -- 二代健保補充保費起扣金額
  supplement_rate   numeric(8,5),            -- 如 0.0211
  effective_from    date not null,
  effective_to      date,
  source_note       text
);

-- ============================================================
-- 組織
-- ============================================================

create table companies (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,
  tax_id          text,
  is_active       boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now()
);

create table bank_accounts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  bank_name       text not null,
  branch_name     text,
  account_no_enc  text not null,   -- 加密後存放，不落明碼
  account_name    text not null,
  purpose         text not null,   -- receivable|payable|payroll
  is_active       boolean not null default true
);

create table departments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  name            text not null,
  parent_id       uuid references departments(id),
  manager_id      uuid,            -- 稍後補 FK（employees 尚未建立）
  is_active       boolean not null default true
);

-- ============================================================
-- 僱傭員工（月薪制）
-- ============================================================

create table employees (
  id                  uuid primary key default gen_random_uuid(),
  employee_no         text not null unique,
  name                text not null,
  id_number_enc       text,
  email               text,                 -- 薪資條寄送
  phone               text,
  birth_date          date,
  hire_date           date not null,        -- ★ 特休週年制基準日
  termination_date    date,
  primary_company_id  uuid not null references companies(id),
  department_id       uuid references departments(id),
  job_title           text,
  -- 全部為月薪僱傭；承攬人員在 contractors 表，不在這裡
  employment_type     text not null default 'fulltime',
                      -- fulltime 正職 | probation 試用 | parttime 部分工時(仍為僱傭)
  default_work_mode   text not null default 'office',   -- office|remote|site
  reports_to          uuid references employees(id),    -- 直屬主管（簽核鏈）
  status              text not null default 'active',   -- active|on_leave|terminated
  created_at          timestamptz not null default now(),
  constraint employees_type_check
    check (employment_type in ('fulltime','probation','parttime'))
);

alter table departments
  add constraint departments_manager_fk
  foreign key (manager_id) references employees(id);

-- ============================================================
-- 外包承攬（非僱傭，走執行業務所得）
-- ============================================================

create table contractors (
  id              uuid primary key default gen_random_uuid(),
  contractor_no   text not null unique,
  name            text not null,
  contractor_type text not null,   -- 'technician' 複委託技師（空調/電機/消防）
                                   -- 'outsourced'  一般外包人力
  trade           text,            -- hvac|electrical|fire|structural|admin|design
  entity_type     text not null,   -- 'individual' 個人 | 'company' 公司行號
  tax_id          text,
  id_number_enc   text,
  income_type     text not null default '9B',   -- 對應 withholding_rules
  bank_account_enc text,
  email           text,
  phone           text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint contractors_entity_check
    check (entity_type in ('individual','company'))
);

comment on table contractors is
  '外包承攬人員／廠商。與 employees 嚴格分離：承攬人不打卡、不請特休、不入薪資，'
  '報酬走勞務給付並依 withholding_rules 扣繳。若實際上受指揮監督、有固定出勤，'
  '則屬「假承攬真僱傭」，應改列 employees——這是稅務與勞保風險，不是資料歸類問題。';

-- ============================================================
-- 系統帳號與權限
-- ============================================================

create table user_accounts (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null unique references employees(id),
  auth_user_id      uuid not null unique,     -- Supabase auth.users.id
  permission_level  int not null default 1,
  -- 1 一般員工 | 2 經理(限自己專案) | 25 資深經理 | 3 會計 | 4 老闆
  is_active         boolean not null default true,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now()
);

-- 目前登入者對應的 employee_id；RLS policy 全靠這支
create or replace function current_employee_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select ua.employee_id
  from user_accounts ua
  where ua.auth_user_id = auth.uid() and ua.is_active
  limit 1;
$$;

create or replace function current_permission_level()
returns int
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select ua.permission_level
     from user_accounts ua
     where ua.auth_user_id = auth.uid() and ua.is_active
     limit 1), 0);
$$;

-- 查某日適用的參數（所有計算都該透過這類 helper 取值，不可寫死）
create or replace function get_insurance_rate(p_type text, p_date date)
returns insurance_rates
language sql stable
as $$
  select * from insurance_rates
  where insurance_type = p_type
    and effective_from <= p_date
    and (effective_to is null or effective_to >= p_date)
  order by effective_from desc
  limit 1;
$$;

create or replace function get_insurance_grade(
  p_type text, p_salary numeric, p_date date
) returns insurance_grades
language sql stable
as $$
  select * from insurance_grades
  where insurance_type = p_type
    and effective_from <= p_date
    and (effective_to is null or effective_to >= p_date)
    and p_salary >= salary_min
    and (salary_max is null or p_salary <= salary_max)
  order by grade_no
  limit 1;
$$;

create index idx_employees_company on employees(primary_company_id) where status = 'active';
create index idx_employees_dept on employees(department_id);
create index idx_user_accounts_auth on user_accounts(auth_user_id);
create index idx_ins_grades_lookup on insurance_grades(insurance_type, effective_from, salary_min);
