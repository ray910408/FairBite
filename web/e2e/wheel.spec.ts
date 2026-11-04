import { expect, test } from '@playwright/test'

// 抽選結果晚一拍才到時，轉盤掛上去與設定終點角度之間瀏覽器若沒算過一次樣式，
// CSS transition 沒有起點，轉盤直接跳到終點（電腦上偶發「轉盤沒在轉」）。只需 vite dev，不需 Go／Supabase。
test('每次抽選轉盤都真的在轉（transition 有跑起來）', async ({ page }) => {
  await page.goto('/e2e/wheel.html')
  for (let i = 0; i < 20; i++) {
    await page.getByRole('button', { name: '抽選', exact: true }).click()
    await page.getByText('轉盤抽選中…').waitFor()
    // 轉動要 4 秒：300ms 後應仍在 transition 中，且還沒到終點
    await page.waitForTimeout(300)
    const spinning = await page.locator('svg.rounded-full').evaluate(svg =>
      // e2e 的 tsconfig 沒有 DOM lib：CSSTransition 型別寫成結構型別
      svg.getAnimations().some((a: { transitionProperty?: string }) => a.transitionProperty === 'transform'))
    expect(spinning, `第 ${i + 1} 次抽選`).toBe(true)
  }
})
