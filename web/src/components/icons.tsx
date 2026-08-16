// 專案只需要幾個圖示，直接手寫 SVG（見 currentColor），不額外拉 icon 套件
type P = { className?: string }

const base = 'h-5 w-5 shrink-0'

export function Logo({ className = 'h-9 w-9' }: P) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" className="fill-brand" />
      <path d="M6 15h20a10 10 0 0 1-20 0Z" fill="#fff" />
      <rect x="4" y="24.5" width="24" height="3" rx="1.5" fill="#fff" opacity=".85" />
      <circle cx="16" cy="8" r="2.5" className="fill-brand-soft" />
    </svg>
  )
}

export function Check({ className = base }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  )
}

export function Users({ className = base }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

export function MapPin({ className = base }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  )
}

export function Chevron({ className = base }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function Alert({ className = base }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  )
}

export function Copy({ className = base }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

export function LogOut({ className = base }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  )
}

export function Spinner({ className = 'h-6 w-6' }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"
      className={`${className} animate-spin motion-reduce:animate-none`}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity=".2" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

// filled=false 改畫描邊（空心）；預設 true，既有呼叫端輸出的屬性一字不變
const starOutline = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' } as const

export const Star = ({ className = '', filled = true }: { className?: string; filled?: boolean }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
    {...(filled ? {} : starOutline)}>
    <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5L2.6 9.3l6.5-.9L12 2.5z" />
  </svg>
)
