import { useEffect, useMemo, useRef, useState } from 'react'
import type { CandidateRow } from '../lib/types'
import { formatPercent, sortKept } from '../lib/probability'

const COLORS = ['#f97316', '#0ea5e9', '#22c55e', '#eab308', '#a855f7',
  '#ef4444', '#14b8a6', '#f43f5e', '#8b5cf6', '#84cc16', '#06b6d4', '#d946ef']

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const rad = (a: number) => ((a - 90) * Math.PI) / 180
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0))
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1))
  const large = a1 - a0 > 180 ? 1 : 0
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
    const t = setTimeout(() => doneRef.current(), 4200)
    return () => clearTimeout(t)
  }, [winnerId]) // slices/onDone 走 ref：realtime refetch 不會重設 4 秒計時器

  return (
    <div className="relative mx-auto w-72">
      <div className="absolute -top-1 left-1/2 z-10 -translate-x-1/2 text-2xl">▼</div>
      <svg viewBox="0 0 200 200"
        style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 4s cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
        {slices.map(s => (
          <path key={s.c.restaurant_id} d={arcPath(100, 100, 98, s.start, s.end)}
            fill={s.color} stroke="white" strokeWidth="1" />
        ))}
      </svg>
      <ul className="mt-3 space-y-1 text-sm">
        {slices.map(s => (
          <li key={s.c.restaurant_id} className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: s.color }} />
            <span className="flex-1">{s.c.restaurants.name}</span>
            <span className="font-mono">{formatPercent(s.c.probability ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
