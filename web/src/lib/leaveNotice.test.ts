import { describe, expect, it } from 'vitest'
import { leaveNotice } from './leaveNotice'

const REJOIN = '可用邀請碼重新加入' // 只有「還有別人的 lobby 房」能這樣承諾
// 單人房走不到 rescoreRoom（leave.go 刪房後直接 return），這兩句一律不得出現
const RESCORE = ['重新分割', '重新計算', '退出重算', '盤面']

describe('leaveNotice', () => {
  it('lobby 單人：房間必被刪、邀請碼必失效，不承諾可重加入', () => {
    const points = leaveNotice('lobby', 1, 'ABC123', false)
    expect(points.join('\n')).not.toContain(REJOIN)
    expect(points[0]).toBe('你是房間裡唯一的人，離開後這個房間會直接刪除')
    expect(points[1]).toContain('邀請碼 ABC123 會跟著失效')
  })

  it('lobby 多人：刪房是條件句，且承諾之後可用邀請碼重新加入', () => {
    const points = leaveNotice('lobby', 3, 'ABC123', false)
    expect(points).toContain('你若是最後一位成員，房間會直接被刪除')
    expect(points.join('\n')).toContain(`之後${REJOIN}`)
  })

  // candidates 階段不可能有票（贊成／否決鈕只在 voting 出現），講「投票作廢」是假的
  it('candidates 多人：講條件退出重算，完全不提投票', () => {
    const points = leaveNotice('candidates', 3, 'ABC123', false)
    expect(points.join('\n')).not.toContain('投票')
    expect(points[0]).toBe('你的條件與偏好會退出重算，候選名單會重新分割')
    expect(points.join('\n')).toContain('無法用邀請碼重新加入')
  })

  it('voting 多人：票即刻作廢並重算，且沒有重加入的路', () => {
    const points = leaveNotice('voting', 3, 'ABC123', false)
    expect(points[0]).toBe('你的投票會即刻作廢，候選盤面會重新計算')
    expect(points.join('\n')).toContain('無法用邀請碼重新加入')
    expect(points.join('\n')).not.toContain(`之後${REJOIN}`)
  })

  it('decided：多一句抽中結果只能在足跡查看', () => {
    const points = leaveNotice('decided', 3, 'ABC123', false)
    expect(points).toContain('房間已定案，抽中的結果之後只能在「足跡」查看')
    expect(points.join('\n')).not.toContain(`之後${REJOIN}`)
  })

  // memberCount = null（成員沒載成功，人數不可判定）：兩個方向都不能給無條件承諾
  it('null：不說「唯一的人」，也不給無條件的重加入承諾', () => {
    const lobby = leaveNotice('lobby', null, 'ABC123', false)
    expect(lobby.join('\n')).not.toContain('你是房間裡唯一的人')
    expect(lobby).toContain('你若是最後一位成員，房間會直接被刪除') // 兩種人數下都成立
    expect(lobby.join('\n')).not.toContain(`之後${REJOIN}`) // 無條件版不得出現
    expect(lobby.join('\n')).toContain(`只要房間還在（你不是最後一位），之後仍${REJOIN}`)

    for (const status of ['candidates', 'voting', 'decided'] as const) {
      const points = leaveNotice(status, null, 'ABC123', false)
      expect(points.join('\n')).not.toContain('你是房間裡唯一的人')
      expect(points).toContain('你若是最後一位成員，房間會直接被刪除')
    }
  })
})

// 末位退房在 leave.go 刪完房就 return，走不到 rescoreRoom：單人房沒有盤面可以重算，
// 而同一張 dialog 又寫著「房間會直接刪除」——承諾重算是自打嘴巴的假話
describe('leaveNotice 單人房不承諾重算', () => {
  it('candidates 單人：講刪除與資料消失，不提任何重算', () => {
    const points = leaveNotice('candidates', 1, 'ABC123', false)
    const text = points.join('\n')
    for (const promise of RESCORE) expect(text).not.toContain(promise)
    expect(points[0]).toBe('你是房間裡唯一的人，離開後這個房間會直接刪除')
    expect(text).toContain('候選名單會跟著刪除')
    expect(text).toContain('無法用邀請碼重新加入')
  })

  it('voting 單人：票與候選一起刪除，不提盤面重算', () => {
    const points = leaveNotice('voting', 1, 'ABC123', false)
    const text = points.join('\n')
    for (const promise of RESCORE) expect(text).not.toContain(promise)
    expect(points[0]).toBe('你是房間裡唯一的人，離開後這個房間會直接刪除')
    expect(text).toContain('你的票和整份候選名單會跟著刪除')
  })

  // 人數不可判定時重算「可能」發生，維持非單人版的敘述不算說謊
  it('memberCount null 仍用會重算的多人版敘述', () => {
    expect(leaveNotice('candidates', null, 'ABC123', false)[0])
      .toBe('你的條件與偏好會退出重算，候選名單會重新分割')
    expect(leaveNotice('voting', null, 'ABC123', false)[0])
      .toBe('你的投票會即刻作廢，候選盤面會重新計算')
  })
})

// 房主退出＝移交給最早加入者（ADR-0007、leave.go 的 update rooms set host_id）：
// lobby 特別誤導——文案說「之後可重新加入」，但回來不會拿回房主權限
describe('leaveNotice 房主移交', () => {
  const TRANSFER = '房主身分會移交給其餘成員中最早加入的人，你重新加入也不會拿回房主權限'

  it('多人房的房主：明說會移交、回來也拿不回控制權', () => {
    for (const status of ['lobby', 'candidates', 'voting', 'decided'] as const) {
      expect(leaveNotice(status, 3, 'ABC123', true).join('\n')).toContain(`你是房主：離開後${TRANSFER}`)
    }
  })

  it('單人房不講移交：沒有人可以繼任，房直接刪', () => {
    for (const status of ['lobby', 'candidates', 'voting', 'decided'] as const) {
      expect(leaveNotice(status, 1, 'ABC123', true).join('\n')).not.toContain('移交')
    }
  })

  it('確定不是房主：完全不提移交', () => {
    expect(leaveNotice('lobby', 3, 'ABC123', false).join('\n')).not.toContain('移交')
  })

  // isHost = null（拿不到 uid）／memberCount = null（人數不可判定）：不猜，用條件句
  it('不可判定時退回「你若是房主」的條件句', () => {
    expect(leaveNotice('lobby', 3, 'ABC123', null).join('\n')).toContain(`你若是房主，${TRANSFER}`)
    expect(leaveNotice('lobby', null, 'ABC123', true).join('\n')).toContain(`你若是房主，${TRANSFER}`)
    expect(leaveNotice('lobby', null, 'ABC123', null).join('\n')).toContain(`你若是房主，${TRANSFER}`)
    expect(leaveNotice('lobby', null, 'ABC123', false).join('\n')).not.toContain('移交')
  })
})
