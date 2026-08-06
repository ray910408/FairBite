import type { MemberRow } from './types'

export const TRANSPORT_LABELS: Record<MemberRow['transport'], string> = {
  walking: '步行', driving: '開車', transit: '大眾運輸',
}

export const CUISINE_OPTIONS: [string, string][] = [
  ['taiwanese', '台式'], ['japanese', '日式'], ['korean', '韓式'],
  ['cantonese', '港式'], ['western', '西式'], ['indian', '印度'],
  ['sichuan', '川味'], ['hotpot', '火鍋'], ['seafood', '海鮮'], ['ramen', '拉麵'],
]

export const DIETARY_OPTIONS: [string, string][] = [
  ['vegetarian', '素食'], ['no_beef', '不吃牛'], ['no_pork', '不吃豬'], ['halal', '清真'],
]
