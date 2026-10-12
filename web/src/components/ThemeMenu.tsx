import { useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme'
import { Check, Monitor, Moon, Sun } from './icons'

const OPTIONS = [
  { pref: 'system', label: '跟隨系統', Icon: Monitor },
  { pref: 'light', label: '淺色', Icon: Sun },
  { pref: 'dark', label: '深色', Icon: Moon },
] as const

// 外觀選單：圖示鈕顯示目前的選擇，點開才列出三個選項（disclosure 樣式，選項沿用全站的 aria-pressed）
export function ThemeMenu() {
  const [pref, setPref] = useState<ThemePref>(getThemePref)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  // 點選單外面或按 Esc 收起；焦點在選單裡時 Esc 才把焦點還給圖示鈕，免得從別處（例如 dialog）被拉回來
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const current = OPTIONS.find(o => o.pref === pref)!
  return (
    // Tab 離開選單就收起，不讓展開的選單蓋在後面的內容上。relatedTarget 為 null 不收：
    // Safari 點按鈕不給焦點，點選項時 blur 的 relatedTarget 是 null，收起來點擊就落空；點外面交給 pointerdown
    <div ref={rootRef} className="relative"
      onBlur={e => { if (e.relatedTarget && !rootRef.current?.contains(e.relatedTarget)) setOpen(false) }}>
      <button ref={triggerRef} type="button" className="btn btn-quiet min-h-11 w-11 px-0"
        aria-label={`外觀：${current.label}`} aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(o => !o)}>
        <current.Icon className="h-4 w-4" />
      </button>
      {open && (
        <div id={panelId} className="card absolute top-full right-0 z-30 mt-1 w-36 p-1">
          {OPTIONS.map(({ pref: p, label, Icon }) => (
            <button key={p} type="button" aria-pressed={p === pref}
              className="flex min-h-11 w-full items-center gap-2 rounded-btn px-3 text-sm hover:bg-brand-soft"
              onClick={() => {
                // 整頁交叉淡化（View Transition），不支援的瀏覽器直接切換。flushSync：回呼結束時
                // DOM 就要是選單收起、勾勾換好的樣子，否則新快照還開著選單，淡化完才突然收起
                const apply = () => {
                  setThemePref(p)
                  flushSync(() => { setPref(p); setOpen(false) })
                }
                if ('startViewTransition' in document) document.startViewTransition(apply)
                else apply()
                triggerRef.current?.focus()
              }}>
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">{label}</span>
              {p === pref && <Check className="h-4 w-4 text-brand" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
