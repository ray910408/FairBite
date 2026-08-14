import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getUid } from '../lib/uid'
import StarRow from './StarRow'

// 餐後評分（spec §5 滿足度）：輕量、永遠可跳過。跳過 = 不寫任何東西，
// 滿足度樣本改用伺服器端 pref_hit。房間一次性（ADR-0004）→「餐後」的
// 真正入口是 HomePage 的 RecentRatingPrompt（最近 1 筆未評，eng review D4）。

// decided 房間頁：抽完當下想先評的人用
export default function RatingPrompt({ roomId }: { roomId: string }) {
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [rating, setRating] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let live = true
    supabase.from('dining_history').select('id, rating')
      .eq('room_id', roomId).maybeSingle() // RLS 只回自己的列
      .then(({ data }) => {
        if (!live || !data) return
        setHistoryId(data.id)
        setRating(data.rating)
      })
    return () => { live = false }
  }, [roomId])

  if (!historyId || dismissed) return null
  if (rating !== null) {
    return <p className="text-center text-sm text-fg-muted">已評分 {rating} 顆星，滿足度已記錄</p>
  }
  return (
    <div className="card animate-rise space-y-3 text-center">
      <p className="text-sm font-semibold">這一餐吃得滿意嗎？（之後也可以在首頁評）</p>
      <StarRow historyId={historyId} onRated={setRating} />
      <button type="button" className="text-sm text-fg-muted underline"
        onClick={() => setDismissed(true)}>
        略過
      </button>
    </div>
  )
}

// HomePage：只提示最近 1 筆、7 天內、未評分的同席紀錄（eng review D4 附帶約束）。
// 略過依使用者保存 historyId 集合，同一筆不再糾纏；下一筆新紀錄自然重新出現。
export function RecentRatingPrompt({ onRated }: { onRated?: () => void } = {}) {
  const [row, setRow] = useState<{ id: string; name: string } | null>(null)
  const [rated, setRated] = useState(false)
  const [userId, setUserId] = useState('')

  useEffect(() => {
    let live = true
    ;(async () => {
      const uid = await getUid()
      if (!live || !uid) return
      const { data } = await supabase.from('dining_history')
        .select('id, rating, decided_at, restaurants(name)')
        .is('rating', null)
        .gte('decided_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
        .order('decided_at', { ascending: false })
        .limit(1)
      const r = data?.[0]
      if (!live || !r) return
      const dismissed = (localStorage.getItem(`rating-dismissed:${uid}`) ?? '').split(',')
      if (dismissed.includes(r.id)) return
      setUserId(uid)
      setRow({ id: r.id, name: (r.restaurants as unknown as { name: string } | null)?.name ?? '上一餐' })
    })()
    return () => { live = false }
  }, [])

  if (!row || rated) return null
  return (
    <section className="card animate-rise space-y-3 text-center">
      <p className="text-sm font-semibold">上次吃的《{row.name}》滿意嗎？</p>
      <StarRow historyId={row.id} onRated={() => { setRated(true); onRated?.() }} />
      <button type="button" className="text-sm text-fg-muted underline"
        onClick={() => {
          const dismissedKey = `rating-dismissed:${userId}`
          const dismissed = (localStorage.getItem(dismissedKey) ?? '').split(',')
          localStorage.setItem(dismissedKey,
            [...new Set([...dismissed, row.id])].filter(Boolean).join(','))
          setRow(null)
        }}>
        略過
      </button>
    </section>
  )
}
