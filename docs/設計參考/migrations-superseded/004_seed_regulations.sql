-- 004_seed_regulations.sql — 法規參數初始資料
-- 亞斯特 ERP / 2026-08-25
--
-- ⚠️ 上線前必做：本檔的「費率與級距」數值需由會計以主管機關當年度公告核對。
--    標 [需查證] 的每一行都要確認過才可啟用薪資計算。
--    法定「日數」與「倍率」直接引自勞基法條文，修法前不會變動，可直接使用。
--
--    投保級距表（勞保約 20 級、健保約 50 級）不在此檔逐級列出——
--    土法輸入一定會錯行。改由 CSV 匯入，來源：
--      勞保：勞動部勞工保險局「勞工保險投保薪資分級表」
--      健保：衛福部中央健康保險署「投保金額分級表」
--    匯入腳本見 scripts/import_insurance_grades.ts

-- ============================================================
-- 假別（依勞基法、勞工請假規則、性別平等工作法）
-- ============================================================

insert into leave_types
  (code, name, is_paid, pay_rate, deducts_from_balance, annual_cap_days,
   requires_attachment, min_unit_hours, sort_order)
values
  ('annual',      '特別休假',       true, 1.00, true,  null,  false, 1, 10),
  ('comp_leave',  '補休',           true, 1.00, true,  null,  false, 1, 20),
  ('sick',        '普通傷病假',     true, 0.50, false, 30,    false, 1, 30),
  ('personal',    '事假',           false,0.00, false, 14,    false, 1, 40),
  ('menstrual',   '生理假',         true, 0.50, false, null,  false, 4, 50),
  ('marriage',    '婚假',           true, 1.00, false, 8,     true,  4, 60),
  ('bereavement', '喪假',           true, 1.00, false, null,  true,  4, 70),
  ('maternity',   '產假',           true, 1.00, false, null,  true,  8, 80),
  ('paternity',   '陪產檢及陪產假', true, 1.00, false, 7,     true,  4, 90),
  ('family_care', '家庭照顧假',     false,0.00, false, 7,     false, 4, 100),
  ('occupational','公傷病假',       true, 1.00, false, null,  true,  4, 110),
  ('official',    '公假',           true, 1.00, false, null,  true,  4, 120),
  ('parental',    '育嬰留職停薪',   false,0.00, false, null,  true,  8, 130);

-- 註：
--  普通傷病假 30 日內半薪（勞工請假規則 §4），逾 30 日部分無薪，超過須由薪資模組另行判斷。
--  生理假每月 1 日，全年未逾 3 日不併入病假計算（性平法 §14）——此規則需在請假時檢核。
--  喪假日數依親等 8/6/3 日（勞工請假規則 §3），請假時依關係選擇，故 annual_cap_days 留空。

-- ============================================================
-- 特休額度（勞基法 §38 I，法定最低標準）
-- ============================================================

insert into leave_entitlement_rules
  (leave_type_id, service_months_from, service_months_to,
   granted_days, extra_days_per_year, max_days, effective_from, notes)
select id, f, t, d, e, m, date '2017-01-01', n
from leave_types,
lateral (values
  (6,   12,   3::numeric,  0::numeric, null::numeric, '六個月以上未滿一年'),
  (12,  24,   7,           0,          null,          '一年以上未滿二年'),
  (24,  36,   10,          0,          null,          '二年以上未滿三年'),
  (36,  60,   14,          0,          null,          '三年以上未滿五年'),
  (60,  120,  15,          0,          null,          '五年以上未滿十年'),
  (120, null, 15,          1,          30,            '十年以上，每滿一年加給一日，加至三十日為止')
) as v(f, t, d, e, m, n)
where leave_types.code = 'annual';

-- ============================================================
-- 加班費倍率（勞基法 §24、§39）
-- ============================================================

insert into overtime_rates
  (day_type, tier_from_hour, tier_to_hour, multiplier, effective_from, notes)
values
  -- 平日延長工時（§24 I）
  ('workday',     0, 2,    4.0/3, date '2018-03-01', '前二小時，加給三分之一以上'),
  ('workday',     2, 4,    5.0/3, date '2018-03-01', '第三、四小時，加給三分之二以上'),
  -- 休息日（§24 III）
  ('rest_day',    0, 2,    4.0/3, date '2018-03-01', '休息日前二小時'),
  ('rest_day',    2, 8,    5.0/3, date '2018-03-01', '休息日第三至八小時'),
  ('rest_day',    8, 12,   8.0/3, date '2018-03-01', '休息日第九至十二小時'),
  -- 國定假日（§39）：工資照給，出勤者加倍發給
  ('holiday',     0, 8,    2.0,   date '2018-03-01', '國定假日出勤八小時內加倍發給'),
  ('holiday',     8, 10,   5.0/3, date '2018-03-01', '國定假日逾八小時之延長工時'),
  -- 例假（§36、§40）：原則不得工作，天災事變除外，加倍發給並補假
  ('regular_off', 0, 8,    2.0,   date '2018-03-01', '例假出勤：僅限天災事變，事後應補假並報主管機關'),
  ('regular_off', 8, 10,   5.0/3, date '2018-03-01', '例假逾八小時之延長工時');

-- ============================================================
-- 扣繳與補充保費（外包承攬給付用）
-- ============================================================

insert into withholding_rules
  (income_type, min_payment, withholding_rate,
   supplement_min, supplement_rate, effective_from, source_note)
values
  ('9B', 20000, 0.10, 20000, 0.0211, date '2021-01-01',
   '[需查證] 執行業務所得：每次給付達 20,000 元扣繳 10%；'
   '二代健保補充保費費率 2.11%，單次給付達 20,000 元。請以財政部與健保署當年度公告核對。'),
  ('50',  0,    0.05, 20000, 0.0211, date '2021-01-01',
   '[需查證] 薪資所得得選擇按全月給付總額 5% 扣繳，或依扣繳稅額表。實務多用稅額表，'
   '此處僅為外包轉僱傭時的備用路徑。');

-- ============================================================
-- 保險費率  ⚠️ 全部 [需查證]
-- ============================================================

insert into insurance_rates
  (insurance_type, total_rate, employee_share, employer_share, government_share,
   effective_from, source_note)
values
  ('labor',      0.12000, 0.20, 0.70, 0.10, date '2025-01-01',
   '[需查證] 勞保普通事故保險費率。分擔比例 §15 為被保險人 20%、投保單位 70%、政府 10%。'),
  ('employment', 0.01000, 0.20, 0.70, 0.10, date '2025-01-01',
   '[需查證] 就業保險費率 1%。'),
  ('health',     0.05170, 0.30, 0.60, 0.10, date '2021-01-01',
   '[需查證] 全民健保一般保險費率。第一類被保險人自付 30%、投保單位 60%、政府 10%。'
   '眷屬計費上限 3 口。'),
  ('pension',    0.06000, 0.00, 1.00, 0.00, date '2005-07-01',
   '勞退新制雇主提繳率不得低於 6%（勞退條例 §14）。員工自提 0-6% 另計，於 salary_profiles 設定。'),
  ('supplement', 0.02110, 1.00, 0.00, 0.00, date '2021-01-01',
   '[需查證] 二代健保補充保費費率，由給付對象負擔。');

-- ============================================================
-- 工時上限門檻（§32、§36）
-- ============================================================

insert into system_parameters
  (category, param_key, param_value, effective_from, source_note)
values
  ('work_hour_limit', 'daily_total_max_minutes',
   '720'::jsonb, date '2018-03-01',
   '單日正常工時 8 小時 + 延長工時 4 小時 = 12 小時上限（§32 II）'),
  ('work_hour_limit', 'monthly_overtime_max_minutes',
   '2760'::jsonb, date '2018-03-01',
   '單月延長工時上限 46 小時（§32 II）'),
  ('work_hour_limit', 'quarterly_overtime_max_minutes',
   '8280'::jsonb, date '2018-03-01',
   '經工會或勞資會議同意，得採三個月 138 小時制（§32 II 但書）。'
   '亞斯特是否採用此制 [待確認]——未經同意程序不得逕行採用。'),
  ('work_hour_limit', 'weekly_normal_max_minutes',
   '2400'::jsonb, date '2016-01-01',
   '每週正常工時上限 40 小時（§30 I）'),
  ('work_hour_alert', 'monthly_overtime_warn_minutes',
   '2160'::jsonb, date '2026-01-01',
   '月延長工時達 36 小時發出預警（上限 46 小時的約八成），留給主管調度空間'),
  ('attendance', 'gps_max_accuracy_meters',
   '100'::jsonb, date '2026-01-01',
   '打卡定位精度超過此值標記 low_accuracy。都會區手機定位一般在 10-50 公尺。'),
  ('payroll', 'monthly_hours_divisor',
   '240'::jsonb, date '2026-01-01',
   '月薪換算平日每小時工資額之除數（30 日 × 8 小時）。'
   '此為常見實務作法，若公司另有約定需一併調整 [待確認]。');
