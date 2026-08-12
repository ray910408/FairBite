export type TraceEntry = { factor: string; mult: number; reason: string }

// center_lat/center_lng 刻意不在這裡：0015 起 rooms 的 SELECT 是欄級 grant，
// 圓心只有 service role 讀得到（前端讀得到就能反推同房成員的精確座標）
export type Room = {
  id: string
  code: string
  host_id: string
  status: 'lobby' | 'candidates' | 'voting' | 'decided'
  exploration: 'familiar' | 'balanced' | 'explore'
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
