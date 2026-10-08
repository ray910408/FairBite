import { useEffect, useMemo, useRef, useState } from 'react'
import type { CandidateRow } from '../lib/types'
import { formatPercents, sortKept } from '../lib/probability'
import { wheelFill } from '../lib/wheelPalette'

const SPIN_MS = 4000

// 減少動態偏好：不轉滿 4 秒，直接定位並縮短等待
const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const rad = (a: number) => ((a - 90) * Math.PI) / 180
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0))
  const a1c = Math.min(a1, a0 + 359.99) // 360° 時端點重合，SVG 會略去弧線 → 留 0.01° 缺口
  const x1 = cx + r * Math.cos(rad(a1c)), y1 = cy + r * Math.sin(rad(a1c))
  const large = a1c - a0 > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`
}

export default function Wheel({ rows, winnerId, onDone }: {
  rows: CandidateRow[]
  winnerId: string | null
  onDone: () => void
}) {
  const kept = useMemo(() => sortKept(rows), [rows])
  const slices = useMemo(() => {
    let acc = 0
    return kept.map((c, i) => {
      const start = acc
      acc += (c.probability ?? 0) * 360
      return { c, start, end: acc, color: wheelFill(i, kept.length) }
    })
  }, [kept])
  const percents = useMemo(() => formatPercents(kept.map(c => c.probability ?? 0)), [kept])

  const [rotation, setRotation] = useState(0)
  const slicesRef = useRef(slices)
  slicesRef.current = slices
  const winnerPresent = slices.some(x => x.c.restaurant_id === winnerId)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    if (!winnerId) return
    const s = slicesRef.current.find(x => x.c.restaurant_id === winnerId)
    if (!s) return
    if (slicesRef.current.some(x => x.c.probability == null)) {
      doneRef.current()
      return
    }
    const center = (s.start + s.end) / 2
    setRotation(5 * 360 + (360 - center)) // 指針固定在 12 點鐘，轉輪本體旋轉
    const t = setTimeout(() => doneRef.current(), prefersReduced() ? 700 : SPIN_MS + 200)
    return () => clearTimeout(t)
  }, [winnerId, winnerPresent]) // 候選補回 winner 時重試；一般 realtime refetch 不重設計時器

  if (kept.some(c => c.probability == null)) {
    return <p role="status">歷史機率已隱藏，以保護成員隱私</p>
  }

  return (
    <div className="card animate-rise space-y-4">
      <p className="text-center font-serif text-sm tracking-[0.3em] text-fg-muted" role="status">轉盤抽選中…</p>
      <div className="relative mx-auto w-56 max-w-full">
        <div className="absolute -top-2 left-1/2 z-10 -translate-x-1/2">
          <svg viewBox="0 0 24 20" aria-hidden="true" className="h-[18px] w-[22px]">
            <path d="M12 20 1 0h22z" className="fill-fg" />
          </svg>
        </div>
        {/* 印刷菜單的雙圈：墨線、留白、墨線 */}
        <svg viewBox="0 0 200 200" aria-hidden="true" className="block rounded-full"
          style={{
            boxShadow: '0 0 0 1px var(--color-rule), 0 0 0 5px var(--color-surface), 0 0 0 6px var(--color-rule)',
            transform: `rotate(${rotation}deg)`,
            transition: `transform ${prefersReduced() ? 0 : SPIN_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
          }}>
          {slices.map(s => (
            <path key={s.c.restaurant_id} d={arcPath(100, 100, 98, s.start, s.end)}
              style={{ fill: s.color, stroke: 'var(--color-surface)' }} strokeWidth="1.5" />
          ))}
          <circle cx="100" cy="100" r="16" strokeWidth="1" className="fill-surface stroke-rule" />
          <circle cx="100" cy="100" r="4" className="fill-brand" />
        </svg>
      </div>
      <ul className="space-y-1.5 text-sm">
        {slices.map((s, i) => (
          <li key={s.c.restaurant_id} className="flex min-w-0 items-baseline gap-1.5">
            <span aria-hidden="true" className="inline-block size-2.5 shrink-0"
              style={{ background: s.color }} />
            <span className="truncate font-serif">{s.c.restaurants.name}</span>
            <span aria-hidden="true" className="leader" />
            <span className="font-serif font-bold">{percents[i]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
