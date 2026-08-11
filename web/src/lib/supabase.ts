import { createClient } from '@supabase/supabase-js'

const configuredUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseUrl = configuredUrl.startsWith('/')
  ? new URL(configuredUrl, globalThis.location?.origin ?? 'http://localhost').toString().replace(/\/$/, '')
  : configuredUrl

export const supabase = createClient(
  supabaseUrl,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)
