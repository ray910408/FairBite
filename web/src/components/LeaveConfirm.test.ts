import { describe, expect, it, vi } from 'vitest'
import { LeaveConfirm } from './LeaveConfirm'

// 共用外殼（RoomPage／HistoryPage／HomePage 三處離席確認）的 a11y 與捲動結構。
// 版面是修過的 bug：多房籍在 320x568 會溢出，取消與確認鈕點不到。
type NodeLike = { type?: unknown; props?: Record<string, unknown> }

function findNode(node: unknown, pred: (el: NodeLike) => boolean): NodeLike | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, pred)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  const element = node as NodeLike
  if (pred(element)) return element
  return findNode(element.props?.children, pred)
}

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node && typeof node === 'object') return textContent((node as NodeLike).props?.children)
  return ''
}

const cls = (el: NodeLike | undefined) => String(el?.props?.className ?? '')
const byClass = (needle: string) => (el: NodeLike) => cls(el).includes(needle)

type Props = Parameters<typeof LeaveConfirm>[0]

function render(overrides: Partial<Props> = {}) {
  return LeaveConfirm({ title: '離開房間？', actions: 'ACTIONS', children: 'BODY', ...overrides })
}

describe('LeaveConfirm 外殼', () => {
  it('是有名稱的 modal dialog，標題由 aria-labelledby 指到', () => {
    const tree = render()
    const dialog = findNode(tree, el => el.props?.role === 'dialog')
    expect(dialog?.props?.['aria-modal']).toBe('true')
    expect(dialog?.props?.['aria-labelledby']).toBe('leave-title')
    const title = findNode(tree, el => el.type === 'h2')
    expect(title?.props?.id).toBe('leave-title')
    expect(textContent(title)).toBe('離開房間？')
  })

  // 卡片限高在視窗內，只讓中段捲動；標題與按鈕組 shrink-0 永遠構得到
  it('卡片限高、只有中段捲動，標題與按鈕組不被捲走', () => {
    const tree = render()
    const dialog = findNode(tree, el => el.props?.role === 'dialog')
    expect(cls(dialog)).toContain('max-h-full')
    expect(cls(dialog)).toContain('flex-col')

    const scroller = findNode(dialog, byClass('overflow-y-auto'))
    expect(cls(scroller)).toContain('min-h-0') // 沒有它 flex item 不肯縮
    expect(cls(scroller)).toContain('flex-1')
    expect(textContent(scroller)).toBe('BODY')

    expect(findNode(scroller, byClass('shrink-0'))).toBeUndefined() // 控制項不在捲動區內
    expect(textContent(findNode(tree, el => el.type === 'h2'))).toBe('離開房間？')
    const actions = findNode(dialog, el => textContent(el) === 'ACTIONS' && cls(el) !== '')
    expect(cls(actions)).toContain('shrink-0')
    expect(cls(actions)).toContain('flex-col') // 320px 一律直排
  })

  it('actionsClassName 疊在按鈕組上（RoomPage 的 sm 以上並排）', () => {
    const tree = render({ actionsClassName: 'sm:flex-row' })
    const actions = findNode(tree, el => textContent(el) === 'ACTIONS' && cls(el) !== '')
    expect(cls(actions)).toContain('sm:flex-row')
    expect(cls(actions)).toContain('flex-col')
  })

  it('Esc 關閉，其他鍵不關；沒有 onClose 就不掛 keydown', () => {
    const onClose = vi.fn()
    const tree = render({ onClose })
    const overlay = findNode(tree, el => typeof el.props?.onKeyDown === 'function')!
    const onKeyDown = overlay.props!.onKeyDown as (e: { key: string }) => void
    onKeyDown({ key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
    onKeyDown({ key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    // HomePage 的 mount 攔截沒有「留在首頁但不決定」的合法終態，故不給 Esc
    expect(findNode(render(), el => typeof el.props?.onKeyDown === 'function')).toBeUndefined()
  })
})
