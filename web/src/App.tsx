import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import AuthPage from './pages/AuthPage'
import HomePage from './pages/HomePage'
import RoomPage from './pages/RoomPage'

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])
  return { session, loading }
}

function Guard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession()
  if (loading) return <p className="p-8 text-center">載入中…</p>
  if (!session) return <Navigate to="/auth" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/" element={<Guard><HomePage /></Guard>} />
        <Route path="/room/:id" element={<Guard><RoomPage /></Guard>} />
      </Routes>
    </BrowserRouter>
  )
}
