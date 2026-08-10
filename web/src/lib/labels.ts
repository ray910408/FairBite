import type { MemberRow, Room } from './types'

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

export const EXPLORATION_OPTIONS: [Room['exploration'], string, string][] = [
  ['familiar', '熟悉', '常去的店優先：新店加成關閉，最近去過的降權減半'],
  ['balanced', '平均', '預設的平衡配置'],
  ['explore', '探索', '沒去過的店加成加倍、常中選的店降權，鼓勵換口味'],
]
