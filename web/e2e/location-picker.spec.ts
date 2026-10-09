import { expect, test } from '@playwright/test'

// Leaflet 1.9 的 map.remove() 不取消縮放動畫的 250ms setTimeout；動畫中收起選點器時，
// 計時器會讀已刪除的 _mapPane 而丟 `_leaflet_pos` TypeError。只需 vite dev，不需 Go／Supabase。
test('地圖縮放動畫中按完成收起，不丟 _leaflet_pos 錯誤', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('https://tile.openstreetmap.org/**', route => route.abort())
  await page.goto('/e2e/location-picker.html')
  await page.getByRole('button', { name: '選擇出發點', exact: true }).click()
  await page.locator('.leaflet-marker-icon').waitFor()

  // 點地圖 → value 更新 → setView(…, 16) 從 15 動畫縮放；同一 frame 偵測到動畫就按完成，確保落在 250ms 窗口內
  await page.locator('.leaflet-container').click({ position: { x: 250, y: 150 } })
  const closedMidZoom = await page.getByRole('button', { name: '完成', exact: true }).evaluate(done =>
    new Promise<boolean>(resolve => {
      let frames = 0
      const tick = () => {
        if (done.ownerDocument.querySelector('.leaflet-zoom-anim')) {
          done.click()
          resolve(true)
        } else if (++frames > 30) resolve(false)
        else done.ownerDocument.defaultView!.requestAnimationFrame(tick)
      }
      tick()
    }))
  expect(closedMidZoom).toBe(true)
  await expect(page.locator('.leaflet-container')).toHaveCount(0)
  await page.waitForTimeout(500) // 越過 Leaflet 的 250ms 計時器
  expect(errors).toEqual([])
})
