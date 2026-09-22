import { expect, test, type Page } from '@playwright/test'

// 用 HTTP stub 登入並回傳空房籍，在真實首頁測轉盤，不需要 Go 或 Supabase。
async function openHome(page: Page) {
  const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated',
    role: 'authenticated', email: 'wheel@example.com', app_metadata: {}, user_metadata: {},
    created_at: '2026-01-01T00:00:00Z' }
  const expires = Math.floor(Date.now() / 1000) + 3600
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: user.id, exp: expires, role: 'authenticated' })).toString('base64url'),
    'test-signature',
  ].join('.')
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/auth/v1/')) {
      await route.fulfill({ json: url.pathname.endsWith('/user') ? user : {
        access_token: jwt, refresh_token: 'test-refresh', token_type: 'bearer',
        expires_in: 3600, expires_at: expires, user,
      } })
    } else if (url.pathname.includes('/rest/v1/')) {
      await route.fulfill({ json: url.pathname.endsWith('/get_my_default_prefs') ? { default_prefs: {} } : [] })
    } else if (url.pathname === '/healthz') {
      await route.fulfill({ json: { ok: true } })
    } else if (['localhost', '127.0.0.1'].includes(url.hostname)) {
      await route.continue()
    } else {
      await route.abort()
    }
  })
  await page.goto('/')
  await page.getByLabel('Email', { exact: true }).fill(user.email)
  await page.getByLabel('密碼', { exact: true }).fill('test-password')
  await page.locator('form').getByRole('button', { name: '登入', exact: true }).click()
  await expect(page.getByRole('button', { name: '加入', exact: true })).toBeEnabled()
  await page.locator('summary').filter({ hasText: '自製轉盤' }).click()
}

async function addOption(page: Page, label: string) {
  await page.getByLabel('選項名稱', { exact: true }).fill(label)
  await page.getByRole('button', { name: '新增', exact: true }).click()
}

test('首頁自製選項：空白、重複、刪除、刷新清空；抽選不送 API', async ({ page }) => {
  await openHome(page)
  const wheel = page.getByRole('region', { name: '自製轉盤', exact: true })
  const requests: string[] = []
  page.on('request', request => {
    if (/\/(api|rest\/v1)\//.test(new URL(request.url()).pathname)) requests.push(request.url())
  })
  await expect(wheel.getByRole('button', { name: '開始轉盤' })).toBeDisabled()
  await addOption(page, '   ')
  await expect(wheel.getByRole('alert')).toHaveText('請輸入選項名稱')
  await addOption(page, ' 火鍋 ')
  await expect(wheel.getByRole('button', { name: '開始轉盤' })).toBeDisabled()
  await addOption(page, '火鍋')
  await expect(wheel.getByRole('alert')).toHaveText('這個選項已經在轉盤上了')
  await addOption(page, '拉麵')
  await expect(wheel.getByRole('listitem')).toHaveCount(2)
  await expect(wheel.getByRole('button', { name: '開始轉盤' })).toBeEnabled()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await wheel.getByRole('button', { name: '開始轉盤' }).click()
  await expect(wheel.getByRole('status')).toContainText('抽中：')
  await wheel.getByRole('button', { name: '刪除 火鍋', exact: true }).click()
  await expect(wheel.getByRole('status')).toHaveText('再加入 1 個選項就能開始')
  await expect(wheel.getByRole('button', { name: '開始轉盤' })).toBeDisabled()
  await expect(page.getByLabel('選項名稱', { exact: true })).toBeFocused()
  await wheel.getByRole('button', { name: '刪除 拉麵', exact: true }).click()
  await expect(wheel.getByRole('listitem')).toHaveCount(0)
  await addOption(page, '便當')
  expect(requests).toEqual([])
  await page.reload()
  await page.locator('summary').filter({ hasText: '自製轉盤' }).click()
  await expect(wheel.getByRole('listitem')).toHaveCount(0)
  await expect(wheel.getByRole('status')).toHaveText('再加入 2 個選項就能開始')
})

test('連續抽選含相同結果均旋轉，盤面指針對準結果，轉動期間不能修改', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openHome(page)
  for (const label of ['火鍋', '拉麵', '便當']) await addOption(page, label)
  const wheel = page.getByRole('region', { name: '自製轉盤', exact: true })
  const disc = page.getByTestId('custom-wheel-disc')
  await page.evaluate(() => {
    const draws = [0, 0, 0.999999, 0.5]
    Math.random = () => draws.shift() ?? 0
  })
  let previous = 0
  for (const [turn, expected] of ['火鍋', '火鍋', '便當', '拉麵'].entries()) {
    await wheel.getByRole('button', { name: turn ? '再轉一次' : '開始轉盤', exact: true }).click()
    await expect(wheel.getByRole('button', { name: '轉動中…', exact: true })).toBeDisabled()
    await expect(page.getByLabel('選項名稱', { exact: true })).toBeDisabled()
    await expect(wheel.getByRole('button', { name: '新增', exact: true })).toBeDisabled()
    await expect(wheel.getByRole('button', { name: '刪除 火鍋', exact: true })).toBeDisabled()
    await expect(disc).toHaveCSS('transition-duration', '3.2s')
    await expect.poll(() => disc.evaluate(el =>
      el.getAnimations().some(animation => animation.playState === 'running'))).toBe(true)
    const rotation = await disc.evaluate(el => Number((el as HTMLElement).style.transform.match(/[\d.]+/)?.[0]))
    expect(rotation - previous).toBeGreaterThanOrEqual(1800)
    previous = rotation
    await expect(wheel.getByRole('status')).toHaveText(`抽中：${expected}`)
    const indexAtPointer = Math.floor(((360 - rotation % 360) % 360) / 120)
    expect(['火鍋', '拉麵', '便當'][indexAtPointer]).toBe(expected)
    await expect(page.getByLabel('選項名稱', { exact: true })).toBeEnabled()
  }
})

test('375px 手機、鍵盤新增、20 項上限與減少動態偏好', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openHome(page)
  const wheel = page.getByRole('region', { name: '自製轉盤', exact: true })
  const input = page.getByLabel('選項名稱', { exact: true })
  await input.fill('長'.repeat(40))
  await input.press('Enter')
  await expect(input).toBeFocused()
  for (let i = 2; i <= 20; i++) await addOption(page, `選項 ${i}`)
  await expect(wheel.getByRole('listitem')).toHaveCount(20)
  await expect(input).toBeDisabled()
  await expect(wheel.getByRole('button', { name: '新增', exact: true })).toBeDisabled()
  expect(await page.locator('html').evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(375)
  await wheel.getByRole('button', { name: '開始轉盤' }).click()
  await expect(wheel.getByRole('status')).toContainText('抽中：')
  await expect(wheel.getByRole('button', { name: '再轉一次' })).toBeEnabled()
  await expect(page.getByTestId('custom-wheel-disc')).toHaveCSS('transition-property', 'none')
  await wheel.getByRole('button', { name: '刪除 選項 20', exact: true }).click()
  await expect(input).toBeEnabled()
  await expect(wheel.getByRole('button', { name: '新增', exact: true })).toBeEnabled()
  await page.screenshot({ path: test.info().outputPath('custom-wheel-mobile.png'), fullPage: true })
})
