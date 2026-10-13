import { createElement } from 'react'
import { act, cleanup } from '@testing-library/react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { afterEach, beforeEach, vi } from 'vitest'

// jsdom 行為測試的共用設定：測試檔頭寫 `// @vitest-environment jsdom` 再 import 本檔。
// 全域 environment 仍是 node，其他測試不受影響。
// vitest 沒開 globals，testing-library 不會自動在每個測試後卸載畫面，這裡補上；
// jsdom 共用同一份 localStorage，每個測試後清空，記下的階段、轉盤紀錄才不會帶到下一個測試。

// jsdom 沒有實作、頁面會呼叫的瀏覽器 API
Element.prototype.scrollIntoView ??= function scrollIntoView() {}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// 測試要控制 rAF 的時機（關閉 dialog 後的焦點還原、換階段的聚焦都排在下一幀）：
// 先攔下來，flush() 才執行
export function captureFrames() {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  return {
    get pending() { return frames.length },
    flush() { frames.splice(0).forEach(cb => cb(performance.now())) },
  }
}

// 讓已經 resolve 的 mock promise（帳號、查詢、寫入）在 act 裡落地：等一個真的 macrotask。
// setTimeout 被 fake timers 接管的檔案（RoomPage、ConditionsForm）用自己推進時鐘的版本
export async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

// 導頁後落在這裡：路徑加上 push／replace；data-key 每次導航都換，看得出有沒有被導航第二次
export function Landing() {
  const { pathname, key } = useLocation()
  return createElement('p', { 'data-key': key }, `到了 ${pathname}（${useNavigationType()}）`)
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
