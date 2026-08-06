export type TraceEntry = { factor: string; mult: number; reason: string }

export type Room = {
  id: string
  code: string
  host_id: string
  status: 'lobby' | 'candidates' | 'decided'
  center_lat: number
  center_lng: number
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
}

export type CandidateRow = {
  room_id: string
  restaurant_id: string
  status: 'kept' | 'excluded'
  probability: number | null
  weight_breakdown: TraceEntry[]
  exclusion_reason: string | null
  restaurants: RestaurantRef
}

export type DrawRow = {
  room_id: string
  winner_restaurant_id: string
  seed: string
  probabilities: Record<string, number>
}