import { supabase } from './supabase'
import { getUid } from './uid'
import { CUISINE_OPTIONS } from './labels'

type PrivatePrefs = { default_prefs: Record<string, unknown> }

// default_prefs 帶入（spec §4；eng review D18 客戶端直寫版，取代 RPC 五欄位框架）：
// 建/加成功後、導頁前，若有預設偏好就寫進自己的 member row（lobby 的 members_update
// RLS 本來就允許）。失敗只影響預設值（罕見：搜尋凍結競態），靜默接受不擋導頁。
export async function applyDefaultPrefs(roomId: string) {
  const uid = await getUid()
  if (!uid) return
  const appliedKey = `prefs-applied:${roomId}:${uid}`
  if (localStorage.getItem(appliedKey)) return
  const { data: profile, error: profileError } = await supabase.rpc('get_my_default_prefs').single<PrivatePrefs>()
  if (profileError) return
  const raw = (profile?.default_prefs as { cuisines?: string[] } | null)?.cuisines
  // 詞彙可能收縮（如 2026-08-13 移除 sichuan）：只帶入仍在選單上的 tag，
  // 免得既存預設偏好裡的死選項繼續拖低滿足度 EMA（永無 pref hit）
  const allowed = new Set(CUISINE_OPTIONS.map(([k]) => k))
  const cuisines = Array.isArray(raw) ? raw.filter(c => allowed.has(c)) : raw
  if (!Array.isArray(cuisines) || cuisines.length === 0) {
    localStorage.setItem(appliedKey, '1')
    return
  }
  const { error } = await supabase.from('room_members').update({ cuisines })
    .eq('room_id', roomId).eq('user_id', uid)
    .eq('cuisines', '[]') // 只填仍是預設的列：重複加入不得覆蓋使用者已調好的條件（task6 review r1）
  if (!error) localStorage.setItem(appliedKey, '1')
}

