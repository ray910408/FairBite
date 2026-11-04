// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getUid } from '../lib/uid'
import { deferred, settle } from '../test/dom'
import PrefsSuggestion from './PrefsSuggestion'

// 房間頁頂端的口味建議卡（原本在首頁，Task 11 的失敗規則一起搬過來）。只在模組邊界 mock：
// lib/supabase（預設偏好 RPC、近 50 筆與低分列兩筆同席紀錄、profiles 寫入）與 lib/uid。

type Result = { data?: unknown; error?: unknown }

const mocks = vi.hoisted(() => {
  const prefs = vi.fn(async (): Promise<Result> => ({ data: { default_prefs: { cuisines: [] } }, error: null }))
  const history = vi.fn(async (): Promise<Result> => ({ data: [], error: null }))
  const lowRows = vi.fn(async (): Promise<Result> => ({ data: [], error: null }))
  const write = vi.fn(async (_patch: unknown): Promise<Result> => ({ error: null }))
  // 查詢鏈：整條鏈被 await 時才依有沒有接 lte（低分列）取結果
  function chain(result: (lte: boolean) => Promise<Result>) {
    let lte = false
    const self = {
      eq: () => self,
      order: () => self,
      limit: () => self,
      lte() { lte = true; return self },
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => result(lte).then(resolve, reject),
    }
    return self
  }
  const from = vi.fn((_table: string) => ({
    select: () => chain(lte => lte ? lowRows() : history()),
    update: (patch: unknown) => chain(() => write(patch)),
  }))
  const rpc = vi.fn((_name: string) => ({ single: () => prefs() }))
  return { prefs, history, lowRows, write, from, rpc }
})

vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }))
vi.mock('../lib/uid')

const ME = 'user-1'
const LOAD_ERROR = '口味建議暫時載入失敗；不影響本次聚餐條件'
// 近 50 筆裡日式、韓式各吃過兩次，但低分列裡韓式被打過 1 星：完整資料只該建議日式。
// 少了低分列就會連韓式一起建議——這組資料看得出有沒有拿缺一角的資料硬推
const ate = (rating: number, tag: string) => ({ rating, restaurants: { cuisine_tags: [tag] } })
const failed: Result = { data: null, error: new Error('query failed') }
const suggestion = () => screen.queryByText(/根據你的用餐紀錄/)?.textContent ?? null
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })

async function renderCard(onApply = vi.fn()) {
  const view = render(<PrefsSuggestion onApply={onApply} />)
  await settle()
  return { ...view, onApply }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getUid).mockResolvedValue(ME)
  mocks.prefs.mockResolvedValue({ data: { default_prefs: { cuisines: ['ramen'], budget: 1 } }, error: null })
  mocks.history.mockResolvedValue({
    data: [ate(5, 'japanese'), ate(4, 'japanese'), ate(5, 'korean'), ate(4, 'korean')], error: null })
  mocks.lowRows.mockResolvedValue({ data: [ate(1, 'korean')], error: null })
  mocks.write.mockResolvedValue({ error: null })
})

describe('PrefsSuggestion', () => {
  it('透過 caller-bound RPC 讀預設偏好，不直接查 profiles', async () => {
    await renderCard()
    expect(mocks.rpc).toHaveBeenCalledWith('get_my_default_prefs')
    expect(mocks.from).not.toHaveBeenCalledWith('profiles')
    expect(suggestion()).toContain('你常吃：日式。')
  })

  it.each([
    ['profile 單獨失敗', [0]],
    ['recent history 單獨失敗', [1]],
    ['low ratings 單獨失敗', [2]],
    ['三筆全部失敗', [0, 1, 2]],
  ])('%s：不以缺資料推論，改顯示非阻擋的 status', async (_name, broken) => {
    const queries = [mocks.prefs, mocks.history, mocks.lowRows]
    for (const i of broken) queries[i].mockResolvedValueOnce(failed)
    await renderCard()
    expect(suggestion()).toBeNull()
    expect(screen.getByText(LOAD_ERROR).closest('[role="status"]')).not.toBeNull()
  })

  it('套用：併進既有預設偏好（其他欄位原樣保留），成功後交給 onApply 並收起', async () => {
    const { onApply } = await renderCard()
    fireEvent.click(button('套用'))
    await settle()
    expect(mocks.write).toHaveBeenCalledWith({ default_prefs: { cuisines: ['ramen', 'japanese'], budget: 1 } })
    expect(onApply).toHaveBeenCalledWith(['japanese'])
    expect(suggestion()).toBeNull()
  })

  it('預設偏好寫入失敗：不改這次的條件，建議留著可重試', async () => {
    mocks.write.mockResolvedValueOnce({ error: new Error('denied') })
    const { onApply } = await renderCard()
    fireEvent.click(button('套用'))
    await settle()
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('偏好儲存失敗，請稍後再試')
    expect(suggestion()).toContain('你常吃：日式。')
  })

  it('按忽略會記在這台裝置，下次進房不再建議同一菜系', async () => {
    localStorage.setItem(`prefs-suggest-dismissed:${ME}`, 'korean')
    const view = await renderCard()
    fireEvent.click(button('忽略'))
    expect(suggestion()).toBeNull()
    expect(localStorage.getItem(`prefs-suggest-dismissed:${ME}`)).toBe('korean,japanese')

    view.unmount()
    await renderCard()
    expect(mocks.prefs).toHaveBeenCalledTimes(2) // 確實又查了一次
    expect(suggestion()).toBeNull()
  })

  it('忽略清單讀寫都丟錯：建議照常顯示，按忽略照樣收起', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
    await renderCard()
    expect(suggestion()).toContain('你常吃：日式。')
    fireEvent.click(button('忽略'))
    expect(suggestion()).toBeNull()
  })

  // 離開房間頁後才回來的結果：看得到的只有卸載後還有沒有往外做事
  it('unmount 後 uid 才回來：不再發出口味查詢', async () => {
    const uid = deferred<string | null>()
    vi.mocked(getUid).mockReturnValue(uid.promise)
    const view = await renderCard()
    view.unmount()
    await act(async () => uid.resolve(ME))
    await settle()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('unmount 後查詢才回來：不再往下推論建議', async () => {
    const gate = deferred<Result>()
    mocks.prefs.mockReturnValueOnce(gate.promise)
    const view = await renderCard()
    view.unmount()
    const read = vi.spyOn(Storage.prototype, 'getItem')
    await act(async () => gate.resolve({ data: { default_prefs: {} }, error: null }))
    await settle()
    expect(read).not.toHaveBeenCalledWith(`prefs-suggest-dismissed:${ME}`)
  })
})
