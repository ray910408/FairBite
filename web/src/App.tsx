import { useEffect, useState } from 'react'
// HashRouter：GitHub Pages 是純靜態，/room/:id 深連結在 BrowserRouter 下會 404，
// hash 路由不需要 404.html 轉址 hack。
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import { Spinner } from './components/icons'
import AuthPage from './pages/AuthPage'
import HomePage from './pages/HomePage'
import HistoryPage from './pages/HistoryPage'
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

function PageLoading({ text = '載入中…' }: { text?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-fg-muted">
      <Spinner className="h-7 w-7 text-brand" />
      <p className="text-sm">{text}</p>
    </div>
  )
}

function Guard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession()
  if (loading) return <PageLoading />
  if (!session) return <Navigate to="/auth" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/" element={<Guard><HomePage /></Guard>} />
        <Route path="/history" element={<Guard><HistoryPage /></Guard>} />
        <Route path="/room/:id" element={<Guard><RoomPage /></Guard>} />
      </Routes>
    </HashRouter>
  )
}
