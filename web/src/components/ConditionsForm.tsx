import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { MemberRow } from '../lib/types'
import { CUISINE_OPTIONS, DIETARY_OPTIONS, TRANSPORT_LABELS } from '../lib/labels'

const TRANSPORTS = Object.entries(TRANSPORT_LABELS) as [MemberRow['transport'], string][]

export default function ConditionsForm({ me }: { me: MemberRow }) {
  const [form, setForm] = useState(me)
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
        alert('儲存失敗：房間可能已開始選餐，條件已凍結')
      } else {
        savedRef.current = next
      }
    }, 400)
  }

  function toggle(list: string[], v: string) {
    return list.includes(v) ? list.filter(x => x !== v) : [...list, v]
  }

  return (
    <div className="space-y-4 rounded border p-4">
      <label className="block">
        <span className="text-sm text-gray-600">每人預算上限 NT${form.budget_max}</span>
        <input type="range" min={100} max={1600} step={100} className="w-full"
          value={form.budget_max}
          onChange={e => save({ budget_max: +e.target.value })} />
      </label>
      <div>
        <span className="text-sm text-gray-600">料理偏好</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {CUISINE_OPTIONS.map(([v, label]) => (
            <button key={v} type="button" aria-pressed={form.cuisines.includes(v)}
              className={`rounded-full border px-3 py-1 text-sm ${form.cuisines.includes(v) ? 'bg-orange-500 text-white' : ''}`}
              onClick={() => save({ cuisines: toggle(form.cuisines, v) })}>{label}</button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-sm text-gray-600">飲食禁忌</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {DIETARY_OPTIONS.map(([v, label]) => (
            <button key={v} type="button" aria-pressed={form.dietary.includes(v)}
              className={`rounded-full border px-3 py-1 text-sm ${form.dietary.includes(v) ? 'bg-red-500 text-white' : ''}`}
              onClick={() => save({ dietary: toggle(form.dietary, v) })}>{label}</button>
          ))}
        </div>
      </div>
      <label className="block">
        <span className="text-sm text-gray-600">可接受距離 {form.max_distance_m} 公尺</span>
        <input type="range" min={300} max={3000} step={100} className="w-full"
          value={form.max_distance_m}
          onChange={e => save({ max_distance_m: +e.target.value })} />
      </label>
      <div className="flex gap-2">
        {TRANSPORTS.map(([v, label]) => (
          <button key={v} type="button" aria-pressed={form.transport === v}
            className={`rounded border px-3 py-1 text-sm ${form.transport === v ? 'bg-gray-800 text-white' : ''}`}
            onClick={() => save({ transport: v })}>{label}</button>
        ))}
      </div>
      <button type="button" aria-pressed={form.ready}
        className={`w-full rounded p-2 text-white ${form.ready ? 'bg-green-600' : 'bg-gray-400'}`}
        onClick={() => save({ ready: !form.ready })}>
        {form.ready ? '已準備 ✓（點擊取消）' : '我準備好了'}
      </button>
    </div>
  )
}

