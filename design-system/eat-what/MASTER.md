# Design System Master — 今天吃什麼

> 建 page 前先看 `pages/<page>.md`，存在就覆蓋本檔；不存在就照本檔。
> 本檔記錄的是**實際落地在 `web/src/index.css` 的值**，不是工具的原始建議。
> 來源：ui-ux-pro-max（Restaurant/Food Service + Accessible & Ethical），下方「與建議的差異」列出偏離處。

---

**類別：** Restaurant / Food Service（多人決策工具，非行銷官網）
**Dials：** Variance 4（Balanced）| Motion 3（Subtle）| Density 5（Standard）
**Stack：** React 19 + Vite + Tailwind CSS v4（`@theme` token，不用 config 檔）
**模式：** 只做淺色。深色模式未實作。

---

## Color tokens（`web/src/index.css` 的 `@theme`）

| Role | Hex | Tailwind class |
|------|-----|----------------|
| Canvas（頁面底） | `#FFF7ED` | `bg-canvas` |
| Surface（卡片） | `#FFFFFF` | `bg-surface` |
| Foreground | `#0F172A` | `text-fg` |
| Foreground muted | `#475569` | `text-fg-muted` |
| Brand（主要動作） | `#C2410C` | `bg-brand` / `text-brand` |
| Brand strong（hover） | `#9A3412` | `hover:bg-brand-strong` |
| Brand soft（底色/badge） | `#FFEDD5` | `bg-brand-soft` |
| Accent（導航 CTA） | `#2563EB` | `bg-accent` |
| OK / OK soft | `#15803D` / `#DCFCE7` | `text-ok` / `bg-ok-soft` |
| Warn / Warn soft | `#B45309` / `#FEF3C7` | `text-warn` / `bg-warn-soft` |
| Danger / Danger soft | `#B91C1C` / `#FEE2E2` | `text-danger` / `bg-danger-soft` |
| Border | `#F2E3D5` | `border-border` |
| Ring | `#C2410C` | `outline-ring` |

實測對比（瀏覽器計算值，白底與 canvas 底皆測）：全部文字組合 ≥ 4.5:1。
最緊的三組：warn on warn-soft 4.51、brand on brand-soft 4.52、ok on ok-soft 4.57 —
**要再調暗這些 soft 底色前先重測**。

## Typography

- 單一字族，system stack 優先：
  `system-ui, -apple-system, "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Hiragino Sans", sans-serif`
- 拉丁字走 system-ui，中文走 PingFang TC / 微軟正黑；不下載 webfont。
- 內文 16px（輸入框也必須 ≥16px，否則 iOS focus 會自動放大）。
- 機率、邀請碼等數字用 `font-mono`。

## Spacing / Radius / Shadow

| Token | 值 |
|-------|-----|
| 卡片圓角 | `--radius-card: 1rem` → `rounded-card` |
| 按鈕/輸入圓角 | `rounded-xl` |
| 卡片陰影 | `--shadow-card` → `shadow-card` |
| 頁面 padding | `p-4`；卡片內距 `p-4`（結果卡 `p-6`） |
| 區塊間距 | `space-y-4`；表單欄位 `space-y-3` |
| 內容寬度 | 表單頁 `max-w-sm`、首頁 `max-w-md`、房間 `max-w-lg` |

## Component classes（`@layer components`）

| Class | 用途 |
|-------|------|
| `.card` | 白底卡片（圓角＋邊框＋陰影） |
| `.btn` + `.btn-primary` / `.btn-accent` / `.btn-quiet` | 按鈕，`min-h-11`（44px） |
| `.field` | 文字輸入，`min-h-11`、16px |
| `.label` | 欄位標題（`text-sm text-fg-muted`） |
| `.chip` | 可切換的圓角標籤，`min-h-11` |
| `.banner` | inline 訊息條（配 `bg-*-soft` + `text-*`） |
| `.disclosure-chevron` | `<details>` 展開箭頭旋轉 |

## Motion

- 一律 150ms（顏色）/ 320ms（進場 `animate-rise`）；轉盤 4000ms 為刻意的抽選演出。
- 進場只用 `animate-rise`（fade + 8px 上移），不引入 GSAP。
- `prefers-reduced-motion: reduce` → 全域 transition/animation 幾乎歸零，
  且 `Wheel.tsx` 另外把等待時間從 4.2s 縮到 0.7s。

## Icons

`web/src/components/icons.tsx`，手寫 SVG（stroke `currentColor`，line 風格，2px）。
不裝 icon 套件，不用 emoji 當圖示。新增圖示照同一風格加在該檔。

---

## 與工具建議的差異（刻意偏離）

1. **主色由 `#DC2626`/`#EA580C` 改 `#C2410C`** — 前兩者配白字只有 3.5–4.0:1，過不了 AA。
2. **`fg-muted` 由 slate-500 改 slate-600** — slate-500 在 `#FFF7ED` 上只有 4.48:1。
3. **字體不用 Playfair Display / Karla / Atkinson Hyperlegible** — 三者都沒有中日韓字符，
   中文會 fallback 成另一套字，行高與字重全亂。本專案 UI 幾乎全中文，改用系統中文字。
4. **不採用 "App Store Style Landing" pattern** — 這是 app 內部介面，不是行銷落地頁。
5. **不引入 GSAP** — 只有淡入與轉盤兩種動態，CSS transition 就夠。

## Pre-delivery checklist

- [x] 無 emoji 當圖示（全 SVG）
- [x] 可點元素都有 `cursor: pointer`（Tailwind v4 preflight 會把 button 設成 default，已在 base layer 補回）
- [x] hover 有 150ms transition
- [x] 淺色模式文字對比 ≥ 4.5:1
- [x] `:focus-visible` 有 2px outline（未移除預設 focus）
- [x] 尊重 `prefers-reduced-motion`
- [x] 375px 無水平捲動
- [x] 觸控目標 ≥ 44×44px
