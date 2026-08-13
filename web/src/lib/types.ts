export type TraceEntry = { factor: string; mult: number; reason: string }

// center_lat/center_lng 刻意不在這裡：0015 起 rooms 的 SELECT 是欄級 grant，
// 圓心只有 service role 讀得到（圓心就是房主建房當下的精確位置，前端讀得到
// 等於把房主的家門口開給任何拿到邀請碼的人）
export type Room = {
  id: string
  code: string
  host_id: string
  status: 'lobby' | 'candidates' | 'voting' | 'decided'
  exploration: 'familiar' | 'balanced' | 'explore'
  // NULL = 馬上出發（migration 0017）
  meal_time: string | null
}

export type MemberRow = {
  room_id: string
  user_id: string
  budget_max: number
  cuisines: string[]
  dietary: string[]
  max_distance_m: number
  transport: 'walking' | 'driving' | 'transit'
  ready: boolean
  profiles?: { display_name: string }
}

export type RestaurantRef = {
  name: string
  lat: number
  lng: number
  place_id: string
  // 出身欄位（restaurants.source，migration 0013）：'google' | 'mock'
  source: string
}

export type CandidateRow = {
  room_id: string
  restaurant_id: string
  status: 'kept' | 'excluded'
  probability: number | null
  weight_breakdown: TraceEntry[]
  exclusion_reason: string | null
  exclusion_kinds: string[]
  restaurants: RestaurantRef
}

export type VoteRow = {
  room_id: string
  user_id: string
  restaurant_id: string
  kind: 'up' | 'veto'
}

export type DrawRow = {
  room_id: string
  winner_restaurant_id: string
  seed: string
  probabilities: Record<string, number>
}
