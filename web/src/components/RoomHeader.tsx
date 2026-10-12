import type { MouseEvent, Ref } from 'react'
import { Link } from 'react-router-dom'
import { ROOM_STATUS_LABEL } from '../lib/labels'
import type { Room } from '../lib/types'
import { Check, Copy, Logo } from './icons'

const STEPS = [
  { key: 'lobby', label: '設定條件', numeral: '壹' },
  { key: 'candidates', label: '候選出爐', numeral: '貳' },
  { key: 'voting', label: '投票', numeral: '參' },
  { key: 'pending', label: '待確認', numeral: '肆' },
  { key: 'decided', label: '定案', numeral: '伍' },
] as const

function Stepper({ status }: { status: Room['status'] }) {
  // relocating／shortlisting 不是獨立步驟：借用投票／候選出爐那格並改標籤
  const current = STEPS.findIndex(s => s.key === (
    status === 'relocating' ? 'voting' : status === 'shortlisting' ? 'candidates' : status))
  // 320px 寬：五格不畫連接線、靠 justify-between 撐開，字距縮到 gap-0.5 才放得下
  return (
    <ol className="flex items-center justify-between gap-1 text-xs">
      {STEPS.map((s, i) => (
        <li key={s.key} aria-current={i === current ? 'step' : undefined}
          className="flex items-center gap-0.5 whitespace-nowrap">
          {i < current ? <Check className="h-3.5 w-3.5 shrink-0 text-ok" />
            : <span aria-hidden="true" className={`font-serif ${i === current ? 'font-black text-brand' : 'text-fg-muted'}`}>
              {s.numeral}
            </span>}
          <span className={i === current ? 'font-bold text-brand underline decoration-2 underline-offset-[5px]'
            : 'text-fg-muted'}>
            {s.key === 'voting' && status === 'relocating' ? '換地點'
              : s.key === 'candidates' && status === 'shortlisting' ? '初選' : s.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

// 房間頁頂部：回首頁（＝離席）、邀請碼、足跡、狀態印章與步驟列。
// 以函式呼叫（RoomHeader({...})）而非 <RoomHeader />：比照 LeaveConfirm，本元件沒有自己的狀態，
// RoomPage.test.ts 把頁面當純函式呼叫，要在回傳的元素樹裡直接摸到「回首頁」連結
export function RoomHeader({ room, copied, onCopy, leaveChecking, onLeave, leaveTriggerRef }: {
  room: Room
  copied: boolean
  onCopy: () => void
  leaveChecking: boolean
  onLeave: (e: MouseEvent<HTMLAnchorElement>) => void
  leaveTriggerRef: Ref<HTMLAnchorElement>
}) {
  return (
    <header className="sticky top-0 z-20 bg-canvas/85 backdrop-blur">
      {/* 320px 放不下最長的印章（等待選新地點）時讓印章換行，不撐出水平捲動 */}
      <div className="mx-auto flex w-full max-w-lg flex-wrap items-center gap-x-2 gap-y-1 p-3 pb-2 sm:gap-x-3">
        {/* 回首頁＝離席（ADR-0007），代價不可逆——攔下導覽先查再確認 */}
        <Link to="/" aria-label="回首頁" ref={leaveTriggerRef}
          aria-busy={leaveChecking} onClick={onLeave}
          className="-ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
          <Logo className="h-8 w-8" />
        </Link>
        {/* 12 碼在 320px 塞不下 text-lg + 0.25em 字距，小螢幕縮小、sm 以上維持原樣。
            複製的是邀請連結而非 12 碼：只有 /join/:code 連結能讓訪客不註冊直接入房 */}
        <button onClick={onCopy} title="複製邀請連結" aria-label={`邀請碼 ${room.code}，點一下複製加入連結`}
          className="btn btn-quiet min-h-11 gap-1.5 px-1.5 font-mono text-sm sm:gap-2 sm:px-3 sm:text-lg sm:tracking-[0.25em]">
          {room.code}
          {copied ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4 text-fg-muted" />}
        </button>
        <span className="sr-only" aria-live="polite">{copied ? '邀請連結已複製' : ''}</span>
        <Link to="/history" className="btn btn-quiet min-h-11 px-1.5 text-xs sm:px-2 sm:text-sm">足跡</Link>
        <span className="seal ml-auto text-xs min-[375px]:text-sm">
          {ROOM_STATUS_LABEL[room.status]}
        </span>
      </div>
      <div className="mx-auto w-full max-w-lg px-3">
        <Stepper status={room.status} />
        <div className="double-rule mt-3" />
      </div>
    </header>
  )
}
