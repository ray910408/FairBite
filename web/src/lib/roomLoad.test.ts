import { describe, expect, it } from 'vitest'
import { classifyRoomLoad } from './roomLoad'

describe('classifyRoomLoad', () => {
  it('有資料一律 ok', () => {
    expect(classifyRoomLoad({ id: 'r1' }, null)).toBe('ok')
  })
  it('查無列（PGRST116）是 not-found：不存在或非成員被 RLS 擋', () => {
    expect(classifyRoomLoad(null, { code: 'PGRST116' })).toBe('not-found')
  })
  it('DB 錯誤（如 42703 欄位不存在）是 error，不得偽裝成 not-found', () => {
    expect(classifyRoomLoad(null, { code: '42703' })).toBe('error')
  })
  it('網路層失敗（error 無 code）也是 error', () => {
    expect(classifyRoomLoad(null, {})).toBe('error')
  })
  it('無資料也無錯誤視為 not-found（防衛：不讓 UI 卡在載入中）', () => {
    expect(classifyRoomLoad(null, null)).toBe('not-found')
  })
})
