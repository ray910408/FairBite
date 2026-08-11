import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Star } from './icons'

// 餐後評分（spec §5 滿足度）：輕量、永遠可跳過。跳過 = 不寫任何東西，
// 滿足度樣本改用伺服器端 pref_hit。房間一次性（ADR-0004）→「餐後」的
// 真正入口是 HomePage 的 RecentRatingPrompt（最近 1 筆未評，eng review D4）。
function StarRow({ historyId, onRated }: { historyId: string; onRated: (n: number) => void }) {
  const [saveError, setSaveError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <>
      <div className="flex justify-center gap-1">
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} type="button" aria-label={`${n} 顆星`}
            disabled={busy}
            className="flex h-11 w-11 items-center justify-center rounded-xl text-fg-muted hover:text-brand disabled:opacity-50"
            onClick={async () => {
              setSaveError('')
              setBusy(true)
              // count:'exact'：RLS 擋下時 204 無 error，只看 error 會誤判成功
              const { error, count } = await supabase.from('dining_history')
                .update({ rating: n }, { count: 'exact' }).eq('id', historyId)
              if (error || count === 0) {
                setSaveError('評分儲存失敗，請再試一次')
                setBusy(false)
              } else onRated(n)
            }}>
            <Star className="h-7 w-7" />
          </button>
        ))}
      </div>
      {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
    </>
  )
}

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
// 略過以 historyId 記 localStorage，同一筆不再糾纏；下一筆新紀錄自然重新出現。
export function RecentRatingPrompt() {
  const [row, setRow] = useState<{ id: string; name: string } | null>(null)
  const [rated, setRated] = useState(false)

  useEffect(() => {
    let live = true
    supabase.from('dining_history')
      .select('id, rating, decided_at, restaurants(name)')
      .is('rating', null)
      .gte('decided_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
      .order('decided_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        const r = data?.[0]
        if (!live || !r) return
        if (localStorage.getItem('rating-dismissed') === r.id) return
        setRow({ id: r.id, name: (r.restaurants as unknown as { name: string } | null)?.name ?? '上一餐' })
      })
    return () => { live = false }
  }, [])

  if (!row || rated) return null
  return (
    <section className="card animate-rise space-y-3 text-center">
      <p className="text-sm font-semibold">上次吃的《{row.name}》滿意嗎？</p>
      <StarRow historyId={row.id} onRated={() => setRated(true)} />
      <button type="button" className="text-sm text-fg-muted underline"
        onClick={() => { localStorage.setItem('rating-dismissed', row.id); setRow(null) }}>
        略過
      </button>
    </section>
  )
}
