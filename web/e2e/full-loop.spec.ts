import { expect, test, type Page } from '@playwright/test'

// 雙使用者完整閉環：註冊 → 建房/加入 → 探索檔位 → 條件 → 搜尋 →
// 開始投票 → 贊成/否決/收回 → 額度與全否決防線 → 抽選 → 結果同步
const run = Date.now()

function waitForRoomRealtime(page: Page) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('room Realtime subscription timed out')), 10_000)
    page.on('websocket', socket => {
      socket.on('framereceived', ({ payload }) => {
        const frame = payload.toString()
        if (frame.includes('realtime:room-') && frame.includes('"phx_reply"') &&
          frame.includes('"status":"ok"')) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
  })
}

async function signup(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: '註冊', exact: true }).click()
  await page.getByLabel('顯示名稱').fill(name)
  await page.getByLabel('Email').fill(`e2e-${name}-${run}@test.dev`)
  await page.getByLabel('密碼').fill('e2e-password-123')
  await page.getByRole('button', { name: '建立帳號' }).click()
  await expect(page.getByRole('button', { name: '建立房間' })).toBeVisible()
}

async function setMaximumsAndReady(page: Page) {
  await page.getByRole('slider', { name: /每人預算上限/ }).fill('1600')
  await expect(page.getByText('NT$1600', { exact: true })).toBeVisible()
  await page.getByRole('slider', { name: /可接受距離/ }).fill('3000')
  await expect(page.getByText('3000 公尺', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '我準備好了' }).click()
  await expect(page.getByRole('button', { name: '已準備（點擊取消）' })).toBeVisible()
}

function votingCard(page: Page, restaurantName: string) {
  return page.locator('div.card')
    .filter({ has: page.getByText(restaurantName, { exact: true }) })
    .filter({ has: page.getByRole('button', { name: /^👍 贊成/ }) })
}

function excludedRow(page: Page, restaurantName: string) {
  return page.locator('details li')
    .filter({ has: page.getByText(restaurantName, { exact: true }) })
}

function quota(page: Page, remaining: number) {
  return page.getByText(`否決額度 ${remaining}/2（可收回）`, { exact: true })
}

async function castVeto(page: Page, restaurantName: string, memberName: string) {
  await votingCard(page, restaurantName)
    .getByRole('button', { name: '否決', exact: true }).click()
  await expect(excludedRow(page, restaurantName)
    .getByText(`遭 ${memberName} 否決（可收回）`, { exact: true })).toBeVisible()
}

async function retractVeto(page: Page, restaurantName: string) {
  await excludedRow(page, restaurantName)
    .getByRole('button', { name: '收回否決', exact: true }).click()
  await expect(votingCard(page, restaurantName)).toBeVisible()
  await expect(excludedRow(page, restaurantName)).toHaveCount(0)
}

test('雙使用者完整閉環（投票版）', async ({ browser }) => {
  const ctxA = await browser.newContext({ permissions: [] }) // 拒絕定位 → fallback 台北車站
  const ctxB = await browser.newContext({ permissions: [] })
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  try {
    await signup(a, 'hostA')
    await signup(b, 'memberB')

    // A 建房、取十二碼邀請碼（header 上等寬字按鈕）
    const aRealtimeReady = waitForRoomRealtime(a)
    await a.getByRole('button', { name: '建立房間' }).click()
    await expect(a.getByText('成員（1）')).toBeVisible()
    await aRealtimeReady
    const code = (await a.locator('header button.font-mono').innerText()).trim()
    expect(code).toMatch(/^[A-Z0-9]{12}$/)

    // B 以邀請碼加入；雙方都看到 2 位成員
    const bRealtimeReady = waitForRoomRealtime(b)
    await b.getByLabel('邀請碼').fill(code)
    await b.getByRole('button', { name: '加入', exact: true }).click()
    await expect(b.getByText('成員（2）')).toBeVisible()
    await bRealtimeReady
    await expect(a.getByText('成員（2）')).toBeVisible()

    // D10 #3：房主切到探索；成員同步看到狀態與說明，且不能更改。
    await a.getByRole('button', { name: '探索', exact: true }).click()
    const memberExplore = b.getByRole('button', { name: '探索', exact: true })
    await expect(memberExplore).toHaveAttribute('aria-pressed', 'true')
    await expect(b.getByText('最近去過的店降更多，鼓勵換口味（由房主設定）', { exact: true })).toBeVisible()
    for (const label of ['熟悉', '平均', '探索']) {
      await expect(b.getByRole('button', { name: label, exact: true })).toBeDisabled()
    }

    // 開店時段會隨測試執行時間改變；兩人皆將預算與距離拉到最大。
    await setMaximumsAndReady(a)
    await setMaximumsAndReady(b)
    await expect(a.getByText('已準備', { exact: true })).toHaveCount(2)

    // A 搜尋 → 兩邊同步看到候選；先記住餐廳名，後續投票定位不依賴排序。
    await a.getByRole('button', { name: '開始搜尋餐廳' }).click()
    const candidateHeadingA = a.getByText(/候選餐廳（\d+）/)
    const candidateHeadingB = b.getByText(/候選餐廳（\d+）/)
    await expect(candidateHeadingA).toBeVisible()
    await expect(candidateHeadingB).toBeVisible()
    const restaurantNames = await b
      .locator('div.card.animate-rise.space-y-2.p-3 span.flex-1.font-semibold')
      .allInnerTexts()
    const keptCount = restaurantNames.length
    expect(keptCount).toBeGreaterThan(0)
    await expect(candidateHeadingA).toHaveText(`候選餐廳（${keptCount}）`)
    await expect(candidateHeadingB).toHaveText(`候選餐廳（${keptCount}）`)
    console.log(`[task-13] runtime kept count: ${keptCount}`)

    // A 開始投票 → B 在已命名卡片上看到投票控制。
    await a.getByRole('button', { name: '開始投票' }).click()
    const upName = restaurantNames[0]
    await expect(votingCard(b, upName)
      .getByRole('button', { name: '👍 贊成', exact: true })).toBeVisible()

    // B 對指定餐廳投贊成 → A 在同名卡片看到真實按鈕文案與票數。
    await votingCard(b, upName)
      .getByRole('button', { name: '👍 贊成', exact: true }).click()
    await expect(votingCard(a, upName)
      .getByRole('button', { name: '👍 贊成（1）', exact: true })).toBeVisible()

    // B 否決第二家；若執行時僅一間開店，誠實改用唯一候選完成同一循環。
    const cycleName = restaurantNames[1] ?? restaurantNames[0]
    await castVeto(b, cycleName, 'memberB')
    await expect(excludedRow(a, cycleName)
      .getByText('遭 memberB 否決（可收回）', { exact: true })).toBeVisible()
    await retractVeto(b, cycleName)
    await expect(votingCard(a, cycleName)).toBeVisible()

    // D10 #1：候選足夠時用滿 B 的兩個否決額度；否則驗證唯一可達變體。
    let quotaVariant: string
    if (keptCount >= 2) {
      await castVeto(b, restaurantNames[0], 'memberB')
      await castVeto(b, restaurantNames[1], 'memberB')
      await expect(quota(b, 0)).toBeVisible()
      if (keptCount > 2) {
        for (const name of restaurantNames.slice(2)) {
          await expect(votingCard(b, name)
            .getByRole('button', { name: '否決', exact: true })).toBeDisabled()
        }
        quotaVariant = 'quota-exhausted-with-disabled-remaining-cards'
      } else {
        quotaVariant = 'quota-exhausted-with-no-remaining-card'
      }
      await retractVeto(b, restaurantNames[0])
      await expect(quota(b, 1)).toBeVisible()
      await expect(votingCard(b, restaurantNames[0])
        .getByRole('button', { name: '否決', exact: true })).toBeEnabled()
      await retractVeto(b, restaurantNames[1])
      await expect(quota(b, 2)).toBeVisible()
    } else {
      await castVeto(b, restaurantNames[0], 'memberB')
      await expect(quota(b, 1)).toBeVisible()
      quotaVariant = 'single-candidate-quota-partial'
      await retractVeto(b, restaurantNames[0])
      await expect(quota(b, 2)).toBeVisible()
      await expect(votingCard(b, restaurantNames[0])
        .getByRole('button', { name: '否決', exact: true })).toBeEnabled()
    }
    console.log(`[task-13] D10 quota variant: ${quotaVariant}`)

    // D10 #2：四個額度能覆蓋時驗證全否決防線；否則驗證可達的部分否決變體。
    const allVetoBanner = '候選已全數被否決，需有人收回否決才能抽選'
    let allVetoVariant: string
    if (keptCount <= 4) {
      const bNames = restaurantNames.slice(0, Math.min(2, keptCount))
      const aNames = restaurantNames.slice(bNames.length)
      for (const name of bNames) await castVeto(b, name, 'memberB')
      for (const name of aNames) await castVeto(a, name, 'hostA')

      await expect(a.getByText(allVetoBanner, { exact: true })).toBeVisible()
      await expect(b.getByText(allVetoBanner, { exact: true })).toBeVisible()
      await expect(a.getByRole('button', { name: '啟動轉盤' })).toBeDisabled()

      await retractVeto(b, bNames[0])
      await expect(a.getByText(allVetoBanner, { exact: true })).toHaveCount(0)
      await expect(b.getByText(allVetoBanner, { exact: true })).toHaveCount(0)
      await expect(a.getByRole('button', { name: '啟動轉盤' })).toBeEnabled()
      allVetoVariant = 'full-all-veto-block-and-retract'
    } else {
      for (const name of restaurantNames.slice(0, 2)) await castVeto(b, name, 'memberB')
      for (const name of restaurantNames.slice(2, 4)) await castVeto(a, name, 'hostA')

      await expect(a.getByText(allVetoBanner, { exact: true })).toHaveCount(0)
      await expect(b.getByText(allVetoBanner, { exact: true })).toHaveCount(0)
      await expect(a.getByRole('button', { name: '啟動轉盤' })).toBeEnabled()
      allVetoVariant = 'partial-veto-no-banner-candidate-count-over-four'
    }
    console.log(`[task-13] D10 all-veto variant: ${allVetoVariant}`)

    // A 啟動轉盤 → 兩邊最終都看到真實結果卡導航文字。
    await a.getByRole('button', { name: '啟動轉盤' }).click()
    const navigationName = /^用 Google Maps 導航（.+）$/
    await expect(a.getByRole('link', { name: navigationName })).toBeVisible({ timeout: 30_000 })
    await expect(b.getByRole('link', { name: navigationName })).toBeVisible({ timeout: 30_000 })
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
