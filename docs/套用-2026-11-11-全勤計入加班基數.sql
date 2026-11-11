-- 套用:全勤獎金計入加班費基數 (2026-11-11 業主決定)
-- 規則參數 overtime.includeAttendanceBonus 預設為「未設定 = 關閉」,需明確設 true 才開啟。
-- 本檔只把「生效日 2026-11-01」那一版 rule_configs 的 config 設為開啟,只更新那一列。
--
-- 使用前:把下面所有 '<TENANT_ID>' 換成實際租戶 UUID。
-- 步驟:① 先跑「唯讀檢查」確認恰好 1 列 → ② 再跑 UPDATE → ③ 再跑唯讀檢查確認為 true。
-- 注意:設定開啟後,2026-11 起(依版本生效日)重算薪資單才會套用新基數;舊月份不受影響。

-- ① 唯讀檢查:該租戶 2026-11-01 版本目前的設定 (應恰好 1 列)
select id, scope, version, active, effective_from,
       config #> '{overtime,includeAttendanceBonus}' as include_attendance_bonus
from rule_configs
where tenant_id = '<TENANT_ID>'
  and scope = 'all'
  and effective_from = '2026-11-01';

-- ② 更新 (若 overtime 物件不存在則建立;create_missing = true)
update rule_configs
set config = case
  when config ? 'overtime' and jsonb_typeof(config -> 'overtime') = 'object'
    then jsonb_set(config, '{overtime,includeAttendanceBonus}', 'true', true)
  else jsonb_set(config, '{overtime}', '{"includeAttendanceBonus": true}'::jsonb, true)
end
where tenant_id = '<TENANT_ID>'
  and scope = 'all'
  and effective_from = '2026-11-01';

-- ③ 唯讀檢查:套用後 (應為 true,且其他欄位不變)
select id, scope, version, active, effective_from,
       config #> '{overtime,includeAttendanceBonus}' as include_attendance_bonus
from rule_configs
where tenant_id = '<TENANT_ID>'
  and scope = 'all'
  and effective_from = '2026-11-01';
