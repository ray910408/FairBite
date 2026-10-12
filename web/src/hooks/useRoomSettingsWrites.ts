import { useEffect, useRef } from 'react'
import { buildMealTimeISO } from '../lib/mealTime'
import { supabase } from '../lib/supabase'
import type { Room } from '../lib/types'

type RoomSettingPatch = Partial<Pick<Room, 'exploration' | 'meal_time' | 'cuisine_filter'>>

export type RoomSettingsWrites = ReturnType<typeof useRoomSettingsWrites>

// 房主在 lobby 改的房間層設定（探索檔位／用餐時間／菜系過濾）的寫入佇列：全部排進同一條
// chain 依序寫入、用餐時間 debounce 400ms，任一欄位寫入失敗就關住搜尋閘門，直到該欄位重試成功。
// 錯誤訊息、閘門與用餐時間草稿都是 RoomPage 的 state，由呼叫端傳 setter 進來，本 hook 只開 ref。
// 這原本是為了依呼叫順序 mock useState 的舊 RoomPage 測試（hook 多開一個 state 就擠動索引）；那支測試已改成
// 行為導向，這個限制已經沒有理由，閘門與草稿可以收進本 hook（錯誤訊息是頁首各動作共用的橫幅，仍留在頁面）。
export function useRoomSettingsWrites(room: Room | null, { setActionError, setRoomSettingsBlocked, showMealTime }: {
  setActionError: (message: string) => void
  setRoomSettingsBlocked: (blocked: boolean) => void
  // 用餐時間寫入失敗時還原成已落庫的值；清成「馬上出發」寫入成功時以 null 呼叫
  showMealTime: (iso: string | null) => void
}) {
  const mealTimeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingMealTime = useRef<{ generation: number; iso: string | null } | null>(null)
  const roomWriteChain = useRef(Promise.resolve())
  const roomWriteGeneration = useRef(0)
  const roomWriteQueued = useRef(0)
  const roomWriteFailures = useRef(new Set<keyof RoomSettingPatch>())
  const roomWritesValid = useRef(true)
  const mealTimeGeneration = useRef(0)
  const durableMealTimeGeneration = useRef(0)
  const durableMealTime = useRef<string | null>(room?.meal_time ?? null)
  useEffect(() => {
    durableMealTime.current = room?.meal_time ?? null
  }, [room?.id, room?.meal_time])

  function updateRoomSettingsGate() {
    setRoomSettingsBlocked(roomWriteQueued.current > 0 || pendingMealTime.current !== null || !roomWritesValid.current)
  }

  function enqueueRoomWrite(generation: number, patch: RoomSettingPatch,
    errorMessage: string, onLatestFailure?: () => void) {
    roomWriteQueued.current++
    updateRoomSettingsGate()
    const operation = roomWriteChain.current.then(async () => {
      let failed = false
      try {
        const { error, count } = await supabase.from('rooms')
          .update(patch, { count: 'exact' }).eq('id', room!.id)
        failed = !!error || count === 0
      } catch {
        failed = true
      }
      const fields = Object.keys(patch) as Array<keyof typeof patch>
      if (failed) {
        for (const field of fields) roomWriteFailures.current.add(field)
        roomWritesValid.current = false
        onLatestFailure?.()
        setActionError(errorMessage)
      } else {
        if ('meal_time' in patch && generation > durableMealTimeGeneration.current) {
          durableMealTimeGeneration.current = generation
          durableMealTime.current = patch.meal_time ?? null
          if (patch.meal_time === null) showMealTime(null)
        }
        for (const field of fields) roomWriteFailures.current.delete(field)
        roomWritesValid.current = roomWriteFailures.current.size === 0
        if (roomWritesValid.current) {
          setActionError('')
        }
      }
      return !failed
    })
    const settled = operation.then(result => {
      roomWriteQueued.current--
      updateRoomSettingsGate()
      return result
    })
    roomWriteChain.current = settled.then(() => undefined)
    return settled
  }

  function enqueuePendingMealTime() {
    clearTimeout(mealTimeTimer.current)
    mealTimeTimer.current = undefined
    const pending = pendingMealTime.current
    if (!pending) return roomWriteChain.current
    pendingMealTime.current = null
    return enqueueRoomWrite(pending.generation, { meal_time: pending.iso }, '用餐時間更新失敗', () => {
      if (pending.generation === mealTimeGeneration.current) showMealTime(durableMealTime.current)
    })
  }

  function saveRoomSetting(patch: Partial<Pick<Room, 'exploration' | 'cuisine_filter'>>, errorMessage: string) {
    void enqueuePendingMealTime()
    const generation = ++roomWriteGeneration.current
    setActionError('')
    return enqueueRoomWrite(generation, patch, errorMessage)
  }

  async function flushRoomWrites() {
    enqueuePendingMealTime()
    await roomWriteChain.current
    return roomWritesValid.current && roomWriteQueued.current === 0 && pendingMealTime.current === null
  }

  function cancelPendingMealTime() {
    clearTimeout(mealTimeTimer.current)
    mealTimeTimer.current = undefined
    pendingMealTime.current = null
    updateRoomSettingsGate()
  }

  function saveMealTime(iso: string | null) {
    setActionError('')
    cancelPendingMealTime()
    const generation = ++roomWriteGeneration.current
    mealTimeGeneration.current = generation
    pendingMealTime.current = { generation, iso }
    updateRoomSettingsGate()
    mealTimeTimer.current = setTimeout(() => {
      void enqueuePendingMealTime()
    }, 400)
  }

  function updateMealTime(hhmm: string) {
    setActionError('')
    const r = buildMealTimeISO(hhmm)
    if ('error' in r) { setActionError(r.error); return }
    saveMealTime(r.iso)
  }

  return { saveRoomSetting, saveMealTime, updateMealTime, cancelPendingMealTime, flushRoomWrites }
}
