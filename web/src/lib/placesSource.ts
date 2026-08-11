// provenance 已升級為逐列欄位（restaurants.source，migration 0013）——
// 判斷以資料庫欄位為準，不再 sniff place_id 的 mock- 前綴。
export function isGoogleSourced(source: string): boolean {
  return source === 'google'
}
