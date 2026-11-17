-- 2026-11-17 生理假（性別平等工作法第 14 條；本檔 ＝ sql/0092；接 0101 ＝ sql/0091）。
--
-- 1. leave_types.statutory_kind：假別的法定語意（null＝一般；'sick'＝普通傷病假〔未住院一年 30 日〕；
--    'menstrual'＝生理假）。API 用它找「生理假」與「它超過全年 3 日要併入的病假」。
--    只回填名稱／code 明確的列：公傷病假、住院病假等不標成 sick。
-- 2. leave_requests.menstrual_sick_merge：生理假單最終核准時「超過全年 3 日、併入病假」的紀錄
--    （[{bucketId, hours}]），撤銷／退回時照這份沖回，null＝沒有併入（或已沖回）。
-- 3. 每個還沒有生理假的租戶補一筆：code 'menstrual'、生理假、支薪、特殊假別、免附證明、扣薪 0.5（減半發給）。
--
-- 只有 ADD COLUMN（可為 null）、CHECK、回填 statutory_kind、INSERT 新假別；不刪、不改其他資料。可重跑。

ALTER TABLE public.leave_types ADD COLUMN IF NOT EXISTS statutory_kind text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leave_types_statutory_kind_check' AND conrelid = 'public.leave_types'::regclass
  ) THEN
    ALTER TABLE public.leave_types
      ADD CONSTRAINT leave_types_statutory_kind_check CHECK (statutory_kind IS NULL OR statutory_kind IN ('sick', 'menstrual'));
  END IF;
END $$;

COMMENT ON COLUMN public.leave_types.statutory_kind IS
  '法定假別語意：null 一般；sick 普通傷病假（生理假超過全年 3 日併入此假別）；menstrual 生理假（每月 1 日、減半發給）';

ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS menstrual_sick_merge jsonb;

COMMENT ON COLUMN public.leave_requests.menstrual_sick_merge IS
  '生理假單核准時超過全年 3 日、併入病假餘額桶的時數 [{bucketId, hours}]；撤銷時照此沖回後清成 null';

-- 回填（只填還是 null 的列，HR 已設定的不動）。
UPDATE public.leave_types
SET statutory_kind = 'menstrual'
WHERE statutory_kind IS NULL
  AND (name ~ '生理假' OR code ~* '^menstrual');

UPDATE public.leave_types
SET statutory_kind = 'sick'
WHERE statutory_kind IS NULL
  AND (btrim(name) ~ '^(普通)?(傷)?病假$' OR btrim(code) ~* '^sick$');

-- 每個租戶補一筆生理假（已有 statutory_kind='menstrual' 或 code='menstrual' 的租戶略過）。
INSERT INTO public.leave_types (tenant_id, code, name, paid, special, requires_attachment, deduct_rate, statutory_kind)
SELECT t.id, 'menstrual', '生理假', true, true, false, 0.5, 'menstrual'
FROM public.tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM public.leave_types lt
  WHERE lt.tenant_id = t.id AND (lt.statutory_kind = 'menstrual' OR lt.code = 'menstrual')
)
ON CONFLICT (tenant_id, code) DO NOTHING;
