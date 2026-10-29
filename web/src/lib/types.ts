import type { Database as GeneratedDatabase } from './database.types'

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
  // 候選列的店家資訊（labels.ts restaurantFacts、maps.ts buildMapsUrl）；只有房內候選查詢會帶
  address?: string
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

// supabase client 用的 Database 型別：產生的 database.types.ts 裡 text＋CHECK 欄位只到 string、
// jsonb 欄位只到 Json，這裡只把前端讀的這幾欄收窄成上面的手寫型別（只動 Row，寫入照產生型別）。
// NarrowRow 的約束要求收窄的欄位存在於產生型別、收窄後的型別也指派得回產生型別：被收窄的欄位
// 改名、刪除或改成不相容的型別時，這裡報 TS2344（少了約束的話 Omit 會略過不存在的 key、& Cols 又把
// 欄位加回去，改名照樣編譯過）。其餘欄位照產生型別：改名或改型別時，查詢結果交給手寫型別的地方報錯。
// 收窄成陣列的 jsonb 欄位（cuisines、dietary 等）用 eq／contains 過濾時別直接傳陣列：eq 會把 [] 變成
// 空字串、contains 會把陣列轉成 Postgres 陣列字面 {…}，都不是 jsonb 要的 JSON；要送 JSON 字面字串，例如 defaultPrefs.ts 的 '[]'
type Tables = GeneratedDatabase['public']['Tables']
type NarrowRow<T extends keyof Tables, Cols extends {
  [K in keyof Cols]: K extends keyof Tables[T]['Row'] ? Tables[T]['Row'][K] : never
}> = Omit<Tables[T], 'Row'> & { Row: Omit<Tables[T]['Row'], keyof Cols> & Cols }
export type Database = {
  public: Omit<GeneratedDatabase['public'], 'Tables'> & {
    Tables: Omit<Tables, 'rooms' | 'room_members' | 'room_candidates' | 'restaurants' | 'draws' | 'votes'> & {
      rooms: NarrowRow<'rooms', Pick<Room, 'status' | 'exploration'>>
      room_members: NarrowRow<'room_members', Pick<MemberRow, 'transport' | 'cuisines' | 'dietary'>>
      room_candidates: NarrowRow<'room_candidates', Pick<CandidateRow, 'status' | 'weight_breakdown'>>
      restaurants: NarrowRow<'restaurants', { cuisine_tags: string[] }>
      draws: NarrowRow<'draws', Pick<DrawRow, 'probabilities'>>
      votes: NarrowRow<'votes', Pick<VoteRow, 'kind'>>
    }
  }
}
