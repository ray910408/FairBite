import { useEffect, useState } from 'react'

// 「今天/明天」是相對標籤：頁面開著跨過本地午夜就重畫一次，否則「明天 19:30」過了午夜還掛著。
// +1 秒緩衝確保觸發時已過午夜；每次觸發都換新 tick，effect 會排下一個午夜。
export function useMidnightRerender() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const midnight = new Date()
    midnight.setHours(24, 0, 0, 0)
    const id = setTimeout(() => setTick(t => t + 1), midnight.getTime() - Date.now() + 1000)
    return () => clearTimeout(id)
  }, [tick])
}
