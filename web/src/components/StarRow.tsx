import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Star } from './icons'

// 餐後評分星排，三處共用：房內 RatingPrompt、首頁 RecentRatingPrompt、足跡頁補評。
// 評了就定案（不開放改評，足跡 spec 決策 #7）。
export default function StarRow({ historyId, onRated }: { historyId: string; onRated: (n: number) => void }) {
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
              // count:'exact'：RLS 擋下時 204 無 error，只看 error 會誤判成功。
              // .is('rating', null)：「評了就定案」落實到寫入層——stale 畫面／雙分頁
              // 點星不得覆寫既有評分（spec 決策 #7；DB 政策本身允許覆寫）
              const { error, count } = await supabase.from('dining_history')
                .update({ rating: n }, { count: 'exact' })
                .eq('id', historyId).is('rating', null)
              if (error || count === 0) {
                setSaveError('評分未儲存：這筆可能已評過，請重新整理')
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
