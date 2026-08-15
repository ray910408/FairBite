import { supabase } from './supabase'

async function post(path: string, body?: unknown): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token ?? ''
  return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// 共用錯誤萃取：伺服器 body.error 優先，沒有才用 fallback + 狀態碼
async function postAction(path: string, fallback: string, body?: unknown): Promise<string | null> {
  const res = await post(path, body)
  if (res.ok) return null
  const msg = await res.json().then(b => b.error as string).catch(() => null)
  return msg || `${fallback}（${res.status}）`
}

export type SearchOutcome = { error: string | null; warning: string | null }

const degradedWarning = '外部搜尋暫時失敗，本次使用 30 天內的快取資料'

export async function searchRoom(roomId: string): Promise<SearchOutcome> {
  const res = await post(`/api/rooms/${roomId}/search`)
  if (res.status === 422) {
    const body = await res.json()
    const warning = body.degraded ? degradedWarning : null
    // 附近沒餐廳 ≠ 條件太嚴：後者叫人放寬條件才有用，前者要叫人換地點
    if (body.error === 'no_restaurants_in_range') return { error: body.message, warning }
    const by = Object.entries((body.excluded_by ?? {}) as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
    const label: Record<string, string> = { budget: '預算', dietary: '飲食禁忌', closed: '營業時間', cuisine: '菜系' }
    // excluded_by 缺席/空物件時別把 undefined 插進字串
    return {
      error: by.length === 0
        ? '找不到符合條件的餐廳，請放寬條件'
        : `找不到符合所有條件的餐廳。\n最主要原因：${label[by[0][0]] ?? by[0][0]}（排除 ${by[0][1]} 家）。\n請放寬條件後再試。`,
      warning,
    }
  }
  if (!res.ok) {
    const msg = await res.json().then(b => b.error as string).catch(() => null)
    return { error: msg || `搜尋失敗（${res.status}）`, warning: null }
  }
  const body = await res.json()
  return {
    error: null,
    warning: body.degraded ? degradedWarning : null,
  }
}

export async function drawRoom(roomId: string): Promise<string | null> {
  return postAction(`/api/rooms/${roomId}/draw`, '抽選失敗')
}

export async function startVoting(roomId: string): Promise<string | null> {
  return postAction(`/api/rooms/${roomId}/start-voting`, '開始投票失敗')
}

// 投票/否決/收回的唯一入口（D15）：Go 單一交易寫票 + 權威重算，Realtime 推回全員
export async function voteRoom(roomId: string, restaurantId: string,
  kind: 'up' | 'veto', op: 'cast' | 'retract'): Promise<string | null> {
  return postAction(`/api/rooms/${roomId}/vote`, '投票失敗',
    { restaurant_id: restaurantId, kind, op })
}
