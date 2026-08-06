// Supabase AuthError 的 message 一律是英文，UI 全中文所以改用 code 對照表
const MESSAGES: Record<string, string> = {
  weak_password: '密碼至少需要 6 碼',
  invalid_credentials: 'Email 或密碼錯誤',
  user_already_exists: '這個 Email 已經註冊過了',
  email_exists: '這個 Email 已經註冊過了',
  email_address_invalid: 'Email 格式不正確',
  over_request_rate_limit: '嘗試次數過多，請稍後再試',
  over_email_send_rate_limit: '驗證信寄送過於頻繁，請稍後再試',
  signup_disabled: '目前未開放註冊',
  email_not_confirmed: 'Email 尚未驗證，請先完成信箱驗證',
}

export function authErrorMessage(error: { code?: string; message: string }): string {
  const known = MESSAGES[error.code ?? '']
  if (known) return known
  // 連線失敗時還沒收到 response，沒有 code，只能靠 message 判斷（AuthRetryableFetchError）
  if (!error.code && /fetch|network/i.test(error.message)) return '連線失敗，請檢查網路後再試'
  return '操作失敗，請稍後再試'
}
