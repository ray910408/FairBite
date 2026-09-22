import { useEffect, useRef, useState } from 'react'
import { Chevron } from './icons'

const COLORS = ['#c2410c', '#0369a1', '#15803d', '#a16207', '#7e22ce', '#be123c']
const MAX_OPTIONS = 20
const MAX_LENGTH = 40
const SPIN_MS = 3200

export default function CustomWheel() {
  const [options, setOptions] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [spinning, setSpinning] = useState(false)
  const [rotation, setRotation] = useState(0)
  const [winner, setWinner] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  function changeOptions(next: string[]) {
    setOptions(next)
    setWinner(null)
    setRotation(0)
    setError('')
  }

  function addOption(e: React.FormEvent) {
    e.preventDefault()
    if (spinning) return
    const label = draft.trim()
    if (!label) return setError('請輸入選項名稱')
    if (label.length > MAX_LENGTH) return setError(`每個選項最多 ${MAX_LENGTH} 字`)
    if (options.includes(label)) return setError('這個選項已經在轉盤上了')
    if (options.length >= MAX_OPTIONS) return setError(`最多加入 ${MAX_OPTIONS} 個選項`)
    changeOptions([...options, label])
    setDraft('')
    input.current?.focus()
  }

  function spin() {
    if (timer.current !== null || spinning || options.length < 2) return
    const index = Math.floor(Math.random() * options.length)
    const target = 360 - (index + 0.5) * 360 / options.length
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    setWinner(null)
    setRotation(current => current + 5 * 360 + (target - current % 360 + 360) % 360)
    if (reduced) {
      setWinner(options[index])
      return
    }
    setSpinning(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setSpinning(false)
      setWinner(options[index])
    }, SPIN_MS + 100)
  }

  const background = options.length
    ? `conic-gradient(${options.map((_, i) =>
      `${COLORS[i % COLORS.length]} ${i * 100 / options.length}% ${(i + 1) * 100 / options.length}%`
    ).join(', ')})`
    : undefined

  return (
    <details className="card animate-rise">
      <summary className="flex min-h-11 list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block text-base font-semibold">自製轉盤</span>
          <span className="block text-sm text-fg-muted">自己填選項，轉一下決定</span>
        </span>
        <Chevron className="disclosure-chevron h-5 w-5 shrink-0" />
      </summary>
      <section aria-label="自製轉盤" className="mt-4 space-y-4">
        <p id="custom-wheel-help" className="text-sm text-fg-muted">
          加入 2–20 個選項，每個機率相同。選項僅供本次使用，重新整理即清空。
        </p>
        <form onSubmit={addOption} className="space-y-2">
          <label htmlFor="custom-wheel-option" className="label">選項名稱</label>
          <div className="flex gap-2">
            <input id="custom-wheel-option" ref={input} className="field min-w-0 flex-1"
              value={draft} maxLength={MAX_LENGTH} placeholder="例如：火鍋、看電影（逐個加入）"
              autoComplete="off" disabled={spinning || options.length >= MAX_OPTIONS}
              aria-describedby={`custom-wheel-help${error ? ' custom-wheel-error' : ''}`}
              aria-invalid={!!error}
              onChange={e => { setDraft(e.target.value); setError('') }} />
            <button type="submit" className="btn btn-quiet shrink-0"
              disabled={spinning || options.length >= MAX_OPTIONS}>新增</button>
          </div>
          {error && <p id="custom-wheel-error" role="alert" className="text-sm text-danger">{error}</p>}
        </form>

        <div className="relative mx-auto w-64 max-w-full pt-2" aria-hidden="true">
          <svg viewBox="0 0 24 20" className="absolute top-0 left-1/2 z-10 h-5 w-6 -translate-x-1/2 drop-shadow-sm">
            <path d="M12 20 1 0h22z" className="fill-fg" />
          </svg>
          <div data-testid="custom-wheel-disc"
            className="relative aspect-square rounded-full bg-brand-soft shadow-card ring-4 ring-surface"
            style={{ background, transform: `rotate(${rotation}deg)`,
              transition: spinning ? `transform ${SPIN_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none' }}>
            {options.map((label, i) => {
              const angle = (i + 0.5) * 2 * Math.PI / options.length
              return (
                <span key={label} className="absolute flex h-6 w-6 items-center justify-center text-sm font-bold text-white"
                  style={{ left: `${50 + 38 * Math.sin(angle)}%`, top: `${50 - 38 * Math.cos(angle)}%`,
                    transform: 'translate(-50%, -50%)' }}>{i + 1}</span>
              )
            })}
            <span className="absolute top-1/2 left-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface shadow-sm" />
          </div>
        </div>

        {options.length > 0 && (
          <ol aria-label="轉盤選項" className="max-h-64 space-y-1 overflow-y-auto">
            {options.map((label, i) => (
              <li key={label} className="flex items-center gap-2 rounded-lg px-2"
                style={{ background: winner === label ? 'var(--color-brand-soft)' : undefined }}>
                <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                  style={{ background: COLORS[i % COLORS.length] }}>{i + 1}</span>
                <span className="min-w-0 flex-1 wrap-anywhere text-sm">{label}</span>
                <button type="button" className="btn btn-quiet shrink-0 px-3 text-sm"
                  aria-label={`刪除 ${label}`} disabled={spinning}
                  onClick={() => { changeOptions(options.filter(option => option !== label)); input.current?.focus() }}>刪除</button>
              </li>
            ))}
          </ol>
        )}
        <button type="button" className="btn btn-primary w-full" onClick={spin}
          disabled={spinning || options.length < 2}>
          {spinning ? '轉動中…' : winner ? '再轉一次' : '開始轉盤'}
        </button>
        <p role="status" aria-live="polite" aria-atomic="true" className="text-center text-sm wrap-anywhere">
          {spinning ? '轉盤抽選中…' : winner ? <>抽中：<strong>{winner}</strong></>
            : options.length < 2 ? `再加入 ${2 - options.length} 個選項就能開始` : `共 ${options.length} 個選項，每個機率 1/${options.length}`}
        </p>
      </section>
    </details>
  )
}
