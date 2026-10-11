import type { RoomSettingsWrites } from '../hooks/useRoomSettingsWrites'
import { EXPLORATION_OPTIONS } from '../lib/labels'
import { formatMealTime } from '../lib/mealTime'
import type { Room } from '../lib/types'

// 房內三組 segmented control：墨線框、選中反白（同首頁用餐時間）
const SEGMENTED = 'divide-x divide-rule rounded-btn border border-rule'
function segment(active: boolean) {
  return `min-h-11 text-sm font-semibold tracking-[0.1em] transition-colors duration-150 ${
    active ? 'bg-fg text-canvas' : 'text-fg enabled:hover:bg-brand-soft'}`
}

// lobby 的三張房間層設定卡：探索檔位、用餐時間、菜系過濾。只有房主能改，寫入走 useRoomSettingsWrites。
// 用餐時間草稿（editingCustom／draftHH／draftMM）是 RoomPage 的 state：寫入失敗時佇列要把它還原。
// 以函式呼叫（RoomSettings({...})）而非 <RoomSettings />：比照 LeaveConfirm，本元件沒有自己的狀態，
// RoomPage.test.ts 把頁面當純函式呼叫，要在回傳的元素樹裡讀到說明文字
export function RoomSettings({ room, isHost, searching, settings,
  editingCustom, setEditingCustom, draftHH, setDraftHH, draftMM, setDraftMM }: {
  room: Room
  isHost: boolean
  searching: boolean
  settings: RoomSettingsWrites
  editingCustom: boolean
  setEditingCustom: (editing: boolean) => void
  draftHH: string
  setDraftHH: (hh: string) => void
  draftMM: string
  setDraftMM: (mm: string) => void
}) {
  return (
    <>
      <section className="card animate-rise">
        <h2 className="mb-1 text-sm font-semibold text-fg-muted">探索檔位</h2>
        <p className="mb-3 text-xs text-fg-muted">
          {EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[2]}
          {!isHost && '（由房主設定）'}
        </p>
        {/* D14：冷啟動誠實說明 —— 檔位靠同席紀錄運作，沒紀錄前三檔等效 */}
        <p className="mb-3 text-xs text-fg-muted">
          檔位依成員的同席紀錄調整機率；大家開始用這裡抽餐廳後才會逐漸生效
        </p>
        <div className={`grid grid-cols-3 ${SEGMENTED}`}>
          {EXPLORATION_OPTIONS.map(([key, label]) => (
            <button key={key} type="button" aria-pressed={room.exploration === key}
              disabled={!isHost || searching}
              className={`${segment(room.exploration === key)} disabled:cursor-default`}
              onClick={() => settings.saveRoomSetting({ exploration: key }, '探索檔位更新失敗')}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="card animate-rise">
        <h2 className="mb-1 text-sm font-semibold text-fg-muted">用餐時間</h2>
        <p className="mb-3 text-xs text-fg-muted">
          {formatMealTime(room.meal_time)}
          {!isHost && '（由房主設定）'}
        </p>
        {isHost && (
          <div className="space-y-2">
            <div className={`grid grid-cols-2 ${SEGMENTED}`}>
              <button type="button" aria-pressed={room.meal_time === null && !editingCustom}
                disabled={searching}
                className={segment(room.meal_time === null && !editingCustom)}
                onClick={() => settings.saveMealTime(null)}>
                馬上出發
              </button>
              <button type="button" aria-pressed={room.meal_time !== null || editingCustom}
                disabled={searching}
                className={segment(room.meal_time !== null || editingCustom)}
                onClick={() => {
                  settings.cancelPendingMealTime()
                  setEditingCustom(true)
                }}>
                自訂時間
              </button>
            </div>
            {(editingCustom || room.meal_time !== null) && (
              <div className="flex items-center gap-2">
                <select className="field flex-1" aria-label="用餐時間（時）"
                  disabled={searching}
                  value={draftHH}
                  onChange={e => {
                    const hh = e.target.value
                    setDraftHH(hh)
                    if (hh && draftMM) void settings.updateMealTime(`${hh}:${draftMM}`)
                  }}>
                  <option value="" disabled>時</option>
                  {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')).map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span className="text-fg-muted">:</span>
                <select className="field flex-1" aria-label="用餐時間（分）"
                  disabled={searching}
                  value={draftMM}
                  onChange={e => {
                    const mm = e.target.value
                    setDraftMM(mm)
                    if (draftHH && mm) void settings.updateMealTime(`${draftHH}:${mm}`)
                  }}>
                  <option value="" disabled>分</option>
                  {Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0')).map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </section>
      <section className="card animate-rise">
        <h2 className="mb-1 text-sm font-semibold text-fg-muted">菜系過濾</h2>
        <p className="mb-3 text-xs text-fg-muted">
          開啟後只保留符合成員菜系偏好的店；大家都沒選菜系時不會作用
          {!isHost && '（由房主設定）'}
        </p>
        <div className={`grid grid-cols-2 ${SEGMENTED}`}>
          {([[false, '關閉'], [true, '開啟']] as const).map(([value, label]) => (
            <button key={label} type="button" aria-pressed={room.cuisine_filter === value}
              disabled={!isHost || searching}
              className={`${segment(room.cuisine_filter === value)} disabled:cursor-default`}
              onClick={() => settings.saveRoomSetting({ cuisine_filter: value }, '菜系過濾更新失敗')}>
              {label}
            </button>
          ))}
        </div>
      </section>
    </>
  )
}
