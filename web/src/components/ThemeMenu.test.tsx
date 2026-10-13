// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import '../test/dom'
import { ThemeMenu } from './ThemeMenu'

// testing-library 的 name 給字串是整串比對，「大」不會命中「特大」
const option = (name: string) => screen.getByRole('button', { name })

it('選字級：套到 <html>、記住選擇、選單不收起；選回標準就不留 key', () => {
  render(<ThemeMenu />)
  fireEvent.click(screen.getByRole('button', { name: /^外觀/ }))
  expect(option('標準').getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(option('特大'))
  expect(document.documentElement.dataset.fontSize).toBe('xl')
  expect(localStorage.getItem('fontSize')).toBe('xl')
  expect(option('特大').getAttribute('aria-pressed')).toBe('true')
  expect(option('標準').getAttribute('aria-pressed')).toBe('false')

  fireEvent.click(option('標準'))
  expect(document.documentElement.dataset.fontSize).toBe('md')
  expect(localStorage.getItem('fontSize')).toBeNull()
  expect(option('大').getAttribute('aria-pressed')).toBe('false')
})
