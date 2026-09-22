-- =====================================================================
-- 0038  auth_set_user_password(user_id, bcrypt_hash)：管理員直接設定員工密碼
--
-- 背景：業主 09-22 要求「弱密碼只要管理員允許就不該強制阻擋」＋「後台要有管理員修改員工密碼」。
-- GoTrue admin API 的限制：createUser 可帶 password_hash 略過外洩密碼名單（HIBP），
-- 但 updateUserById 帶 password_hash 會回 200 卻不生效（adminUserUpdate 不讀 PasswordHash），
-- 帶明文 password 又一定過 HIBP。所以「租戶允許簡單密碼」時，重設只能直接寫 auth.users。
--
-- 做法：SECURITY DEFINER（owner postgres 才有 auth schema 寫入權）；hash 由 API 用 bcryptjs
-- 算好傳進來（函式只認 $2a$/$2b$/$2y$ 開頭的 bcrypt，GoTrue 驗密碼就是 bcrypt.CompareHashAndPassword）；
-- 寫完刪掉該使用者所有 auth.sessions（refresh_tokens／mfa_amr_claims 隨 FK cascade），
-- 舊裝置的 refresh 立刻失效，手上的 access token 最多再活到到期（預設 1 小時）。
-- 只 GRANT 給 service_role；API 端仍要先確認該 user 屬於呼叫者的租戶再呼叫。
-- 冪等，可重複執行。
-- =====================================================================
CREATE OR REPLACE FUNCTION public.auth_set_user_password(p_user_id uuid, p_password_hash text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  n int;
BEGIN
  IF p_user_id IS NULL OR p_password_hash IS NULL OR p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' THEN
    RAISE EXCEPTION 'invalid_password_hash';
  END IF;
  UPDATE auth.users
     SET encrypted_password = p_password_hash,
         updated_at = now()
   WHERE id = p_user_id
     AND deleted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RETURN false;
  END IF;
  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.auth_set_user_password(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_user_password(uuid, text) TO service_role;
COMMENT ON FUNCTION public.auth_set_user_password(uuid, text) IS
  'API 專用：租戶允許簡單密碼時，管理員重設員工密碼直接寫 auth.users.encrypted_password（bcrypt）並清掉該使用者所有 session。';
