import { expect, test, type Page } from '@playwright/test'

// 雙使用者完整閉環：註冊 → 建房/加入 → 探索檔位 → 條件 → 搜尋 →
// 開始投票 → 贊成/否決/收回 → 額度與全否決防線 → 抽選 → 結果同步
const run = Date.now()

function roomRealtimeReady(payload: string | Buffer) {
  let decoded: unknown
  try {
    decoded = JSON.parse(payload.toString())
  } catch {
    return false
  }
  const message = Array.isArray(decoded)
    ? { topic: decoded[2], event: decoded[3], payload: decoded[4] }
    : decoded as Record<string, unknown>
  const body = message.payload as { extension?: unknown; status?: unknown } | undefined
  return typeof message.topic === 'string' && message.topic.startsWith('realtime:room-') &&
    message.event === 'system' && body?.extension === 'postgres_changes' && body.status === 'ok'
}

function waitForRoomRealtime(page: Page) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('room Realtime subscription timed out')), 10_000)
    page.on('websocket', socket => {
      socket.on('framereceived', ({ payload }) => {
        if (roomRealtimeReady(payload)) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
  })
}

// 今日限定的自訂用餐時間：晚間執行時退回「馬上出發」，避免 mock 營業池縮水與跨日 flaky
function mealTimeForE2E(now = new Date()): string | null {
  const t = new Date(Math.min(now.getTime() + 2 * 60 * 60 * 1000,
    new Date(now).setHours(20, 0, 0, 0)))
  t.setMinutes(Math.floor(t.getMinutes() / 5) * 5, 0, 0)
  // +60s 緩衝：t 與 now 的瞬時比較在每日 19:55–20:00 有數秒級 flaky 窗口（Round 1 遞延）
  if (t.getTime() <= now.getTime() + 60_000) return null
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
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

async function createAndJoinRoom(a: Page, b: Page) {
  const aRealtimeReady = waitForRoomRealtime(a)
  await a.getByRole('button', { name: '選擇出發點' }).click()
  await a.getByRole('button', { name: '使用目前位置' }).click()
  await expect(a.getByText('目前位置', { exact: true })).toBeVisible()
  await expect(a.locator('.leaflet-container')).toBeVisible()
  await a.getByRole('button', { name: '完成' }).click()
  const hhmm = mealTimeForE2E()
  if (hhmm) {
    await a.getByRole('button', { name: '自訂時間' }).click()
    const [hh, mm] = hhmm.split(':')
    await a.getByLabel('用餐時間（時）').selectOption(hh)
    await a.getByLabel('用餐時間（分）').selectOption(mm)
  }
  await a.getByRole('button', { name: '建立房間' }).click()
  await expect(a.getByText('成員（1）')).toBeVisible()
  await aRealtimeReady
  const code = (await a.locator('header button.font-mono').innerText()).trim()
  expect(code).toMatch(/^[A-Z0-9]{12}$/)

  const bRealtimeReady = waitForRoomRealtime(b)
  await b.getByLabel('邀請碼').fill(code)
  await b.getByRole('button', { name: '加入', exact: true }).click()
  await expect(b.getByText('成員（2）')).toBeVisible()
  await bRealtimeReady
  await expect(a.getByText('成員（2）')).toBeVisible()
  const expected = hhmm ? `今天 ${hhmm}` : '馬上出發'
  await expect(b.getByText(expected)).toBeVisible() // meal_time 經 Realtime 同步到加入方
}

test('Realtime subscription readiness guard waits for postgres_changes system OK', () => {
  const topic = 'realtime:room-test'
  const joinAck = JSON.stringify([null, '1', topic, 'phx_reply', { status: 'ok', response: {} }])
  const systemReady = JSON.stringify([null, null, topic, 'system', {
    extension: 'postgres_changes', status: 'ok', message: 'Subscribed to PostgreSQL',
  }])

  expect(roomRealtimeReady(joinAck)).toBe(false)
  expect(roomRealtimeReady(systemReady)).toBe(true)
})

// Round 5（ADR-0007 2026-08-16 修訂）：回首頁不再靜默退房——HomePage mount 查到房籍
// 就跳確認，按下「離開房間」才真的退。「加入」只由 leavePending 閘門控制（「建立房間」
// 還要有出發點，加入方沒有），拿它當 settle 訊號對兩邊都成立。
async function leaveViaHome(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '離開房間' }).click()
  await expect(page.getByRole('button', { name: '加入', exact: true })).toBeEnabled()
}

// 焦點含納的唯一真實驗證點（inert 只有真瀏覽器實作，jsdom 沒有）：
// 回傳「背景那顆按鈕能不能拿到焦點」——dialog 開著時必須是 false
// 用 CSS locator 而非 getByRole：inert 子樹會從 a11y 樹消失，用 role 找會找不到而逾時
function canFocusBackground(page: Page, label: string) {
  return page.locator('button').filter({ hasText: label }).first().evaluate(btn => {
    btn.focus()
    return btn.ownerDocument.activeElement === btn
  })
}

async function setConditions(page: Page, budget: number) {
  await page.getByRole('slider', { name: /每人預算上限/ }).fill(String(budget))
  await expect(page.getByText(`NT$${budget}`, { exact: true })).toBeVisible()
  await page.getByRole('slider', { name: /距離偏好/ }).fill('3000')
  await expect(page.getByText('3000 公尺', { exact: true })).toBeVisible()
}

async function setConditionsAndReady(page: Page, budget: number) {
  await setConditions(page, budget)
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
  const ctxA = await browser.newContext({
    geolocation: { latitude: 25.0478, longitude: 121.517 },
    permissions: ['geolocation'],
  })
  const ctxB = await browser.newContext({ permissions: [] })
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  try {
    await signup(a, 'hostA')
    await signup(b, 'memberB')

    // A 建房、B 以十二碼邀請碼加入；雙方都看到 2 位成員。
    await createAndJoinRoom(a, b)

    // D10 #3：房主切到探索；成員同步看到狀態與說明，且不能更改。
    await a.getByRole('button', { name: '探索', exact: true }).click()
    const memberExplore = b.getByRole('button', { name: '探索', exact: true })
    await expect(memberExplore).toHaveAttribute('aria-pressed', 'true')
    await expect(b.getByText('沒去過的店加成加倍、常中選的店降權，鼓勵換口味（由房主設定）', { exact: true })).toBeVisible()
    for (const label of ['熟悉', '平均', '探索']) {
      await expect(b.getByRole('button', { name: label, exact: true })).toBeDisabled()
    }

    // BUG-007：guest Ready 先完成；room write 與 host condition flush 再分開驗證。
    const durabilityEvents: string[] = []
    await b.route('**/rest/v1/room_members**', async route => {
      const request = route.request()
      if (request.method() !== 'PATCH') return route.continue()
      const payload = request.postDataJSON() as Record<string, unknown>
      const kind = Object.hasOwn(payload, 'ready') ? 'ready' : 'conditions'
      durabilityEvents.push(`guest-${kind}:start`)
      await new Promise(resolve => setTimeout(resolve, 250))
      const response = await route.fetch()
      durabilityEvents.push(`guest-${kind}:complete`)
      await route.fulfill({ response })
    })

    // 先完成 guest conditions → Ready，避免 host debounce 在 guest 流程等待期間偷跑完。
    await setConditionsAndReady(b, 1600)
    await expect(a.getByText('已準備', { exact: true })).toHaveCount(1)

    let searchRequestCount = 0
    a.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/search')) {
        searchRequestCount++
        durabilityEvents.push('search:start')
      }
    })
    const search = a.getByRole('button', { name: '開始搜尋餐廳' })

    // room-setting gate 獨立驗證：PATCH 未釋放時按鈕 disabled 且沒有 search POST。
    let roomSettingStartedResolve!: () => void
    let releaseRoomSetting!: () => void
    let roomSettingCompleteResolve!: () => void
    const roomSettingStarted = new Promise<void>(resolve => { roomSettingStartedResolve = resolve })
    const roomSettingRelease = new Promise<void>(resolve => { releaseRoomSetting = resolve })
    const roomSettingComplete = new Promise<void>(resolve => { roomSettingCompleteResolve = resolve })
    await a.route('**/rest/v1/rooms**', async route => {
      const request = route.request()
      if (request.method() !== 'PATCH') return route.continue()
      durabilityEvents.push('room-setting:start')
      roomSettingStartedResolve()
      await roomSettingRelease
      const response = await route.fetch()
      durabilityEvents.push('room-setting:complete')
      await route.fulfill({ response })
      roomSettingCompleteResolve()
    })
    await a.getByRole('button', { name: '開啟', exact: true }).click()
    await roomSettingStarted
    await expect(search).toBeDisabled()
    expect(searchRequestCount).toBe(0)
    releaseRoomSetting()
    await roomSettingComplete
    await expect(search).toBeEnabled()

    // 再 hold host condition PATCH；搜尋鈕本身可點，但 handler 必須 await child flush。
    let hostConditionStartedResolve!: () => void
    let releaseHostCondition!: () => void
    let hostConditionCompleteResolve!: () => void
    const hostConditionStarted = new Promise<void>(resolve => { hostConditionStartedResolve = resolve })
    const hostConditionRelease = new Promise<void>(resolve => { releaseHostCondition = resolve })
    const hostConditionComplete = new Promise<void>(resolve => { hostConditionCompleteResolve = resolve })
    await a.route('**/rest/v1/room_members**', async route => {
      const request = route.request()
      if (request.method() !== 'PATCH') return route.continue()
      const payload = request.postDataJSON() as Record<string, unknown>
      if (Object.hasOwn(payload, 'ready')) return route.continue()
      durabilityEvents.push('host-conditions:start')
      hostConditionStartedResolve()
      await hostConditionRelease
      const response = await route.fetch()
      durabilityEvents.push('host-conditions:complete')
      await route.fulfill({ response })
      hostConditionCompleteResolve()
    })
    await setConditions(a, 1600)
    await expect(search).toBeEnabled()
    await search.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await hostConditionStarted
    expect(searchRequestCount).toBe(0)
    releaseHostCondition()
    await hostConditionComplete

    const candidateHeadingA = a.getByText(/候選餐廳（\d+）/)
    const candidateHeadingB = b.getByText(/候選餐廳（\d+）/)
    await expect(candidateHeadingA).toBeVisible()
    await expect(candidateHeadingB).toBeVisible()
    expect(searchRequestCount).toBe(1)
    const eventIndex = (event: string) => {
      const index = durabilityEvents.indexOf(event)
      expect(index, `${event} missing from ${durabilityEvents.join(', ')}`).toBeGreaterThanOrEqual(0)
      return index
    }
    expect(eventIndex('guest-conditions:complete')).toBeLessThan(eventIndex('guest-ready:start'))
    expect(eventIndex('guest-ready:complete')).toBeLessThan(eventIndex('search:start'))
    expect(eventIndex('host-conditions:complete')).toBeLessThan(eventIndex('search:start'))
    expect(eventIndex('room-setting:complete')).toBeLessThan(eventIndex('search:start'))
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
    await expect(votingCard(a, upName).getByText(/1 張贊成票/)).toBeVisible()

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
      for (const name of restaurantNames.slice(0, 2)) await castVeto(a, name, 'hostA')
      const remoteVetoes = restaurantNames.slice(2, 4)
      for (const name of remoteVetoes) await castVeto(b, name, 'memberB')

      // 先確認最後一票已透過 Realtime 傳到 A，再驗證穩態 UI，避免在傳播前假通過。
      await expect(excludedRow(a, remoteVetoes[remoteVetoes.length - 1])).toBeVisible()
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

    // 店名先取（eng review C6）：B 段的 RLS 斷言需要它
    const winnerName = (await a.locator('div.card').filter({ hasText: '今天就吃' })
      .getByRole('heading').textContent())?.trim() ?? ''
    expect(winnerName).not.toBe('')

    // P3 餐後評分觸點（OV#24 雙觸點自 Round 2 起擴為三處）：A 的寫入改在足跡頁
    // （StarRow 已共用，同一寫入路徑）；房內 RatingPrompt 改驗已評靜態回讀；
    // B 維持首頁「最近 1 筆未評」提示評 5 星。
    // Round 4（ADR-0007）：B 回首頁即退房。eng review C6：settle 後 reload 再斷言
    // 《店名》全文——prompt 查詢必然發生在退房 commit 之後，且 fallback「上一餐」
    // 騙不過全文比對，這才是 0022 RLS 條款的 E2E 證據。
    await leaveViaHome(b) // 確認後才退房、settle 才繼續
    await b.reload()
    await expect(b.getByText(`上次吃的《${winnerName}》滿意嗎？`)).toBeVisible()
    await b.getByRole('button', { name: '5 顆星' }).click()
    await expect(b.getByText(/滿意嗎？/)).toBeHidden()
    await b.reload()
    await expect(b.getByText(/滿意嗎？/)).toBeHidden()

    // Round 2 足跡頁閉環：Round 4 起 A 改走房內足跡入口（不經首頁、不觸發退房）。
    const roomUrl = a.url()
    await a.getByRole('link', { name: '足跡' }).click()
    await expect(a.getByRole('heading', { name: '足跡' })).toBeVisible()
    const firstRow = a.getByRole('listitem').first()
    await expect(firstRow).toContainText(winnerName)
    // 未評列預設收合為 chip，點擊展開 StarRow（design review D4）
    await firstRow.getByRole('button', { name: '尚未評分 · 補評' }).click()
    await firstRow.getByRole('button', { name: '4 顆星' }).click()
    await expect(firstRow.getByLabel('已評 4 顆星')).toBeVisible()
    // hero 彙總卡：主數字「1 餐」驗 count:'exact' 接線；已評行驗本地補列重算
    await expect(a.getByText(/^1 餐$/)).toBeVisible()
    await expect(a.getByText('已評 1 筆 · 平均 4.0 ★')).toBeVisible()
    // 房內 RatingPrompt 的已評靜態分支：goBack 一次回房（history 由房內進入）
    await a.goBack()
    // 回房是真重載：轉盤重播 SPIN_MS+200≈4.2s 後 RatingPrompt 才回讀，預設 10s expect 預算吃掉近半——放寬（final review）
    await expect(a.getByText('已評分 4 顆星')).toBeVisible({ timeout: 15_000 })

    // Round 4 退房全鏈：A（末位成員）回首頁 → 房被刪 → 重訪房間 URL 得 not-found。
    await leaveViaHome(a)
    await a.goto(roomUrl)
    await expect(a.getByText('找不到房間，或你不是成員')).toBeVisible()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})

test('全否決擋抽選（嚴格條件房）', async ({ browser }) => {
  const ctxA = await browser.newContext({
    geolocation: { latitude: 25.0478, longitude: 121.517 },
    permissions: ['geolocation'],
  })
  const ctxB = await browser.newContext({ permissions: [] })
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()

  try {
    await signup(a, 'strictHostA')
    await signup(b, 'strictMemberB')
    await createAndJoinRoom(a, b)

    await setConditions(a, 1600)
    // Slider minimum NT$100 only admits price level 0 (PriceLevelMaxTWD[0] == 100).
    await setConditionsAndReady(b, 100)
    await expect(a.getByText('已準備', { exact: true })).toHaveCount(1)

    const searchResponsePromise = a.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().endsWith('/search'))
    await a.getByRole('button', { name: '開始搜尋餐廳' }).click()
    const searchResponse = await searchResponsePromise
    if (searchResponse.status() === 422) {
      const body = await searchResponse.json().catch(() => null) as { error?: string } | null
      if (body?.error === 'no_candidates') {
        const reason = '嚴格條件房在目前時段沒有營業中的平價候選'
        console.log(`[task-13-strict] ${reason}; runtime search returned 422 no_candidates`)
        test.skip(true, reason)
      }
    }
    expect(searchResponse.status()).toBe(200)

    const candidateHeadingA = a.getByText(/候選餐廳（\d+）/)
    const candidateHeadingB = b.getByText(/候選餐廳（\d+）/)
    await expect(candidateHeadingA).toBeVisible()
    await expect(candidateHeadingB).toBeVisible()
    const restaurantNames = await b
      .locator('div.card.animate-rise.space-y-2.p-3 span.flex-1.font-semibold')
      .allInnerTexts()
    const keptCount = restaurantNames.length
    expect(keptCount).toBeGreaterThan(0)
    expect(keptCount).toBeLessThanOrEqual(4)
    await expect(candidateHeadingA).toHaveText(`候選餐廳（${keptCount}）`)
    await expect(candidateHeadingB).toHaveText(`候選餐廳（${keptCount}）`)
    console.log(`[task-13-strict] runtime kept count: ${keptCount}`)

    await a.getByRole('button', { name: '開始投票' }).click()
    await expect(votingCard(b, restaurantNames[0])
      .getByRole('button', { name: '否決', exact: true })).toBeVisible()

    const bNames = restaurantNames.slice(0, Math.min(2, keptCount))
    const aNames = restaurantNames.slice(bNames.length)
    for (const name of bNames) await castVeto(b, name, 'strictMemberB')
    for (const name of aNames) await castVeto(a, name, 'strictHostA')

    const allVetoBanner = '候選已全數被否決，需有人收回否決才能抽選'
    await expect(a.getByText(allVetoBanner, { exact: true })).toBeVisible()
    await expect(b.getByText(allVetoBanner, { exact: true })).toBeVisible()
    await expect(a.getByRole('button', { name: '啟動轉盤' })).toBeDisabled()

    await retractVeto(b, bNames[0])
    await expect(a.getByText(allVetoBanner, { exact: true })).toHaveCount(0)
    await expect(b.getByText(allVetoBanner, { exact: true })).toHaveCount(0)
    await expect(a.getByRole('button', { name: '啟動轉盤' })).toBeEnabled()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})

// Round 4（ADR-0007）：房主回首頁＝退房，joined_at 最早者繼任；
// 驗留房者 UI 的 Realtime 膠水——搜尋鈕浮現、成員數縮減、ready 鈕消失（isHost 重算）。
test('房主繼任（lobby 中房主回首頁）', async ({ browser }) => {
  const ctxA = await browser.newContext({
    geolocation: { latitude: 25.0478, longitude: 121.517 },
    permissions: ['geolocation'],
  })
  const ctxB = await browser.newContext({ permissions: [] })
  try {
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    await Promise.all([signup(a, 'suc-hostA'), signup(b, 'suc-memberB')])
    await createAndJoinRoom(a, b)
    // 繼任前：B 是普通成員——有 ready 鈕、無房主搜尋鈕
    await expect(b.getByRole('button', { name: '我準備好了' })).toBeVisible()
    await expect(b.getByRole('button', { name: '開始搜尋餐廳' })).toHaveCount(0)
    // readiness 成為 search invariant 後，先讓 B ready，房主搜尋鈕才是可聚焦的背景控制項。
    await b.getByRole('button', { name: '我準備好了' }).click()
    await expect(a.getByText('已準備', { exact: true })).toHaveCount(1)
    // Round 5（Codex P2）：dialog 開著時背景整塊 inert——fixed 遮罩只擋得住指標，
    // 擋不住 tab 順序。開啟前後各量一次，證明斷言不是恆為 false 的空話。
    expect(await canFocusBackground(a, '開始搜尋餐廳')).toBe(true)
    await a.getByRole('link', { name: '回首頁' }).click()
    await expect(a.getByRole('dialog')).toBeVisible() // 房籍重查是非同步的，等它開
    expect(await canFocusBackground(a, '開始搜尋餐廳')).toBe(false)
    await a.getByRole('button', { name: '取消' }).click()
    await expect(a.getByRole('dialog')).toHaveCount(0)
    expect(await canFocusBackground(a, '開始搜尋餐廳')).toBe(true)

    // 房主回首頁＝退房（Round 5 起須確認）
    await leaveViaHome(a)
    // B 繼任：房主控制項浮現、成員數 2→1、ready 鈕消失（ConditionsForm isHost 分支）
    await expect(b.getByRole('button', { name: '開始搜尋餐廳' })).toBeVisible({ timeout: 10_000 })
    await expect(b.getByText('成員（1）')).toBeVisible()
    await expect(b.getByRole('button', { name: '我準備好了' })).toHaveCount(0)
    // 末位退房收尾（eng review C7）：不留永久房污染本地 DB，順帶再走一次末位刪房鏈
    await leaveViaHome(b) // settle 後房已刪
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
