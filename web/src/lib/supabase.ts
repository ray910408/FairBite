import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'
import { clearDepartures } from './departure'

const configuredUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseUrl = configuredUrl.startsWith('/')
  ? new URL(configuredUrl, globalThis.location?.origin ?? 'http://localhost').toString().replace(/\/$/, '')
  : configuredUrl

// PostgREST < 14.18 閒置後快取時鐘會停在舊值（上游 PostgREST#5196），剛簽發的 JWT 被判
// iat 在未來而回 401 PGRST303：新帳號一進首頁，房籍查詢失敗跳「你還在房間裡」、口味建議也
// 一起失敗（TODOS ISSUE-006）。JWT 驗證在任何 SQL 之前，被擋下的請求沒有副作用，隔一秒原樣
// 重送一次就落在追上的時鐘上；只認這個錯誤，其他 401 照常交給呼叫端。
async function fetchRetryingStaleClock(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, init)
  if (res.status !== 401) return res
  const body = await res.clone().json().catch(() => null) as { code?: string; message?: string } | null
  if (body?.code !== 'PGRST303' || !body.message?.startsWith('JWT issued at future')) return res
  await new Promise(resolve => setTimeout(resolve, 1000))
  return fetch(input, init)
}

// 驗證信回跳在網址帶 ?code=（PKCE）。auth-js 初始化時，本機留有 code_verifier 就換成 session 並把 code 移除；
// 在別的裝置點信（沒有 verifier）或換失敗（例如寄信超過 5 分鐘才點，flow state 過期）時 code 會原封不動留著。
// 連結本身失效（過期、已用過）時 GoTrue 改帶 ?error=…&error_code=…&error_description=…。
// 先記下落地狀態，AuthPage 等初始化完再分辨，處理完設回 false，之後再進 /auth 不會重複處理。
const landing = new URLSearchParams(globalThis.location?.search)
export const emailCallback = { pending: landing.has('code'), failed: landing.has('error') }

// error 參數不清掉會一直留在這個分頁：重寄驗證信時被 emailRedirectTo 帶進新連結（auth-js 看到 error 就不換新的 code），
// 邀請連結也會帶著它。在 createClient 之前清，auth-js 只會看到乾淨的網址。
if (emailCallback.failed) {
  const url = new URL(globalThis.location.href)
  for (const key of ['error', 'error_code', 'error_description']) url.searchParams.delete(key)
  globalThis.history.replaceState(globalThis.history.state, '', url)
}

export const supabase = createClient<Database>(
  supabaseUrl,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    // implicit（預設）會把網址 #access_token=… 直接存成 session：攻擊者把自己的 token 包成連結，
    // 點開的人就被換成攻擊者的身分（login CSRF）。PKCE 只認本機 code_verifier 換得到的 code。
    auth: { flowType: 'pkce' },
    global: { fetch: fetchRetryingStaleClock },
  },
)

// 共用裝置：登出後不留上一個人的出發點座標。掛在事件上，按鈕登出與 refresh token 失效被登出都會清
supabase.auth.onAuthStateChange(event => {
  if (event === 'SIGNED_OUT') clearDepartures()
})
