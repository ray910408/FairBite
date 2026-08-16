import { describe, expect, it } from 'vitest'
import { leaveNotice } from './leaveNotice'

const REJOIN = '可用邀請碼重新加入' // 只有「還有別人的 lobby 房」能這樣承諾

describe('leaveNotice', () => {
  it('lobby 單人：房間必被刪、邀請碼必失效，不承諾可重加入', () => {
    const points = leaveNotice('lobby', 1, 'ABC123')
    expect(points.join('\n')).not.toContain(REJOIN)
    expect(points[0]).toBe('你是房間裡唯一的人，離開後這個房間會直接刪除')
    expect(points[1]).toContain('邀請碼 ABC123 會跟著失效')
  })

  it('lobby 多人：刪房是條件句，且承諾之後可用邀請碼重新加入', () => {
    const points = leaveNotice('lobby', 3, 'ABC123')
    expect(points).toContain('你若是最後一位成員，房間會直接被刪除')
    expect(points.join('\n')).toContain(`之後${REJOIN}`)
  })

  // candidates 階段不可能有票（贊成／否決鈕只在 voting 出現），講「投票作廢」是假的
  it('candidates：講條件退出重算，完全不提投票', () => {
    const points = leaveNotice('candidates', 3, 'ABC123')
    expect(points.join('\n')).not.toContain('投票')
    expect(points[0]).toBe('你的條件與偏好會退出重算，候選名單會重新分割')
    expect(points.join('\n')).toContain('無法用邀請碼重新加入')
  })

  it('voting：票即刻作廢並重算，且沒有重加入的路', () => {
    const points = leaveNotice('voting', 3, 'ABC123')
    expect(points[0]).toBe('你的投票會即刻作廢，候選盤面會重新計算')
    expect(points.join('\n')).toContain('無法用邀請碼重新加入')
    expect(points.join('\n')).not.toContain(`之後${REJOIN}`)
  })

  it('decided：多一句抽中結果只能在足跡查看', () => {
    const points = leaveNotice('decided', 3, 'ABC123')
    expect(points).toContain('房間已定案，抽中的結果之後只能在「足跡」查看')
    expect(points.join('\n')).not.toContain(`之後${REJOIN}`)
  })

  // memberCount = null（成員沒載成功，人數不可判定）：兩個方向都不能給無條件承諾
  it('null：不說「唯一的人」，也不給無條件的重加入承諾', () => {
    const lobby = leaveNotice('lobby', null, 'ABC123')
    expect(lobby.join('\n')).not.toContain('你是房間裡唯一的人')
    expect(lobby).toContain('你若是最後一位成員，房間會直接被刪除') // 兩種人數下都成立
    expect(lobby.join('\n')).not.toContain(`之後${REJOIN}`) // 無條件版不得出現
    expect(lobby.join('\n')).toContain(`只要房間還在（你不是最後一位），之後仍${REJOIN}`)

    for (const status of ['candidates', 'voting', 'decided'] as const) {
      const points = leaveNotice(status, null, 'ABC123')
      expect(points.join('\n')).not.toContain('你是房間裡唯一的人')
      expect(points).toContain('你若是最後一位成員，房間會直接被刪除')
    }
  })
})
