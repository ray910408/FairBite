import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { MemberRow } from '../lib/types'
import { CUISINE_OPTIONS, DIETARY_OPTIONS, TRANSPORT_LABELS } from '../lib/labels'
import { Alert, Check } from './icons'

const TRANSPORTS = Object.entries(TRANSPORT_LABELS) as [MemberRow['transport'], string][]

export default function ConditionsForm({ me }: { me: MemberRow }) {
  const [form, setForm] = useState(me)
  const [saveError, setSaveError] = useState('')
  const savedRef = useRef(me)   // 最後一次確認寫入成功的值（失敗時還原用）
  const pushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    setForm(me)
    savedRef.current = me
  }, [me.room_id, me.user_id])

  // debounce 400ms：slider 拖曳每格都會觸發 onChange，直接連發 update 會逆序落庫
  function save(patch: Partial<MemberRow>) {
    const next = { ...form, ...patch }
    setForm(next)
    clearTimeout(pushTimer.current)
    pushTimer.current = setTimeout(async () => {
      // count: 'exact'：RLS 凍結時 UPDATE 影響 0 列且回 204 無 error，只看 error 會誤判成功
      const { error, count } = await supabase.from('room_members').update({
        budget_max: next.budget_max,
        cuisines: next.cuisines,
        dietary: next.dietary,
        max_distance_m: next.max_distance_m,
        transport: next.transport,
        ready: next.ready,
      }, { count: 'exact' }).eq('room_id', me.room_id).eq('user_id', me.user_id)
      if (error || count === 0) {
        setForm(savedRef.current) // RLS 拒絕（如房間已離開 lobby）→ 還原，不讓 UI 與 DB 分歧
        setSaveError('儲存失敗：房間可能已開始選餐，條件已凍結')
      } else {
        savedRef.current = next
        setSaveError('')
      }
    }, 400)
  }

  function toggle(list: string[], v: string) {
    return list.includes(v) ? list.filter(x => x !== v) : [...list, v]
  }

  return (
    <div className="card animate-rise space-y-5">
      <h2 className="text-base font-semibold">我的條件</h2>

      {saveError && (
        <p role="alert" className="banner bg-danger-soft text-danger">
          <Alert className="h-5 w-5 shrink-0" />
          <span>{saveError}</span>
        </p>
      )}

      <label className="block space-y-1">
        <span className="flex items-baseline justify-between">
          <span className="label">每人預算上限</span>
          <span className="font-mono text-sm font-semibold text-brand">NT${form.budget_max}</span>
        </span>
        <input type="range" min={100} max={1600} step={100} className="h-6 w-full"
          value={form.budget_max}
          onChange={e => save({ budget_max: +e.target.value })} />
      </label>

      <div role="group" aria-labelledby="cuisine-label">
        <span id="cuisine-label" className="label">料理偏好</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {CUISINE_OPTIONS.map(([v, label]) => (
            <button key={v} type="button" aria-pressed={form.cuisines.includes(v)}
              className={`chip ${form.cuisines.includes(v)
                ? 'border-brand bg-brand text-white hover:bg-brand-strong' : ''}`}
              onClick={() => save({ cuisines: toggle(form.cuisines, v) })}>{label}</button>
          ))}
        </div>
      </div>

      <div role="group" aria-labelledby="dietary-label">
        <span id="dietary-label" className="label">飲食禁忌</span>
        <p className="mt-0.5 text-xs text-fg-muted">硬性排除：不符合的店不會出現在轉盤上</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {DIETARY_OPTIONS.map(([v, label]) => (
            <button key={v} type="button" aria-pressed={form.dietary.includes(v)}
              className={`chip ${form.dietary.includes(v)
                ? 'border-danger bg-danger text-white hover:bg-danger' : ''}`}
              onClick={() => save({ dietary: toggle(form.dietary, v) })}>{label}</button>
          ))}
        </div>
      </div>

      <label className="block space-y-1">
        <span className="flex items-baseline justify-between">
          <span className="label">可接受距離</span>
          <span className="font-mono text-sm font-semibold text-brand">{form.max_distance_m} 公尺</span>
        </span>
        <input type="range" min={300} max={3000} step={100} className="h-6 w-full"
          value={form.max_distance_m}
          onChange={e => save({ max_distance_m: +e.target.value })} />
      </label>

      <div role="group" aria-labelledby="transport-label">
        <span id="transport-label" className="label">交通方式</span>
        <div className="mt-2 flex gap-2">
          {TRANSPORTS.map(([v, label]) => (
            <button key={v} type="button" aria-pressed={form.transport === v}
              className={`chip flex-1 justify-center ${form.transport === v
                ? 'border-fg bg-fg text-white hover:bg-fg' : ''}`}
              onClick={() => save({ transport: v })}>{label}</button>
          ))}
        </div>
      </div>

      <button type="button" aria-pressed={form.ready}
        className={`btn w-full ${form.ready
          ? 'bg-ok text-white hover:bg-ok/90' : 'btn-quiet'}`}
        onClick={() => save({ ready: !form.ready })}>
        {form.ready && <Check className="h-5 w-5" />}
        {form.ready ? '已準備（點擊取消）' : '我準備好了'}
      </button>
    </div>
  )
}
