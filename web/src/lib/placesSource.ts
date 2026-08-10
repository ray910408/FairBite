// mock place_ids 是目前唯一的非 Google 來源；若增加 provider，應升級為逐列 provenance 欄位。
export function isGoogleSourced(placeId: string): boolean {
  return !placeId.startsWith('mock-')
}
