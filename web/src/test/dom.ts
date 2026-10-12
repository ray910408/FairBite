import { cleanup } from '@testing-library/react'
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

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
