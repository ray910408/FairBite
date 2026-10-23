import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build, type Rolldown } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 真的跑一次 vite build（不寫檔），檢查產物 index.html 的 CSP：plugin 有沒有套上、inline script 雜湊對不對得上。
// 瀏覽器算雜湊前會把 CRLF 正規化成 LF，這裡照同樣規則重算
async function builtHtml(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const result = await build({ root: fileURLToPath(new URL('.', import.meta.url)), logLevel: 'silent', build: { write: false } })
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
  const page = outputs.flatMap(o => o.output).find(file => file.fileName === 'index.html')
  if (page?.type !== 'asset') throw new Error('build 沒有產出 index.html')
  const html = String(page.source)
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? ''
  const directives = new Map(policy.split('; ').map(d => {
    const [name, ...values] = d.split(' ')
    return [name, values]
  }))
  const js = outputs.flatMap(o => o.output).map(file => file.type === 'chunk' ? file.code : '').join('\n')
  return { html, directives, js }
}

afterEach(() => vi.unstubAllEnvs())

describe('build 產物的 Content-Security-Policy', () => {
  it('放行全部 inline script、外連只到設定的 Supabase／API 與 Nominatim', async () => {
    const { html, directives } = await builtHtml({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_API_URL: 'https://api.example.com',
    })

    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(([, body]) =>
      `'sha256-${createHash('sha256').update(body.replace(/\r\n?/g, '\n')).digest('base64')}'`)
    expect(inline).toHaveLength(2) // 主題／字級、標題字型
    expect(directives.get('script-src')).toEqual(["'self'", ...inline])
    expect(directives.get('connect-src')).toEqual(["'self'", 'https://example.supabase.co', 'wss://example.supabase.co',
      'https://api.example.com', 'https://nominatim.openstreetmap.org'])
    expect(directives.get('object-src')).toEqual(["'none'"])
    // CSP 要在任何 script 之前生效；inline 事件屬性（onload= 等）不在雜湊範圍內，會被擋
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'))
    expect(html).not.toMatch(/<[^>]+\son[a-z]+=/i)
  }, 60_000)

  // style-src 沒有 'unsafe-inline'：HTML 的 style=""、setAttribute('style')、innerHTML 字串裡的 style= 都會被擋，
  // 只有 CSSOM（React 的 style prop、Leaflet 的 el.style.x）能用。CSP 只在 build 注入，dev 與 E2E 看不到，這裡守住
  it('產物不靠 style 屬性設樣式', async () => {
    const { html, directives, js } = await builtHtml({ VITE_SUPABASE_URL: 'https://example.supabase.co' })
    expect(directives.get('style-src')).not.toContain("'unsafe-inline'")
    expect(js).toContain('.style.') // 確認掃到的是含 React／Leaflet 的完整產物
    expect(html).not.toMatch(/<[^>]+\sstyle=/i)
    expect(js).not.toMatch(/setAttribute\(\s*["']style["']|style=\\?["']/)
  }, 60_000)

  it('相對路徑（本機 proxy）退回同源', async () => {
    const { directives } = await builtHtml({ VITE_SUPABASE_URL: '/supabase', VITE_API_URL: '/' })
    expect(directives.get('connect-src')).toEqual(["'self'", 'https://nominatim.openstreetmap.org'])
  }, 60_000)
})
