-- =====================================================================
-- 0035  兩支給 API（service_role）用的函式 ＋ rate_limits 的 RLS
--
-- (1) auth_user_by_email(email)：**不產生任何 token** 的帳號查詢。
--     背景：auth-invite.ts 原本用 generateLink({type:'recovery'}) 探測「這個 email
--     有沒有帳號」，但 generateLink 本身就會替該帳號**輪替 recovery token**——
--     探測完才發現帳號屬於別的租戶而回 409，等於一次失敗的邀請就讓無關第三方
--     手上的重設連結失效（輕度 DoS）。忘記密碼同樣先產 token 再判斷要不要寄。
--     改成先用這支查，確認歸屬／綁定都對了才 generateLink。
--     只回三個欄位（id、email、app_metadata），不回 hash、不回電話。
--
-- (2) rate_limit_touch(key, window_seconds)：跨 instance 的原子節流。
--     單一 INSERT … ON CONFLICT DO UPDATE … WHERE last_at 過期 → RETURNING；
--     視窗內第二次呼叫 UPDATE 的 WHERE 不成立 → 沒有列回來 → false。
--     Postgres 對同一 key 的兩個併發 upsert 會序列化（唯一鍵），不會兩個都 true。
--
-- 兩支都只 GRANT 給 service_role；anon／authenticated 連 EXECUTE 都沒有。
-- 冪等，可重複執行。
-- =====================================================================

-- ── (1) 帳號查詢（不產 token）──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_user_by_email(p_email text)
RETURNS TABLE (id uuid, email text, app_metadata jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
  SELECT u.id, u.email::text, COALESCE(u.raw_app_meta_data, '{}'::jsonb)
    FROM auth.users u
   WHERE lower(u.email) = lower(trim(p_email))
     AND u.deleted_at IS NULL
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.auth_user_by_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_by_email(text) TO service_role;
COMMENT ON FUNCTION public.auth_user_by_email(text) IS
  'API 專用：依 email 查 auth.users 的 id／email／app_metadata，不產生 token（取代 generateLink 探測，避免輪替第三方 recovery token）。';

-- ── (2) 節流 ───────────────────────────────────────────────────────────
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.rate_limit_touch(p_key text, p_window_seconds integer)
RETURNS boolean
LANGUAGE sql VOLATILE
AS $$
  -- 用 clock_timestamp() 不用 now()：now() 是交易開始時間，同一交易內多次呼叫會凍結，
  -- 在批次腳本或長交易裡驗證會得到錯的答案；每個 API 請求各自一個交易則兩者相同。
  WITH touched AS (
    INSERT INTO public.rate_limits (key, last_at)
    VALUES (p_key, clock_timestamp())
    ON CONFLICT (key) DO UPDATE
      SET last_at = EXCLUDED.last_at
      WHERE public.rate_limits.last_at < clock_timestamp() - make_interval(secs => p_window_seconds)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM touched);
$$;
REVOKE ALL ON FUNCTION public.rate_limit_touch(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_touch(text, integer) TO service_role;
COMMENT ON FUNCTION public.rate_limit_touch(text, integer) IS
  '原子節流：視窗內第一次呼叫回 true 並記錄時間，其後回 false，過期後再回 true。跨 API instance 有效。';

-- ── 清理：過期超過一天的節流列沒有保留價值（排程或人工皆可跑）────────
-- DELETE FROM public.rate_limits WHERE last_at < now() - interval '1 day';
