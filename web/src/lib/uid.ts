import { supabase } from './supabase'

// 取目前使用者 id：getSession() 讀本地 JWT，不打網路。
// getUser() 每呼叫都是一趟 /auth/v1/user round-trip（QA ISSUE-006：單一建房流程 6+ 次）。
// 客戶端 uid 只用於查詢過濾與 UI，授權由 RLS 在伺服器端把關，本地讀就夠。
export async function getUid(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}
