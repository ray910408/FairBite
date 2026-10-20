// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Room } from '../lib/types'
import { deferred } from '../test/dom'
import { useRoom } from './useRoom'

// 行為測試：真的 React hooks 跑在 jsdom 上，只在模組邊界 mock——lib/supabase（PostgREST 查詢與
// Realtime channel）、lib/uid。斷言只看 hook 每次重畫回傳的值、refetch() 的 resolve／reject，
// 以及送出去的查詢，不看 hook 內部有幾個 state、effect 排第幾個。

type RoomsReply = { data: Room | null; error: { code: string } | null }

const mocks = vi.hoisted(() => {
  const state = { room: null as unknown, roomsReplies: [] as Promise<unknown>[] }
  // 查詢鏈：後面可接任意 select／eq／order／limit／single／maybeSingle，整條鏈被 await 時才取結果
  function chain(result: Promise<unknown>) {
    const self = {
      select: () => self,
      eq: () => self,
      order: () => self,
      limit: () => self,
      single: () => self,
      maybeSingle: () => self,
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => result.then(resolve, reject),
    }
    return self
  }
  // 每輪 refetch 都查一次 rooms，整輪 Promise.all 等它：roomsReplies 依序當之後各輪 rooms 查詢的回應，
  // 排 deferred 就能卡住、放行或打掉某一輪；沒排就立即回 state.room。其他表立即回空結果。
  const from = vi.fn((table: string) => chain(table === 'rooms'
    ? state.roomsReplies.shift() ?? Promise.resolve({ data: state.room, error: null })
    : Promise.resolve({ data: table === 'draws' ? null : [], error: null })))
  // Realtime：記下每個 channel 各表的 postgres_changes handler 與 subscribe 的狀態回呼，測試拿來推事件
  type Change = (payload: { commit_timestamp?: string }) => void
  type Channel = { handlers: Map<string, Change>; status?: (status: string) => void }
  const channels: Channel[] = []
  const channel = vi.fn(() => {
    const record: Channel = { handlers: new Map() }
    channels.push(record)
    const api = {
      on(_event: string, filter: { table: string }, handler: Change) {
        record.handlers.set(filter.table, handler)
        return api
      },
      subscribe(callback: (status: string) => void) {
        record.status = callback
        return api
      },
    }
    return api
  })
  return { state, from, channel, channels, removeChannel: vi.fn() }
})

vi.mock('../lib/supabase', () => ({
  supabase: { from: mocks.from, channel: mocks.channel, removeChannel: mocks.removeChannel },
}))
vi.mock('../lib/uid', () => ({ getUid: vi.fn(async () => 'me') }))

const ROOM_TABLES = ['rooms', 'room_members', 'room_candidates', 'draws', 'votes', 'location_change_votes',
  'shortlist_votes', 'shortlist_picks']

// draw_version 當作「哪一輪的資料」的標記
function room(status: Room['status'], drawVersion = 0): Room {
  return {
    id: 'room-1', code: 'ABC123', host_id: 'host-1', status,
    exploration: 'balanced', meal_time: null, cuisine_filter: false, draw_version: drawVersion, search_version: 0,
  }
}

const found = (data: Room): RoomsReply => ({ data, error: null })

// 下一輪 rooms 查詢的回應：resolve 放行、reject 模擬查詢拋錯、不動就一直卡著
function nextRooms() {
  const reply = deferred<RoomsReply>()
  mocks.state.roomsReplies.push(reply.promise)
  return reply
}

const rounds = () => mocks.from.mock.calls.filter(([table]) => table === 'rooms').length

// fake timers 下推進時間並把途中的 state 更新畫出來：RTL 的 waitFor 不會推 vitest 的假時鐘
async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

// 跟 runAction 一樣在 await refetch() 之後才解鎖按鈕：記下每次重畫時的房間與鎖，
// 看得出解鎖的那一刻畫面上是不是新資料
function renderRoom() {
  const renders: Array<{ room: Room | null; released: boolean }> = []
  const view = renderHook(() => {
    const data = useRoom('room-1')
    const [released, setReleased] = useState(false)
    renders.push({ room: data.room, released })
    return { ...data, release: () => setReleased(true) }
  })
  const versions = () => renders.map(r => r.room?.draw_version)
  const releasedVersions = () => [...new Set(renders.filter(r => r.released).map(r => r.room?.draw_version))]
  return { ...view, versions, releasedVersions }
}

// 進房那輪（mount 的 refetch）已寫進 state
async function mountRoom(status: Room['status'] = 'voting') {
  mocks.state.room = room(status, 1)
  const view = renderRoom()
  await advance(0)
  expect(view.result.current.room).toEqual(room(status, 1))
  return view
}

// 背景重抓沒人 await：reject 沒接住會變成 unhandled rejection，這裡收集起來直接斷言
function captureUnhandled() {
  const reasons: unknown[] = []
  const listener = (reason: unknown) => { reasons.push(reason) }
  process.on('unhandledRejection', listener)
  onTestFinished(() => { process.off('unhandledRejection', listener) })
  return reasons
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.state.room = null
  mocks.state.roomsReplies.length = 0
  mocks.channels.length = 0
  mocks.from.mockClear()
})

describe('useRoom lobby Realtime fallback', () => {
  it('lobby 單飛 refetch 完成後才排下一輪，in-flight cleanup 不重排', async () => {
    const { unmount } = await mountRoom('lobby')
    expect(rounds()).toBe(1)

    const second = nextRooms()
    await advance(4_999)
    expect(rounds()).toBe(1)
    await advance(1)
    expect(rounds()).toBe(2)
    // 一輪＝八張表各查一次
    expect(mocks.from.mock.calls.map(([table]) => table).sort()).toEqual([...ROOM_TABLES, ...ROOM_TABLES].sort())

    await advance(10_000)
    expect(rounds()).toBe(2) // 上一輪還在飛，不疊新的

    second.resolve(found(room('lobby')))
    await advance(0)
    const third = nextRooms()
    await advance(4_999)
    expect(rounds()).toBe(2)
    await advance(1)
    expect(rounds()).toBe(3)

    unmount() // 第三輪還在飛時卸載：它回來之後不再排下一輪
    third.resolve(found(room('lobby')))
    await advance(10_000)
    expect(rounds()).toBe(3)
  })

  it('非 lobby 不輪詢', async () => {
    await mountRoom('voting')
    await advance(60_000)
    expect(rounds()).toBe(1)
  })

  it('離開 lobby 就取消已排好的下一輪', async () => {
    const { result } = await mountRoom('lobby')
    await advance(3_000)
    nextRooms().resolve(found(room('voting')))
    await act(() => result.current.refetch())
    expect(result.current.room?.status).toBe('voting')
    await advance(60_000)
    expect(rounds()).toBe(2)
  })

  it('輪詢某一輪失敗：不外漏 unhandled rejection，照樣排下一輪', async () => {
    const unhandled = captureUnhandled()
    await mountRoom('lobby')
    const failed = nextRooms()
    await advance(5_000)
    expect(rounds()).toBe(2)
    failed.reject(new Error('boom'))
    await advance(0)
    await advance(5_000)
    expect(rounds()).toBe(3)
    expect(unhandled).toEqual([])
  })
})

describe('useRoom 背景重抓', () => {
  it('進房、連上 Realtime、收到變更（每筆交易立刻一輪）都會重抓；查詢拋錯不外漏 unhandled rejection', async () => {
    const unhandled = captureUnhandled()
    const boom = new Error('boom')
    mocks.state.room = room('voting')

    const onMount = nextRooms()
    const { unmount } = renderRoom()
    expect(rounds()).toBe(1)
    onMount.reject(boom)
    await advance(0)

    const onSubscribed = nextRooms()
    act(() => { mocks.channels.at(-1)?.status?.('SUBSCRIBED') })
    expect(rounds()).toBe(2)
    onSubscribed.reject(boom)
    await advance(0)

    const change = (table: string, commit_timestamp?: string) =>
      mocks.channels.at(-1)?.handlers.get(table)?.({ commit_timestamp })
    const onVote = nextRooms()
    change('votes', '2026-10-20T12:00:00.100Z')
    expect(rounds()).toBe(3) // 第一個事件就抓，不等
    change('room_candidates', '2026-10-20T12:00:00.100Z')
    change('rooms', '2026-10-20T12:00:00.100Z')
    await advance(1_000)
    expect(rounds()).toBe(3) // 同一筆交易（同 commit_timestamp）的其餘事件不再重抓

    // 上一輪還在飛：下一筆交易可能不在它的快照裡，照樣立刻抓
    const onNextCommit = nextRooms()
    change('room_candidates', '2026-10-20T12:00:00.250Z')
    expect(rounds()).toBe(4)
    onVote.reject(boom)
    onNextCommit.reject(boom)
    await advance(0)

    // 沒帶 commit_timestamp 就分不出是不是同一筆：每個都抓
    const unstamped = [nextRooms(), nextRooms()]
    change('votes')
    change('votes')
    expect(rounds()).toBe(6)
    for (const reply of unstamped) reply.reject(boom)
    await advance(0)

    unmount()
    change('votes', '2026-10-20T12:00:01.000Z')
    expect(rounds()).toBe(6) // 卸載後舊 channel 還在派發的事件不重抓

    expect(unhandled).toEqual([])
  })
})

describe('useRoom refetch 房間消失', () => {
  it('查無列（房間已刪）清掉舊 room，頁面才會顯示找不到房間', async () => {
    const { result } = await mountRoom()
    nextRooms().resolve({ data: null, error: { code: 'PGRST116' } })
    await act(() => result.current.refetch())
    expect(result.current.room).toBeNull()
    expect(result.current.notFound).toBe(true)
    expect(result.current.loadError).toBe(false)
  })

  it('暫時性錯誤保留舊 room（只亮 loadError）', async () => {
    const { result } = await mountRoom()
    const before = result.current.room
    nextRooms().resolve({ data: null, error: { code: '57014' } })
    await act(() => result.current.refetch())
    expect(result.current.room).toBe(before)
    expect(result.current.loadError).toBe(true)
    expect(result.current.notFound).toBe(false)
  })
})

// 動作成功後 await refetch() 才解鎖按鈕：Realtime 剛好觸發新的一輪時，舊輪若提早 resolve，
// 按鈕會在新資料寫入前就解鎖，按下去伺服器回「房間狀態已變更」
describe('useRoom refetch 被新一輪取代', () => {
  it('舊輪等到新一輪把資料寫進 state 才 resolve', async () => {
    const { result, versions, releasedVersions } = await mountRoom()
    const a = nextRooms()
    const b = nextRooms()
    let aDone = false
    const first = result.current.refetch().then(() => {
      aDone = true
      result.current.release()
    })
    const second = result.current.refetch()

    a.resolve(found(room('voting', 2)))
    await advance(0)
    expect(aDone).toBe(false) // A 的結果作廢，但不能先 resolve
    expect(result.current.room?.draw_version).toBe(1)

    b.resolve(found(room('voting', 3)))
    await advance(0)
    await Promise.all([first, second])
    expect(result.current.room?.draw_version).toBe(3)
    expect(releasedVersions()).toEqual([3]) // 解鎖的那一刻畫面已是新一輪的資料
    expect(versions()).not.toContain(2) // A 的資料從沒寫進 state
  })

  // supabase-js 沒有預設 timeout：行動網路半開連線時，中間那一輪可能永遠不回來
  it('取代它的那一輪卡住時，舊輪等到之後任何一輪寫進 state 就 resolve', async () => {
    const { result, versions, releasedVersions } = await mountRoom()
    const a = nextRooms()
    nextRooms() // B 卡住
    let aDone = false
    void result.current.refetch().then(() => {
      aDone = true
      result.current.release()
    })
    void result.current.refetch()

    a.resolve(found(room('voting', 2)))
    await advance(0)
    expect(aDone).toBe(false) // A 完成時已被 B 取代

    const c = nextRooms()
    const third = result.current.refetch() // A 完成之後才開始的 C
    c.resolve(found(room('voting', 3)))
    await advance(0)
    await third
    expect(aDone).toBe(true)
    expect(result.current.room?.draw_version).toBe(3)
    expect(releasedVersions()).toEqual([3])
    expect(versions()).not.toContain(2)
  })

  it('舊輪比新一輪晚完成：新一輪已寫進 state，舊輪直接 resolve 不空等', async () => {
    const { result, versions } = await mountRoom()
    const a = nextRooms()
    let aDone = false
    void result.current.refetch().then(() => { aDone = true })
    nextRooms().resolve(found(room('voting', 3)))
    await act(() => result.current.refetch())
    expect(result.current.room?.draw_version).toBe(3)

    a.resolve(found(room('voting', 2)))
    await advance(0)
    expect(aDone).toBe(true)
    expect(result.current.room?.draw_version).toBe(3)
    expect(versions()).not.toContain(2)
  })

  it('取代它的那一輪失敗時，舊輪一起 reject（runAction 才會說重新載入失敗）', async () => {
    const { result } = await mountRoom()
    const a = nextRooms()
    const b = nextRooms()
    const settled = Promise.allSettled([result.current.refetch(), result.current.refetch()])

    a.resolve(found(room('voting', 2)))
    await advance(0)
    const offline = new Error('offline')
    b.reject(offline)
    await advance(0)
    expect(await settled).toEqual([
      { status: 'rejected', reason: offline }, { status: 'rejected', reason: offline },
    ])
  })

  it('被取代的那一輪失敗只影響自己：排隊的舊輪照樣等最新一輪', async () => {
    const { result } = await mountRoom()
    const a = nextRooms()
    const b = nextRooms()
    const c = nextRooms()
    let aOutcome: 'resolved' | 'rejected' | undefined
    void result.current.refetch().then(() => { aOutcome = 'resolved' }, () => { aOutcome = 'rejected' })
    const second = Promise.allSettled([result.current.refetch()])
    const third = result.current.refetch()

    a.resolve(found(room('voting', 2)))
    await advance(0)
    const offline = new Error('offline')
    b.reject(offline)
    await advance(0)
    expect(await second).toEqual([{ status: 'rejected', reason: offline }])
    expect(aOutcome).toBeUndefined() // B 失敗時已被 C 取代，不連累 A

    c.resolve(found(room('voting', 3)))
    await advance(0)
    await third
    expect(aOutcome).toBe('resolved')
    expect(result.current.room?.draw_version).toBe(3)
  })
})
