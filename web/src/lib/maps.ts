export function buildMapsUrl(
  lat: number, lng: number, placeId: string,
  transport: 'walking' | 'driving' | 'transit',
): string {
  const q = new URLSearchParams({
    api: '1',
    destination: `${lat},${lng}`,
    travelmode: transport,
  })
  // mock id 不是真 Google Place ID，塞進去會讓導航行為不定 → 純座標導航
  if (placeId && !placeId.startsWith('mock-')) q.set('destination_place_id', placeId)
  return `https://www.google.com/maps/dir/?${q.toString()}`
}
