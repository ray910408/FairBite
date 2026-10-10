export type TraceEntry = { factor: string; mult: number; reason: string }

// center_lat/center_lng 刻意不在這裡：0015 起 rooms 的 SELECT 是欄級 grant，
// 圓心只有 service role 讀得到（圓心就是房主建房當下的精確位置，前端讀得到
// 等於把房主的家門口開給任何拿到邀請碼的人）
export type Room = {
  id: string
  code: string
  host_id: string
  status: 'lobby' | 'candidates' | 'shortlisting' | 'voting' | 'relocating' | 'pending' | 'decided'
  exploration: 'familiar' | 'balanced' | 'explore'
  // NULL = 馬上出發（migration 0017）
  meal_time: string | null
  // 房主菜系過濾開關（migration 0021）：開啟時不符成員菜系偏好的店被硬性排除
  cuisine_filter: boolean
  draw_version: number
  search_version: number
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
  // 候選列的店家資訊（labels.ts restaurantFacts）；只有房內候選查詢會帶
  rating?: number | null
  price_level?: number | null
  cuisine_tags?: string[]
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
  version: number
}

export type LocationVoteRow = { room_id: string; user_id: string }

// 初選（ADR-0010）：表決意願與圈選，client 只讀，寫入走 Go
export type ShortlistVoteRow = { room_id: string; user_id: string }
export type ShortlistPickRow = { room_id: string; user_id: string; restaurant_id: string }
