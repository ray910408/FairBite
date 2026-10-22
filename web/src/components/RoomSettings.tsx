import type { RoomSettingsWrites } from '../hooks/useRoomSettingsWrites'
import { EXPLORATION_OPTIONS } from '../lib/labels'
import { formatMealTime } from '../lib/mealTime'
import type { Room } from '../lib/types'

// 房內三組 segmented control：墨線框、選中反白
const SEGMENTED = 'divide-x divide-rule rounded-btn border border-rule'
function segment(active: boolean) {
  return `min-h-11 text-sm font-semibold tracking-[0.1em] transition-colors duration-150 ${
    active ? 'bg-fg text-canvas' : 'text-fg enabled:hover:bg-brand-soft'}`
}

// lobby 的房間層設定：用餐時間、探索檔位、菜系過濾，只有房主能改，寫入走 useRoomSettingsWrites。
// 房主每項各一張卡，由 RoomPage 排順序（邀請→用餐時間→探索檔位→地點→我的條件→菜系過濾）；非房主只看摘要卡。
type SettingProps = { room: Room; searching: boolean; settings: RoomSettingsWrites }

// 非房主改不了這三項：收成一張摘要卡，自己的條件表單才不會被擠到三張停用的設定卡下面
export function RoomSettingsSummary({ room }: { room: Room }) {
  return (
    <section className="card animate-rise space-y-1">
      <h2 className="text-sm font-semibold text-fg-muted">房主的設定</h2>
      {/* 每項整段不折行：320px 時寧可換到下一行，也不要把「菜系過濾」拆成兩半 */}
      <p className="text-sm">
        <span className="whitespace-nowrap">用餐時間：{formatMealTime(room.meal_time)}</span>
        ・<span className="whitespace-nowrap">探索檔位：{EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[1]}</span>
        ・<span className="whitespace-nowrap">菜系過濾：{room.cuisine_filter ? '開啟' : '關閉'}</span>
      </p>
      <p className="text-xs text-fg-muted">{EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[2]}</p>
      {/* D14：同房主卡片的冷啟動誠實說明 */}
      <p className="text-xs text-fg-muted">檔位依成員的同席紀錄調整機率；大家開始用這裡抽餐廳後才會逐漸生效</p>
      {/* 開啟時你的料理偏好直接決定哪些店留下，要讓成員知道後果 */}
      {room.cuisine_filter && (
        <p className="text-xs text-fg-muted">菜系過濾：只保留符合成員菜系偏好的店；大家都沒選菜系時不會作用</p>
      )}
    </section>
  )
}

// 用餐時間草稿（editingCustom／draftHH／draftMM）是 RoomPage 的 state：寫入失敗時佇列要把它還原
export function MealTimeSetting({ room, searching, settings,
  editingCustom, setEditingCustom, draftHH, setDraftHH, draftMM, setDraftMM }: SettingProps & {
  editingCustom: boolean
  setEditingCustom: (editing: boolean) => void
  draftHH: string
  setDraftHH: (hh: string) => void
  draftMM: string
  setDraftMM: (mm: string) => void
}) {
  return (
    <section className="card animate-rise">
      <h2 className="mb-1 text-sm font-semibold text-fg-muted">用餐時間</h2>
      <p className="mb-3 text-xs text-fg-muted">
        {formatMealTime(room.meal_time)}
      </p>
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
    </section>
  )
}

export function ExplorationSetting({ room, searching, settings }: SettingProps) {
  return (
    <section className="card animate-rise">
      <h2 className="mb-1 text-sm font-semibold text-fg-muted">探索檔位</h2>
      <p className="mb-3 text-xs text-fg-muted">
        {EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[2]}
      </p>
      {/* D14：冷啟動誠實說明 —— 檔位靠同席紀錄運作，沒紀錄前三檔等效 */}
      <p className="mb-3 text-xs text-fg-muted">
        檔位依成員的同席紀錄調整機率；大家開始用這裡抽餐廳後才會逐漸生效
      </p>
      <div className={`grid grid-cols-3 ${SEGMENTED}`}>
        {EXPLORATION_OPTIONS.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={room.exploration === key}
            disabled={searching}
            className={segment(room.exploration === key)}
            onClick={() => settings.saveRoomSetting({ exploration: key }, '探索檔位更新失敗')}>
            {label}
          </button>
        ))}
      </div>
    </section>
  )
}

export function CuisineFilterSetting({ room, searching, settings }: SettingProps) {
  return (
    <section className="card animate-rise">
      <h2 className="mb-1 text-sm font-semibold text-fg-muted">菜系過濾</h2>
      <p className="mb-3 text-xs text-fg-muted">
        開啟後只保留符合成員菜系偏好的店；大家都沒選菜系時不會作用
      </p>
      <div className={`grid grid-cols-2 ${SEGMENTED}`}>
        {([[false, '關閉'], [true, '開啟']] as const).map(([value, label]) => (
          <button key={label} type="button" aria-pressed={room.cuisine_filter === value}
            disabled={searching}
            className={segment(room.cuisine_filter === value)}
            onClick={() => settings.saveRoomSetting({ cuisine_filter: value }, '菜系過濾更新失敗')}>
            {label}
          </button>
        ))}
      </div>
    </section>
  )
}
