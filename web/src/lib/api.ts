import { supabase } from './supabase'

async function post(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token ?? ''
  return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// 回傳給呼叫端顯示的錯誤訊息，成功則 null
export async function searchRoom(roomId: string): Promise<string | null> {
  const res = await post(`/api/rooms/${roomId}/search`)
  if (res.status === 422) {
    const body = await res.json()
    // 附近沒餐廳 ≠ 條件太嚴：後者叫人放寬條件才有用，前者要叫人換地點
    if (body.error === 'no_restaurants_in_range') return body.message
    const by = Object.entries((body.excluded_by ?? {}) as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
    const label: Record<string, string> = { budget: '預算', dietary: '飲食禁忌', closed: '營業時間' }
    // excluded_by 缺席/空物件時別把 undefined 插進字串
    return by.length === 0
      ? '找不到符合條件的餐廳，請放寬條件'
      : `找不到符合所有條件的餐廳。\n最主要原因：${label[by[0][0]] ?? by[0][0]}（排除 ${by[0][1]} 家）。\n請放寬條件後再試。`
  }
  if (!res.ok) return `搜尋失敗（${res.status}）`
  return null
}

export async function drawRoom(roomId: string): Promise<string | null> {
  const res = await post(`/api/rooms/${roomId}/draw`)
  return res.ok ? null : `抽選失敗（${res.status}）`
}
