// 功能測試：用手算的預期值驗證計算引擎。
// 「能建表」不等於「算得對」——薪資算錯是靜默的，只有比對數字能抓到。
//   node scripts/test-engine.mjs
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIG_DIR = new URL('../supabase/migrations/', import.meta.url).pathname
const db = new PGlite()

let pass = 0, fail = 0
function check(name, actual, expected, tolerance = 0) {
  const a = Number(actual), e = Number(expected)
  const ok = Math.abs(a - e) <= tolerance
  if (ok) { pass++; console.log(`  ✓ ${name}: ${a}`) }
  else { fail++; console.log(`  ✗ ${name}: 得到 ${a}，預期 ${e}`) }
}
function checkStr(name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}: ${actual}`) }
  else { fail++; console.log(`  ✗ ${name}: 得到 ${actual}，預期 ${expected}`) }
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0]

await db.exec(`
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid
  language sql stable as $$ select current_setting('test.user_id', true)::uuid $$;
`)
for (const f of readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(MIG_DIR, f), 'utf8'))
}

// ---------- 測試資料 ----------
await db.exec(`
insert into companies (id, code, name) values
  ('11111111-1111-1111-1111-111111111111','ASTER','亞斯特');

-- 投保級距（測試用；正式環境由 CSV 匯入官方分級表）
insert into insurance_grades
  (insurance_type, grade_no, salary_min, salary_max, insured_amount, effective_from) values
  ('labor',   1, 0, 100000, 36300, '2025-01-01'),
  ('health',  1, 0, 100000, 36300, '2025-01-01'),
  ('pension', 1, 0, 100000, 36300, '2025-01-01');

insert into employees
  (id, employee_no, name, hire_date, primary_company_id, employment_type) values
  ('22222222-2222-2222-2222-222222222222','E001','測試員工','2024-01-15',
   '11111111-1111-1111-1111-111111111111','fulltime');

insert into salary_profiles
  (employee_id, effective_from, base_salary, meal_allowance,
   labor_insured_amount, health_insured_amount, pension_insured_amount,
   dependents_count, tax_dependents)
values
  ('22222222-2222-2222-2222-222222222222','2024-01-15', 36000, 2400,
   36300, 36300, 36300, 0, 0);

-- 行事曆：2026-08 全部工作日，8/29(六) 休息日，8/30(日) 例假
insert into work_calendar (calendar_date, company_id, day_type)
select d::date, null,
  case extract(dow from d) when 6 then 'rest_day' when 0 then 'regular_off' else 'workday' end
from generate_series(date '2026-08-01', date '2026-08-31', '1 day') d;
`)

const EMP = '22222222-2222-2222-2222-222222222222'

// ---------- 測試 1：平日加班分段 ----------
console.log('\n[1] 平日 8:00-20:00 休息60分 → 工作 11h：正常 8h + 延長 3h')
await db.query(`insert into attendance_records
  (employee_id, work_date, clock_in, clock_out, break_minutes)
  values ($1,'2026-08-03','2026-08-03 08:00+08','2026-08-03 20:00+08',60)`, [EMP])
let s = await one(`select * from attendance_daily_summary
  where employee_id=$1 and work_date='2026-08-03'`, [EMP])
check('工作分鐘', s.worked_minutes, 660)
check('正常工時', s.regular_minutes, 480)
check('延長 tier1(前2h)', s.ot_tier1_minutes, 120)
check('延長 tier2(第3h)', s.ot_tier2_minutes, 60)

// ---------- 測試 2：超過單日 12 小時上限 ----------
console.log('\n[2] 平日 8:00-22:00 休息60分 → 13h，應標 over_daily_limit')
await db.query(`insert into attendance_records
  (employee_id, work_date, clock_in, clock_out, break_minutes)
  values ($1,'2026-08-04','2026-08-04 08:00+08','2026-08-04 22:00+08',60)`, [EMP])
let a = await one(`select anomaly_flags from attendance_records
  where employee_id=$1 and work_date='2026-08-04'`, [EMP])
checkStr('異常旗標含 over_daily_limit', a.anomaly_flags.includes('over_daily_limit'), 'true')

// ---------- 測試 3：休息日三段分割 ----------
console.log('\n[3] 休息日 8/29 工作 9h → tier1 2h + tier2 6h + tier3 1h')
await db.query(`insert into attendance_records
  (employee_id, work_date, clock_in, clock_out, break_minutes)
  values ($1,'2026-08-29','2026-08-29 08:00+08','2026-08-29 18:00+08',60)`, [EMP])
s = await one(`select * from attendance_daily_summary
  where employee_id=$1 and work_date='2026-08-29'`, [EMP])
checkStr('日別', s.day_type, 'rest_day')
check('休息日 tier1', s.ot_tier1_minutes, 120)
check('休息日 tier2', s.ot_tier2_minutes, 360)
check('休息日 tier3', s.ot_tier3_minutes, 60)
check('正常工時應為 0', s.regular_minutes, 0)

// ---------- 測試 4：特休週年制發放 ----------
console.log('\n[4] 到職 2024-01-15，2026-01-15 起週年區間 → 年資24個月 → 10日')
await db.query(`select grant_annual_leave($1, '2026-01-15')`, [EMP])
let e = await one(`select granted_hours from leave_entitlements
  where employee_id=$1 and period_start='2026-01-15'`, [EMP])
check('特休時數(10日×8h)', e.granted_hours, 80)
const entId = (await one(`select id from leave_entitlements
  where employee_id=$1 and period_start='2026-01-15'`, [EMP])).id
check('餘額流水合計', (await one(`select leave_balance_hours($1) v`, [entId])).v, 80)

// ---------- 測試 5：請假扣除與銷假回沖 ----------
console.log('\n[5] 請特休 8h → 餘額 72h；銷假後回到 80h')
const lt = (await one(`select id from leave_types where code='annual'`)).id
const lr = await one(`insert into leave_requests
  (employee_id, leave_type_id, start_at, end_at, hours, status)
  values ($1,$2,'2026-08-05 09:00+08','2026-08-05 18:00+08',8,'submitted')
  returning id`, [EMP, lt])
await db.query(`select approve_leave_request($1, $2)`, [lr.id, EMP])
check('扣除後餘額', (await one(`select leave_balance_hours($1) v`, [entId])).v, 72)
await db.query(`select cancel_leave_request($1,$2,'測試銷假')`, [lr.id, EMP])
check('銷假回沖後餘額', (await one(`select leave_balance_hours($1) v`, [entId])).v, 80)

// ---------- 測試 6：薪資計算 ----------
console.log('\n[6] 月薪36000 → 時薪150；加班 tier1 2h + tier2 1h')
console.log('    預期加班費 = 150×(4/3)×2 + 150×(5/3)×1 = 400 + 250 = 650')
// 清掉測試2/3的紀錄，只留測試1的加班，讓預期值可手算
await db.query(`delete from attendance_records where employee_id=$1
  and work_date in ('2026-08-04','2026-08-29')`, [EMP])
await db.query(`delete from attendance_daily_summary where employee_id=$1
  and work_date in ('2026-08-04','2026-08-29')`, [EMP])
const per = await one(`insert into payroll_periods
  (year, month, period_start, period_end) values (2026,8,'2026-08-01','2026-08-31')
  returning id`)
await db.query(`select calculate_payroll_item($1,$2)`, [per.id, EMP])
let pi = await one(`select * from payroll_items where period_id=$1 and employee_id=$2`,
  [per.id, EMP])
check('本薪', pi.base_salary, 36000)
check('加班費', pi.overtime_pay, 650)
check('伙食津貼', pi.meal_allowance, 2400)
check('應發合計 36000+650+2400', pi.gross_pay, 39050)
// 勞保: 36300 × (0.12+0.01) × 0.20 = 943.8 → 944
check('勞保自付', pi.labor_insurance, 944)
// 健保: 36300 × 0.0517 × 0.30 × 1 = 563.01 → 563
check('健保自付', pi.health_insurance, 563)
check('實發 = 39050 - 944 - 563', pi.net_pay, 39050 - 944 - 563)
checkStr('標記扣繳稅額表未匯入', pi.calc_flags.includes('tax_table_missing'), 'true')
const det = await one(`select count(*)::int c from payroll_item_details
  where payroll_item_id=$1`, [pi.id])
check('薪資明細筆數', det.c, 13)

// ---------- 測試 7：獎金併入薪資 ----------
console.log('\n[7] 年終獎金 50000 併入該期 → 應發增加 50000')
const bt = (await one(`select id from bonus_types where code='year_end'`)).id
const bb = await one(`insert into bonus_batches
  (bonus_type_id, name, year, payroll_period_id, total_budget, status)
  values ($1,'2026年終',2026,$2,50000,'draft') returning id`, [bt, per.id])
await db.query(`insert into bonus_awards
  (batch_id, employee_id, allocation_percentage, status)
  values ($1,$2,100,'pending')`, [bb.id, EMP])
await db.query(`select calculate_bonus_by_allocation($1)`, [bb.id])
check('依比例試算金額', (await one(
  `select calculated_amount v from bonus_awards where batch_id=$1`, [bb.id])).v, 50000)
await db.query(`select approve_bonus_batch($1,$2)`, [bb.id, EMP])
await db.query(`select calculate_payroll_item($1,$2)`, [per.id, EMP])
pi = await one(`select * from payroll_items where period_id=$1 and employee_id=$2`,
  [per.id, EMP])
check('薪資單獎金欄', pi.bonus_amount, 50000)
check('應發合計含獎金', pi.gross_pay, 39050 + 50000)

// ---------- 測試 8：老闆裁示調整留痕 ----------
console.log('\n[8] 老闆調整獎金 50000 → 45000，須留理由')
const aw = (await one(`select id from bonus_awards where batch_id=$1`, [bb.id])).id
await db.query(`select adjust_bonus_award($1, 45000, '考量今年專案延誤', $2)`, [aw, EMP])
const adj = await one(`select calculated_amount, adjusted_amount, final_amount,
  adjustment_reason from bonus_awards where id=$1`, [aw])
check('系統原算金額保留', adj.calculated_amount, 50000)
check('調整後金額', adj.adjusted_amount, 45000)
check('最終金額取調整值', adj.final_amount, 45000)
checkStr('調整理由留存', adj.adjustment_reason, '考量今年專案延誤')
let threw = false
try { await db.query(`select adjust_bonus_award($1, 40000, '', $2)`, [aw, EMP]) }
catch { threw = true }
checkStr('空白理由應被拒絕', threw, 'true')

// ---------- 測試 9：外包扣繳起扣點 ----------
console.log('\n[9] 9B 執行業務所得：達 20000 才扣 10% + 補充保費 2.11%')
await db.exec(`insert into contractors
  (id, contractor_no, name, contractor_type, entity_type, income_type)
  values ('33333333-3333-3333-3333-333333333333','C001','張技師',
          'technician','individual','9B')`)
await db.query(`insert into contractor_payments
  (contractor_id, paying_company_id, gross_amount, net_amount, paid_at)
  values ('33333333-3333-3333-3333-333333333333',
          '11111111-1111-1111-1111-111111111111', 30000, 0, '2026-08-20')`)
let cp = await one(`select * from contractor_payments where gross_amount=30000`)
check('扣繳稅額 30000×10%', cp.withholding_tax, 3000)
check('補充保費 30000×2.11%', cp.supplement_premium, 633)
check('實付 30000-3000-633', cp.net_amount, 26367)

await db.query(`insert into contractor_payments
  (contractor_id, paying_company_id, gross_amount, net_amount, paid_at)
  values ('33333333-3333-3333-3333-333333333333',
          '11111111-1111-1111-1111-111111111111', 15000, 0, '2026-08-20')`)
cp = await one(`select * from contractor_payments where gross_amount=15000`)
check('未達起扣點不扣繳', cp.withholding_tax, 0)
check('未達門檻不收補充保費', cp.supplement_premium, 0)
check('實付全額', cp.net_amount, 15000)

// ---------- 測試 10：稽核軌跡 ----------
console.log('\n[10] 獎金調整必須留下稽核紀錄')
const al = await one(`select count(*)::int c from audit_logs
  where table_name='bonus_awards' and action='update'`)
check('bonus_awards 更新有稽核紀錄', al.c >= 1 ? 1 : 0, 1)
const alf = await one(`select changed_fields from audit_logs
  where table_name='bonus_awards' and action='update'
  order by changed_at desc limit 1`)
checkStr('稽核記錄了 adjusted_amount 欄位',
  alf.changed_fields.includes('adjusted_amount'), 'true')

// ---------- 測試 11：已核定薪資期間不得重算 ----------
console.log('\n[11] 期間核定後應拒絕重算')
await db.query(`update payroll_periods set status='approved' where id=$1`, [per.id])
threw = false
try { await db.query(`select calculate_payroll_item($1,$2)`, [per.id, EMP]) }
catch { threw = true }
checkStr('已核定期間拒絕重算', threw, 'true')

console.log(`\n${'='.repeat(50)}`)
console.log(`通過 ${pass} 項，失敗 ${fail} 項`)
process.exit(fail > 0 ? 1 : 0)
