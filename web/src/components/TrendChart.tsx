// 評分走勢（足跡 spec §5.2）：最近 30 筆實評、時間正序、y 軸 ★1–5 可判讀絕對值
//（★5／★1 標籤＋基準線，outside voice #5）。手刻 SVG（不加 chart 依賴）；
// 無 hover/tooltip——行動端無意義，細節都在清單。幾何抽純函式供測試；元件是薄 SVG 殼。
const W = 320
const H = 120
const PAD = 16 // 左側 ★5／★1 標籤需要的空間

export function trendPoints(ratings: number[], w = W, h = H, pad = PAD): { x: number; y: number }[] {
  if (ratings.length < 2) return []
  const step = (w - pad * 2) / (ratings.length - 1)
  const unit = (h - pad * 2) / 4 // ★1–★5 共 4 格
  return ratings.map((r, i) => ({ x: pad + i * step, y: pad + (5 - r) * unit }))
}

export default function TrendChart({ ratings }: { ratings: number[] }) {
  const pts = trendPoints(ratings)
  if (pts.length === 0) return null
  // 報讀摘要（design review D7）：只報筆數的話，圖對非視覺使用者是零資訊裝飾。
  // 摘要式（最早/最新/最高/最低）優於逐值列舉——30 筆逐值報讀太長。
  const first = ratings[0]
  const last = ratings[ratings.length - 1]
  const hi = Math.max(...ratings)
  const lo = Math.min(...ratings)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-brand" role="img"
      aria-label={`最近 ${ratings.length} 筆評分走勢：最早 ${first} 星、最新 ${last} 星、最高 ${hi}、最低 ${lo}`}>
      {[5, 1].map(star => {
        const y = PAD + (5 - star) * ((H - PAD * 2) / 4)
        return (
          <g key={star} className="text-fg-muted">
            <line x1={PAD} x2={W - PAD} y1={y} y2={y}
              stroke="currentColor" strokeWidth="0.5" opacity="0.4" />
            <text x={PAD - 3} y={y + 3} textAnchor="end" fontSize="9" fill="currentColor">
              ★{star}
            </text>
          </g>
        )
      })}
      <polyline points={pts.map(p => `${p.x},${p.y}`).join(' ')}
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="currentColor" />
      ))}
    </svg>
  )
}
