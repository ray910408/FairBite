import { createClient } from '@supabase/supabase-js'

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

export const supabase = createClient(
  supabaseUrl,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { global: { fetch: fetchRetryingStaleClock } },
)
