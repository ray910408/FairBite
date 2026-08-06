import { useEffect, useMemo, useRef, useState } from 'react'
import type { CandidateRow } from '../lib/types'
import { formatPercents, sortKept } from '../lib/probability'

const COLORS = ['#c2410c', '#0369a1', '#15803d', '#a16207', '#7e22ce',
  '#be123c', '#0f766e', '#b91c1c', '#6d28d9', '#4d7c0f', '#0e7490', '#a21caf']

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
      return { c, start, end: acc, color: COLORS[i % COLORS.length] }
    })
  }, [kept])
  const percents = useMemo(() => formatPercents(kept.map(c => c.probability ?? 0)), [kept])

  const [rotation, setRotation] = useState(0)
  const slicesRef = useRef(slices)
  slicesRef.current = slices
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  useEffect(() => {
    if (!winnerId) return
    const s = slicesRef.current.find(x => x.c.restaurant_id === winnerId)
    if (!s) return
    const center = (s.start + s.end) / 2
    setRotation(5 * 360 + (360 - center)) // 指針固定在 12 點鐘，轉輪本體旋轉
    const t = setTimeout(() => doneRef.current(), prefersReduced() ? 700 : SPIN_MS + 200)
    return () => clearTimeout(t)
  }, [winnerId]) // slices/onDone 走 ref：realtime refetch 不會重設計時器

  return (
    <div className="card animate-rise space-y-4">
      <p className="text-center text-sm text-fg-muted" role="status">轉盤抽選中…</p>
      <div className="relative mx-auto w-64 max-w-full">
        <div className="absolute -top-2 left-1/2 z-10 -translate-x-1/2">
          <svg viewBox="0 0 24 20" aria-hidden="true" className="h-5 w-6 drop-shadow-sm">
            <path d="M12 20 1 0h22z" className="fill-fg" />
          </svg>
        </div>
        <svg viewBox="0 0 200 200" aria-hidden="true"
          className="rounded-full shadow-card ring-4 ring-surface"
          style={{
            transform: `rotate(${rotation}deg)`,
            transition: `transform ${prefersReduced() ? 0 : SPIN_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
          }}>
          {slices.map(s => (
            <path key={s.c.restaurant_id} d={arcPath(100, 100, 98, s.start, s.end)}
              fill={s.color} stroke="white" strokeWidth="1.5" />
          ))}
          <circle cx="100" cy="100" r="14" fill="white" />
        </svg>
      </div>
      <ul className="space-y-1.5 text-sm">
        {slices.map((s, i) => (
          <li key={s.c.restaurant_id} className="flex items-center gap-2">
            <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-sm"
              style={{ background: s.color }} />
            <span className="flex-1 truncate">{s.c.restaurants.name}</span>
            <span className="font-mono text-fg-muted">{percents[i]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
