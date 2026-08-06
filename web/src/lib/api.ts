import { supabase } from './supabase'

async function post(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token ?? ''
  return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

export async function searchRoom(roomId: string) {
  const res = await post(`/api/rooms/${roomId}/search`)
  if (res.status === 422) {
    const body = await res.json()
    const by = Object.entries(body.excluded_by as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
    const label: Record<string, string> = { budget: '預算', dietary: '飲食禁忌', closed: '營業時間' }
    alert(`找不到符合所有條件的餐廳。\n最主要原因：${label[by[0]?.[0]] ?? by[0]?.[0]}（排除 ${by[0]?.[1]} 家）。\n請放寬條件後再試。`)
  } else if (!res.ok) {
    alert(`搜尋失敗（${res.status}）`)
  }
}

export async function drawRoom(roomId: string) {
  const res = await post(`/api/rooms/${roomId}/draw`)
  if (!res.ok) alert(`抽選失敗（${res.status}）`)
}
