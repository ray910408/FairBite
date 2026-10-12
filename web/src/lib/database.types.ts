export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      account_resource_usage: {
        Row: {
          paid_day: number
          room_day: string
          room_window: string
          rooms_day: number
          rooms_window: number
          search_day: string
          search_window: string
          searches_day: number
          searches_window: number
          user_id: string
        }
        Insert: {
          paid_day?: number
          room_day?: string
          room_window?: string
          rooms_day?: number
          rooms_window?: number
          search_day?: string
          search_window?: string
          searches_day?: number
          searches_window?: number
          user_id: string
        }
        Update: {
          paid_day?: number
          room_day?: string
          room_window?: string
          rooms_day?: number
          rooms_window?: number
          search_day?: string
          search_window?: string
          searches_day?: number
          searches_window?: number
          user_id?: string
        }
        Relationships: []
      }
      dining_history: {
        Row: {
          decided_at: string
          id: string
          pref_hit: number | null
          rating: number | null
          restaurant_id: string
          room_id: string | null
          user_id: string
        }
        Insert: {
          decided_at?: string
          id?: string
          pref_hit?: number | null
          rating?: number | null
          restaurant_id: string
          room_id?: string | null
          user_id: string
        }
        Update: {
          decided_at?: string
          id?: string
          pref_hit?: number | null
          rating?: number | null
          restaurant_id?: string
          room_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dining_history_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dining_history_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dining_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      draws: {
        Row: {
          created_at: string
          id: string
          probabilities: Json
          room_id: string
          seed: string
          version: number
          winner_restaurant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          probabilities: Json
          room_id: string
          seed: string
          version: number
          winner_restaurant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          probabilities?: Json
          room_id?: string
          seed?: string
          version?: number
          winner_restaurant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draws_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draws_winner_restaurant_id_fkey"
            columns: ["winner_restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
        ]
      }
      exposure_stats: {
        Row: {
          chosen_count: number
          last_chosen_at: string | null
          recommended_count: number
          restaurant_id: string
          user_id: string
        }
        Insert: {
          chosen_count?: number
          last_chosen_at?: string | null
          recommended_count?: number
          restaurant_id: string
          user_id: string
        }
        Update: {
          chosen_count?: number
          last_chosen_at?: string | null
          recommended_count?: number
          restaurant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exposure_stats_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exposure_stats_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      guest_email_validations: {
        Row: {
          email: string
          expires_at: string
          phase: string
          updated_at: string
          user_id: string
        }
        Insert: {
          email: string
          expires_at: string
          phase: string
          updated_at?: string
          user_id: string
        }
        Update: {
          email?: string
          expires_at?: string
          phase?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      join_attempts: {
        Row: {
          attempted_at: string
          user_id: string
        }
        Insert: {
          attempted_at?: string
          user_id: string
        }
        Update: {
          attempted_at?: string
          user_id?: string
        }
        Relationships: []
      }
      location_change_votes: {
        Row: {
          room_id: string
          user_id: string
        }
        Insert: {
          room_id: string
          user_id: string
        }
        Update: {
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "location_change_votes_room_id_user_id_fkey"
            columns: ["room_id", "user_id"]
            isOneToOne: true
            referencedRelation: "room_members"
            referencedColumns: ["room_id", "user_id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          default_prefs: Json
          display_name: string
          id: string
        }
        Insert: {
          created_at?: string
          default_prefs?: Json
          display_name?: string
          id: string
        }
        Update: {
          created_at?: string
          default_prefs?: Json
          display_name?: string
          id?: string
        }
        Relationships: []
      }
      resource_quota_limits: {
        Row: {
          account_paid_daily_limit: number
          active_room_limit: number
          concurrent_search_limit: number
          global_paid_daily_limit: number
          paid_day: string
          paid_used: number
          room_daily_limit: number
          room_window_limit: number
          search_daily_limit: number
          search_window_limit: number
          singleton: boolean
        }
        Insert: {
          account_paid_daily_limit?: number
          active_room_limit?: number
          concurrent_search_limit?: number
          global_paid_daily_limit?: number
          paid_day?: string
          paid_used?: number
          room_daily_limit?: number
          room_window_limit?: number
          search_daily_limit?: number
          search_window_limit?: number
          singleton?: boolean
        }
        Update: {
          account_paid_daily_limit?: number
          active_room_limit?: number
          concurrent_search_limit?: number
          global_paid_daily_limit?: number
          paid_day?: string
          paid_used?: number
          room_daily_limit?: number
          room_window_limit?: number
          search_daily_limit?: number
          search_window_limit?: number
          singleton?: boolean
        }
        Relationships: []
      }
      restaurants: {
        Row: {
          address: string
          cuisine_tags: Json
          fetched_at: string
          id: string
          lat: number
          lng: number
          name: string
          opening_hours: Json
          place_id: string
          price_level: number
          primary_type: string | null
          rating: number | null
          source: string
          time_zone: string | null
        }
        Insert: {
          address?: string
          cuisine_tags?: Json
          fetched_at?: string
          id?: string
          lat: number
          lng: number
          name: string
          opening_hours?: Json
          place_id: string
          price_level?: number
          primary_type?: string | null
          rating?: number | null
          source: string
          time_zone?: string | null
        }
        Update: {
          address?: string
          cuisine_tags?: Json
          fetched_at?: string
          id?: string
          lat?: number
          lng?: number
          name?: string
          opening_hours?: Json
          place_id?: string
          price_level?: number
          primary_type?: string | null
          rating?: number | null
          source?: string
          time_zone?: string | null
        }
        Relationships: []
      }
      room_candidates: {
        Row: {
          batch_excluded: boolean
          exclusion_kinds: string[]
          exclusion_reason: string | null
          exposure_counted: boolean
          probability: number | null
          query_matches: string[]
          restaurant_id: string
          room_id: string
          shortlist_excluded: boolean
          status: string
          weight_breakdown: Json
        }
        Insert: {
          batch_excluded?: boolean
          exclusion_kinds?: string[]
          exclusion_reason?: string | null
          exposure_counted?: boolean
          probability?: number | null
          query_matches?: string[]
          restaurant_id: string
          room_id: string
          shortlist_excluded?: boolean
          status: string
          weight_breakdown?: Json
        }
        Update: {
          batch_excluded?: boolean
          exclusion_kinds?: string[]
          exclusion_reason?: string | null
          exposure_counted?: boolean
          probability?: number | null
          query_matches?: string[]
          restaurant_id?: string
          room_id?: string
          shortlist_excluded?: boolean
          status?: string
          weight_breakdown?: Json
        }
        Relationships: [
          {
            foreignKeyName: "room_candidates_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_candidates_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      room_members: {
        Row: {
          budget_max: number
          cuisines: Json
          dietary: Json
          joined_at: string
          max_distance_m: number
          ready: boolean
          room_id: string
          transport: string
          user_id: string
        }
        Insert: {
          budget_max?: number
          cuisines?: Json
          dietary?: Json
          joined_at?: string
          max_distance_m?: number
          ready?: boolean
          room_id: string
          transport?: string
          user_id: string
        }
        Update: {
          budget_max?: number
          cuisines?: Json
          dietary?: Json
          joined_at?: string
          max_distance_m?: number
          ready?: boolean
          room_id?: string
          transport?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_members_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rooms: {
        Row: {
          center_lat: number | null
          center_lng: number | null
          code: string
          created_at: string
          cuisine_filter: boolean
          delete_version: number
          draw_version: number
          exploration: string
          host_id: string
          id: string
          meal_time: string | null
          search_version: number
          status: string
        }
        Insert: {
          center_lat?: number | null
          center_lng?: number | null
          code?: string
          created_at?: string
          cuisine_filter?: boolean
          delete_version?: number
          draw_version?: number
          exploration?: string
          host_id: string
          id?: string
          meal_time?: string | null
          search_version?: number
          status?: string
        }
        Update: {
          center_lat?: number | null
          center_lng?: number | null
          code?: string
          created_at?: string
          cuisine_filter?: boolean
          delete_version?: number
          draw_version?: number
          exploration?: string
          host_id?: string
          id?: string
          meal_time?: string | null
          search_version?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "rooms_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      search_quota_leases: {
        Row: {
          expires_at: string
          id: string
          room_id: string
        }
        Insert: {
          expires_at: string
          id?: string
          room_id: string
        }
        Update: {
          expires_at?: string
          id?: string
          room_id?: string
        }
        Relationships: []
      }
      shortlist_picks: {
        Row: {
          restaurant_id: string
          room_id: string
          user_id: string
        }
        Insert: {
          restaurant_id: string
          room_id: string
          user_id: string
        }
        Update: {
          restaurant_id?: string
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shortlist_picks_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shortlist_picks_room_id_user_id_fkey"
            columns: ["room_id", "user_id"]
            isOneToOne: false
            referencedRelation: "room_members"
            referencedColumns: ["room_id", "user_id"]
          },
        ]
      }
      shortlist_votes: {
        Row: {
          room_id: string
          user_id: string
        }
        Insert: {
          room_id: string
          user_id: string
        }
        Update: {
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shortlist_votes_room_id_user_id_fkey"
            columns: ["room_id", "user_id"]
            isOneToOne: true
            referencedRelation: "room_members"
            referencedColumns: ["room_id", "user_id"]
          },
        ]
      }
      votes: {
        Row: {
          created_at: string
          kind: string
          restaurant_id: string
          room_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          kind: string
          restaurant_id: string
          room_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          kind?: string
          restaurant_id?: string
          room_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "votes_restaurant_id_fkey"
            columns: ["restaurant_id"]
            isOneToOne: false
            referencedRelation: "restaurants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "votes_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "votes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_room: { Args: { p_lat: number; p_lng: number }; Returns: string }
      get_my_default_prefs: {
        Args: never
        Returns: {
          default_prefs: Json
        }[]
      }
      is_room_lobby_locked: { Args: { p_room_id: string }; Returns: boolean }
      is_room_member: { Args: { p_room_id: string }; Returns: boolean }
      join_room: { Args: { p_code: string }; Returns: string }
      jsonb_is_string_array: { Args: { j: Json }; Returns: boolean }
      release_search_quota: { Args: { p_lease: string }; Returns: undefined }
      reserve_search_quota: {
        Args: { p_paid_calls: number; p_room_id: string; p_user_id: string }
        Returns: string
      }
      resolve_room_invite: {
        Args: { p_code: string }
        Returns: {
          is_member: boolean
          room_id: string
          status: string
        }[]
      }
      set_member_ready: {
        Args: { p_ready: boolean; p_room_id: string; p_search_version: number }
        Returns: boolean
      }
      valid_member_choices: {
        Args: { allowed: string[]; j: Json; max_items: number }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

