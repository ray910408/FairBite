import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Star } from './icons'

// 餐後評分星排，三處共用：房內 RatingPrompt、首頁 RecentRatingPrompt、足跡頁補評。
// 評了就定案（不開放改評，足跡 spec 決策 #7）——所以點星只是選，按「送出評分」才寫入：
// 手機沒有 hover 預覽，誤觸一下不能就成定局。
export default function StarRow({ historyId, onRated }: { historyId: string; onRated: (n: number) => void }) {
  const [saveError, setSaveError] = useState('')
  const [busy, setBusy] = useState(false)
  // 累計預覽：滑過／focus 第 N 顆時 1..N 一起亮（評分語意是 1..N，不是單選）。
  const [preview, setPreview] = useState(0)
  // 選了幾顆（尚未寫入）
  const [selected, setSelected] = useState(0)
  const lit = preview || selected
  async function submit() {
    setSaveError('')
    setBusy(true)
    // count:'exact'：RLS 擋下時 204 無 error，只看 error 會誤判成功。
    // .is('rating', null)：「評了就定案」落實到寫入層——stale 畫面／雙分頁
    // 送出不得覆寫既有評分（spec 決策 #7；DB 政策本身允許覆寫）
    const { error, count } = await supabase.from('dining_history')
      .update({ rating: selected }, { count: 'exact' })
      .eq('id', historyId).is('rating', null)
    if (error || count === 0) {
      setSaveError('評分未儲存：這筆可能已評過，請重新整理')
      setBusy(false)
    } else onRated(selected)
  }
  // 單一欄置中：三個呼叫端的容器排版不同（卡片置中、足跡列靠左），送出鈕都要在星排正下方
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-wrap justify-center gap-1"
        onMouseLeave={() => setPreview(0)} onBlur={() => setPreview(0)}>
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} type="button" aria-label={`${n} 顆星`} aria-pressed={n === selected}
            disabled={busy}
            className={`flex h-11 w-11 items-center justify-center rounded-btn disabled:opacity-50 ${
              n <= lit ? 'text-brand' : 'text-fg-muted'}`}
            onMouseEnter={() => setPreview(n)} onFocus={() => setPreview(n)}
            onClick={() => setSelected(n)}>
            <Star className="h-7 w-7" filled={n <= lit} />
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-primary px-6"
        disabled={selected === 0 || busy} aria-busy={busy} onClick={submit}>
        送出評分
      </button>
      {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
    </div>
  )
}
