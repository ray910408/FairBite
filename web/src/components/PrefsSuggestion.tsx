import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getUid } from '../lib/uid'
import { CUISINE_LABEL, CUISINE_OPTIONS } from '../lib/labels'
import { suggestCuisines } from '../lib/prefsLearning'
import { addDismissed, readDismissed } from '../lib/dismissed'
import { Alert } from './icons'

// 偏好學習建議卡（spec §11 P3）：房間頁 lobby 最上方，進房設條件時就看得到。
// 套用＝寫進預設偏好（之後發起／加入聚餐自動帶入），onApply 同時加進這次的條件；忽略記在這台裝置。
// 三筆查詢任一失敗就不推論（缺低分列會把打過低分的菜系一起建議），只顯示非阻擋訊息。
export default function PrefsSuggestion({ onApply }: { onApply?: (cuisines: string[]) => void }) {
  const [uid, setUid] = useState('')
  const [prefs, setPrefs] = useState<Record<string, unknown>>({})
  const [suggestion, setSuggestion] = useState<string[]>([])
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let live = true
    ;(async () => {
      const me = await getUid()
      if (!live || !me) return
      const [
        { data: profile, error: profileError },
        { data: history, error: historyError },
        { data: lowRows, error: lowRowsError },
      ] = await Promise.all([
        supabase.rpc('get_my_default_prefs').single(),
        supabase.from('dining_history')
          .select('rating, restaurants(cuisine_tags)')
          .order('decided_at', { ascending: false }).limit(50),
        supabase.from('dining_history')
          .select('rating, restaurants(cuisine_tags)').lte('rating', 2),
      ])
      if (!live) return
      if (profileError || historyError || lowRowsError) {
        setLoadError('口味建議暫時載入失敗；不影響本次聚餐條件')
        return
      }
      if (!profile) return
      const dp = (profile.default_prefs ?? {}) as Record<string, unknown>
      const current = Array.isArray(dp.cuisines) ? (dp.cuisines as string[]) : []
      const tags = suggestCuisines([...(lowRows ?? []), ...(history ?? [])], current,
        CUISINE_OPTIONS.map(([k]) => k))
      const dismissed = readDismissed(`prefs-suggest-dismissed:${me}`)
      setUid(me)
      setPrefs(dp)
      setSuggestion(tags.filter(t => !dismissed.includes(t)))
    })()
    return () => { live = false }
  }, [])

  async function apply() {
    setSaveError('')
    const cur = Array.isArray(prefs.cuisines) ? (prefs.cuisines as string[]) : []
    const { error } = await supabase.from('profiles').update({
      default_prefs: { ...prefs, cuisines: [...new Set([...cur, ...suggestion])] },
    }).eq('id', uid)
    if (error) return setSaveError('偏好儲存失敗，請稍後再試')
    onApply?.(suggestion)
    setSuggestion([])
  }

  if (loadError) {
    return (
      <p role="status" className="banner bg-warn-soft text-warn">
        <Alert className="h-5 w-5 shrink-0" />
        <span>{loadError}</span>
      </p>
    )
  }
  if (suggestion.length === 0 && !saveError) return null
  return (
    <>
      {suggestion.length > 0 && (
        <section className="card animate-rise space-y-2">
          <p className="text-sm">
            根據你的用餐紀錄，你常吃：
            <span className="font-semibold">{suggestion.map(t => CUISINE_LABEL[t] ?? t).join('、')}</span>
            。要加入預設偏好嗎？會套用到這次的條件，之後的聚餐也會自動帶入。
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary flex-1" onClick={() => void apply()}>套用</button>
            <button type="button" className="btn btn-quiet" onClick={() => {
              addDismissed(`prefs-suggest-dismissed:${uid}`, suggestion)
              setSuggestion([])
            }}>忽略</button>
          </div>
        </section>
      )}
      {saveError && (
        <p role="alert" className="banner bg-danger-soft text-danger">
          <Alert className="h-5 w-5 shrink-0" />
          <span>{saveError}</span>
        </p>
      )}
    </>
  )
}
