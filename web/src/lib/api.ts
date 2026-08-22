import { DIETARY_LABEL } from './labels'
import { supabase } from './supabase'

type PostOptions = {
  signal?: AbortSignal
  onRequestStart?: () => void
}

async function post(path: string, body?: unknown, options: PostOptions = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  options.signal?.throwIfAborted()
  const token = data.session?.access_token ?? ''
  options.onRequestStart?.()
  return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal,
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

export async function searchRoom(roomId: string, options: PostOptions = {}): Promise<SearchOutcome> {
  const res = await post(`/api/rooms/${roomId}/search`, undefined, options)
  if (res.status === 422) {
    const body = await res.json()
    const warning = body.degraded ? degradedWarning : null
    // 嚴格禁忌（素食）的定向檢索掛掉時結果集不完整，這時叫人放寬條件或換地點都是錯的
    // 建議——該叫人重試。伺服器只把嚴格禁忌詞放進這個欄位（菜系檢索失敗只少了補召回，
    // spec §7 容忍），所以有值就代表這次的結果不能當成「真的沒有」。兩種 422 都可能帶。
    const unfulfilled = (body.unfulfilled_dietary_terms ?? []) as string[]
    if (unfulfilled.length > 0) {
      const names = unfulfilled.map(t => DIETARY_LABEL[t] ?? t).join('、')
      return { error: `「${names}」的搜尋暫時失敗，這次的結果不完整，放寬條件不會有幫助。請稍後再試一次。`, warning }
    }
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

export async function editConditions(roomId: string): Promise<string | null> {
  return postAction(`/api/rooms/${roomId}/edit-conditions`, '修改條件失敗')
}

// 投票/否決/收回的唯一入口（D15）：Go 單一交易寫票 + 權威重算，Realtime 推回全員
export async function voteRoom(roomId: string, restaurantId: string,
  kind: 'up' | 'veto', op: 'cast' | 'retract'): Promise<string | null> {
  return postAction(`/api/rooms/${roomId}/vote`, '投票失敗',
    { restaurant_id: restaurantId, kind, op })
}

// 回首頁＝離席（ADR-0007）：mount 時打一次，退掉自己的所有房（殘留舊房自癒）。
// 失敗靜默——舊房留著，下次進首頁重試；不能擋首頁操作。
// 5 秒 timeout（eng review 1A）：建房/加入鈕等本函式 settle 才解禁，Go 惸而不斷時
// 不能讓只需 Supabase 的建房入口被懸掛的 fetch 鎖死。
// single-flight（eng review D12）：StrictMode dev 會雙跑 mount effect，第二發若晚於
// 新建房落地會誤刪新房——飛行中共用同一 promise，第二發不出網路。
let leaveInFlight: Promise<void> | null = null

export function leaveRooms(): Promise<void> {
  leaveInFlight ??= (async () => {
    try {
      await post('/api/leave', undefined, { signal: AbortSignal.timeout(5000) })
    } catch {
      // Go server 連不上／逾時：靜默，下次進首頁自癒
    } finally {
      leaveInFlight = null
    }
  })()
  return leaveInFlight
}
