-- 006_payroll_engine.sql — 薪資計算引擎
-- 亞斯特 ERP / 2026-08-25
--
-- 原則：
-- 1. 算不出來就標記，不要猜。缺扣繳稅額表就記 tax_table_missing 並讓稅額為 0，
--    由會計補上；用估計值發薪，錯的是每一個人的實領金額。
-- 2. 每個數字都要寫進 payroll_item_details，能指回來源（哪幾天加班、哪張假單）。
-- 3. 已核定（approved/paid）的期間不得重算。

-- 取某日某類型某段的加班倍率
create or replace function get_overtime_multiplier(
  p_day_type text, p_tier_from numeric, p_date date
) returns numeric
language sql stable
as $$
  select multiplier from overtime_rates
  where day_type = p_day_type
    and tier_from_hour = p_tier_from
    and effective_from <= p_date
    and (effective_to is null or effective_to >= p_date)
  order by effective_from desc
  limit 1;
$$;

-- 取系統參數（數值型）
create or replace function get_param_numeric(
  p_category text, p_key text, p_date date, p_default numeric default null
) returns numeric
language sql stable
as $$
  select coalesce(
    (select (param_value #>> '{}')::numeric
     from system_parameters
     where category = p_category and param_key = p_key
       and effective_from <= p_date
       and (effective_to is null or effective_to >= p_date)
     order by effective_from desc limit 1),
    p_default);
$$;

-- 該期應併入薪資的獎金總額。
-- 此處先以 stub 定義，由 007_bonus.sql 以實作覆蓋（create or replace）。
-- 這樣薪資引擎不需知道獎金模組的表結構，兩個 migration 也不互相依賴。
create or replace function get_period_bonus(p_employee_id uuid, p_period_id uuid)
returns numeric
language sql stable
as $$ select 0::numeric; $$;

-- ============================================================
-- 主引擎
-- ============================================================

create or replace function calculate_payroll_item(
  p_period_id uuid,
  p_employee_id uuid
) returns uuid
language plpgsql
as $$
declare
  v_period      payroll_periods%rowtype;
  v_emp         employees%rowtype;
  v_prof        salary_profiles%rowtype;
  v_item_id     uuid;
  v_flags       text[] := '{}';

  v_hourly      numeric;          -- 平日每小時工資額
  v_divisor     numeric;
  v_ot_pay      numeric := 0;
  v_leave_ded   numeric := 0;
  v_base        numeric;
  v_work_days   int;
  v_month_days  int;

  v_labor_rate  insurance_rates%rowtype;
  v_emp_ins_rate insurance_rates%rowtype;
  v_health_rate insurance_rates%rowtype;
  v_pension_rate insurance_rates%rowtype;
  v_labor_ee    numeric := 0;
  v_health_ee   numeric := 0;
  v_pension_self numeric := 0;
  v_labor_er    numeric := 0;
  v_health_er   numeric := 0;
  v_pension_er  numeric := 0;
  v_avg_dependents numeric;

  v_bonus       numeric := 0;
  v_tax         numeric := 0;
  v_gross       numeric;
  v_total_ded   numeric;
  v_net         numeric;
  r             record;
begin
  select * into v_period from payroll_periods where id = p_period_id;
  if v_period.id is null then
    raise exception '薪資期間不存在: %', p_period_id;
  end if;
  if v_period.status in ('approved','paid') then
    raise exception '薪資期間 %-% 已核定，不得重算', v_period.year, v_period.month;
  end if;

  select * into v_emp from employees where id = p_employee_id;
  select * into v_prof from get_salary_profile(p_employee_id, v_period.period_end);
  if v_prof.id is null then
    raise exception '員工 % 在 % 無生效的薪資設定', v_emp.name, v_period.period_end;
  end if;

  v_divisor := get_param_numeric('payroll','monthly_hours_divisor', v_period.period_end, 240);
  v_hourly  := round(v_prof.base_salary / v_divisor, 4);

  -- ---------- 本薪（到離職當月按日比例）----------
  v_month_days := (v_period.period_end - v_period.period_start + 1);
  v_work_days := v_month_days;
  if v_emp.hire_date > v_period.period_start then
    v_work_days := v_period.period_end - v_emp.hire_date + 1;
    v_flags := array_append(v_flags, 'partial_month');
  end if;
  if v_emp.termination_date is not null
     and v_emp.termination_date < v_period.period_end then
    v_work_days := least(v_work_days, v_emp.termination_date - v_period.period_start + 1);
    v_flags := array_append(v_flags, 'partial_month');
  end if;
  v_base := round(v_prof.base_salary * v_work_days / v_month_days, 0);

  -- ---------- 加班費 ----------
  if not exists (select 1 from attendance_daily_summary
                 where employee_id = p_employee_id
                   and work_date between v_period.period_start and v_period.period_end) then
    v_flags := array_append(v_flags, 'no_attendance');
  end if;

  for r in
    select day_type,
           sum(ot_tier1_minutes) as t1,
           sum(ot_tier2_minutes) as t2,
           sum(ot_tier3_minutes) as t3,
           sum(holiday_minutes)  as hol
    from attendance_daily_summary
    where employee_id = p_employee_id
      and work_date between v_period.period_start and v_period.period_end
    group by day_type
  loop
    if r.t1 > 0 then
      v_ot_pay := v_ot_pay + (r.t1 / 60.0) * v_hourly
                  * coalesce(get_overtime_multiplier(r.day_type, 0, v_period.period_end), 0);
    end if;
    if r.t2 > 0 then
      v_ot_pay := v_ot_pay + (r.t2 / 60.0) * v_hourly
                  * coalesce(get_overtime_multiplier(r.day_type, 2, v_period.period_end), 0);
    end if;
    if r.t3 > 0 then
      v_ot_pay := v_ot_pay + (r.t3 / 60.0) * v_hourly
                  * coalesce(get_overtime_multiplier(r.day_type, 8, v_period.period_end), 0);
    end if;
    if r.hol > 0 then
      v_ot_pay := v_ot_pay + (r.hol / 60.0) * v_hourly
                  * coalesce(get_overtime_multiplier(r.day_type, 0, v_period.period_end), 0);
    end if;
  end loop;
  v_ot_pay := round(v_ot_pay, 0);

  -- ---------- 請假扣款（依假別給薪比例）----------
  select coalesce(sum(lr.hours * v_hourly * (1 - lt.pay_rate)), 0)
    into v_leave_ded
  from leave_requests lr
  join leave_types lt on lt.id = lr.leave_type_id
  where lr.employee_id = p_employee_id
    and lr.status = 'approved'
    and lr.deleted_at is null
    and lr.start_at::date between v_period.period_start and v_period.period_end;
  v_leave_ded := round(v_leave_ded, 0);

  -- ---------- 勞保／就保 ----------
  select * into v_labor_rate from get_insurance_rate('labor', v_period.period_end);
  select * into v_emp_ins_rate from get_insurance_rate('employment', v_period.period_end);
  if v_prof.labor_insured_amount is null then
    v_flags := array_append(v_flags, 'grade_missing');
  else
    v_labor_ee := round(v_prof.labor_insured_amount
      * (coalesce(v_labor_rate.total_rate,0) + coalesce(v_emp_ins_rate.total_rate,0))
      * coalesce(v_labor_rate.employee_share,0), 0);
    v_labor_er := round(v_prof.labor_insured_amount
      * (coalesce(v_labor_rate.total_rate,0) + coalesce(v_emp_ins_rate.total_rate,0))
      * coalesce(v_labor_rate.employer_share,0), 0);
  end if;

  -- ---------- 健保（眷屬計費上限 3 口）----------
  select * into v_health_rate from get_insurance_rate('health', v_period.period_end);
  if v_prof.health_insured_amount is null then
    if not ('grade_missing' = any(v_flags)) then
      v_flags := array_append(v_flags, 'grade_missing');
    end if;
  else
    v_health_ee := round(v_prof.health_insured_amount
      * coalesce(v_health_rate.total_rate,0)
      * coalesce(v_health_rate.employee_share,0)
      * (1 + least(v_prof.dependents_count, 3)), 0);
    -- 雇主負擔按健保署公告之「平均眷口數」，非員工實際眷屬數
    v_avg_dependents := get_param_numeric(
      'insurance','health_avg_dependents', v_period.period_end, 0.57);
    v_health_er := round(v_prof.health_insured_amount
      * coalesce(v_health_rate.total_rate,0)
      * coalesce(v_health_rate.employer_share,0)
      * (1 + v_avg_dependents), 0);
  end if;

  -- ---------- 勞退 ----------
  select * into v_pension_rate from get_insurance_rate('pension', v_period.period_end);
  if v_prof.pension_insured_amount is not null then
    v_pension_er := round(v_prof.pension_insured_amount
      * coalesce(v_pension_rate.total_rate, 0.06), 0);
    v_pension_self := round(v_prof.pension_insured_amount * v_prof.pension_self_rate, 0);
  end if;

  -- ---------- 獎金（三節/年終/專案，屬薪資所得，須併入當期計稅）----------
  v_bonus := coalesce(get_period_bonus(p_employee_id, p_period_id), 0);

  -- ---------- 所得稅（查扣繳稅額表；查無則標記，不估算）----------
  v_gross := v_base + v_ot_pay + v_prof.meal_allowance
             + v_prof.position_allowance + v_prof.other_allowance + v_bonus;

  select tax_amount into v_tax
  from withholding_tax_table
  where tax_year = v_period.year
    and dependents = v_prof.tax_dependents
    and v_gross >= salary_from
    and (salary_to is null or v_gross <= salary_to)
  limit 1;

  if v_tax is null then
    v_tax := 0;
    v_flags := array_append(v_flags, 'tax_table_missing');
  end if;

  -- ---------- 彙總 ----------
  v_total_ded := v_labor_ee + v_health_ee + v_pension_self + v_tax + v_leave_ded;
  v_net := v_gross - v_total_ded;

  insert into payroll_items (
    period_id, employee_id, paying_company_id,
    base_salary, overtime_pay, meal_allowance, other_allowance, bonus_amount, gross_pay,
    labor_insurance, health_insurance, pension_self, income_tax, leave_deduction,
    total_deduction, net_pay,
    employer_labor, employer_health, employer_pension,
    calc_flags, calculated_at
  ) values (
    p_period_id, p_employee_id, v_emp.primary_company_id,
    v_base, v_ot_pay, v_prof.meal_allowance,
    v_prof.position_allowance + v_prof.other_allowance, v_bonus, v_gross,
    v_labor_ee, v_health_ee, v_pension_self, v_tax, v_leave_ded,
    v_total_ded, v_net,
    v_labor_er, v_health_er, v_pension_er,
    v_flags, now()
  )
  on conflict (period_id, employee_id) do update set
    base_salary = excluded.base_salary,
    overtime_pay = excluded.overtime_pay,
    meal_allowance = excluded.meal_allowance,
    other_allowance = excluded.other_allowance,
    bonus_amount = excluded.bonus_amount,
    gross_pay = excluded.gross_pay,
    labor_insurance = excluded.labor_insurance,
    health_insurance = excluded.health_insurance,
    pension_self = excluded.pension_self,
    income_tax = excluded.income_tax,
    leave_deduction = excluded.leave_deduction,
    total_deduction = excluded.total_deduction,
    net_pay = excluded.net_pay,
    employer_labor = excluded.employer_labor,
    employer_health = excluded.employer_health,
    employer_pension = excluded.employer_pension,
    calc_flags = excluded.calc_flags,
    calculated_at = now()
  returning id into v_item_id;

  -- ---------- 明細（重算時整批替換）----------
  delete from payroll_item_details where payroll_item_id = v_item_id;

  insert into payroll_item_details
    (payroll_item_id, category, code, label, quantity, rate, amount, source_ref, sort_order)
  values
    (v_item_id,'earning','base','本薪', v_work_days, v_prof.base_salary, v_base,
     format('在職 %s/%s 日', v_work_days, v_month_days), 10),
    (v_item_id,'earning','overtime','加班費', null, v_hourly, v_ot_pay,
     format('%s ~ %s 出勤彙總', v_period.period_start, v_period.period_end), 20),
    (v_item_id,'earning','meal','伙食津貼', null, null, v_prof.meal_allowance, null, 30),
    (v_item_id,'earning','allowance','其他津貼', null, null,
     v_prof.position_allowance + v_prof.other_allowance, null, 40),
    (v_item_id,'earning','bonus','獎金', null, null, v_bonus,
     '詳見獎金發放批次', 45),
    (v_item_id,'deduction','labor_ins','勞保費（自付）', null, null, v_labor_ee,
     format('投保薪資 %s', v_prof.labor_insured_amount), 50),
    (v_item_id,'deduction','health_ins','健保費（自付）', v_prof.dependents_count, null, v_health_ee,
     format('投保金額 %s，眷屬 %s 口', v_prof.health_insured_amount,
            least(v_prof.dependents_count,3)), 60),
    (v_item_id,'deduction','pension_self','勞退自提', null, v_prof.pension_self_rate,
     v_pension_self, null, 70),
    (v_item_id,'deduction','income_tax','所得稅扣繳', null, null, v_tax,
     case when 'tax_table_missing' = any(v_flags)
          then '⚠ 扣繳稅額表未匯入，暫以 0 計' else null end, 80),
    (v_item_id,'deduction','leave','請假扣款', null, v_hourly, v_leave_ded, null, 90),
    (v_item_id,'employer_cost','er_labor','雇主勞保負擔', null, null, v_labor_er, null, 100),
    (v_item_id,'employer_cost','er_health','雇主健保負擔', null, null, v_health_er, null, 110),
    (v_item_id,'employer_cost','er_pension','雇主勞退提繳', null, null, v_pension_er, null, 120);

  return v_item_id;
end;
$$;

-- 整期計算：回傳處理人數與異常筆數
create or replace function calculate_payroll_period(p_period_id uuid)
returns table (processed int, flagged int)
language plpgsql
as $$
declare
  v_period payroll_periods%rowtype;
  v_emp    record;
  v_count  int := 0;
begin
  select * into v_period from payroll_periods where id = p_period_id;

  for v_emp in
    select e.id from employees e
    where e.status <> 'terminated'
       or (e.termination_date is not null
           and e.termination_date >= v_period.period_start)
  loop
    begin
      perform calculate_payroll_item(p_period_id, v_emp.id);
      v_count := v_count + 1;
    exception when others then
      -- 單人失敗不中斷整期；記在期間備註供會計處理
      update payroll_periods
         set notes = coalesce(notes,'') || format(E'\n[計算失敗] 員工 %s: %s', v_emp.id, sqlerrm)
       where id = p_period_id;
    end;
  end loop;

  update payroll_periods
     set calculated_at = now(), status = 'draft'
   where id = p_period_id;

  return query
    select v_count,
           (select count(*)::int from payroll_items
            where period_id = p_period_id and calc_flags <> '{}');
end;
$$;
