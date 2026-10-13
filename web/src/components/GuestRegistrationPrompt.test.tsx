// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import '../test/dom'
import { GuestRegistrationPrompt, guestRegistrationDismissKey } from './GuestRegistrationPrompt'

// 行為測試：真的 React state、jsdom 的 localStorage／sessionStorage、真的 MemoryRouter（元件渲染 Link）。

const skip = () => screen.queryByRole('button', { name: '這次先不要' })

const page = (userId: string, open: boolean) => (
  <MemoryRouter initialEntries={['/room/room-1']}>
    <Routes>
      <Route path="/room/:id" element={<GuestRegistrationPrompt userId={userId} roomId="room-1" open={open} />} />
      <Route path="/auth" element={<p>註冊頁</p>} />
    </Routes>
  </MemoryRouter>
)

// ../test/dom 只清 localStorage；註冊回跳記在 sessionStorage，這裡自己清
beforeEach(() => { sessionStorage.clear() })

describe('GuestRegistrationPrompt', () => {
  it('only shows after requested and suppresses repeats for this guest browser session', () => {
    const view = render(page('guest-1', false))
    expect(skip()).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()

    view.rerender(page('guest-1', true))
    expect(screen.getByRole('heading', { name: '保留這次聚餐紀錄？' })).toBeTruthy()
    fireEvent.click(skip()!)
    expect(localStorage.getItem(guestRegistrationDismissKey('guest-1'))).toBe('1')
    expect(skip()).toBeNull()
    expect(screen.queryByRole('heading')).toBeNull()
    view.unmount()

    // 同一個訪客再進房（重新掛載）：記住了，不再問
    const again = render(page('guest-1', true))
    expect(skip()).toBeNull()
    again.unmount()
    // 換一個訪客身分：照常詢問
    render(page('guest-2', true))
    expect(skip()).toBeTruthy()
  })

  it('點註冊記下要回到的房間，並帶去註冊頁', () => {
    render(page('guest-1', true))
    fireEvent.click(screen.getByRole('link', { name: '註冊並保留紀錄' }))
    expect(sessionStorage.getItem('guest-upgrade-return:guest-1')).toBe('/room/room-1')
    expect(screen.getByText('註冊頁')).toBeTruthy()
  })
})
