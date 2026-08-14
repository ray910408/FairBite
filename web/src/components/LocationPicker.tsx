import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap, Marker } from 'leaflet'
import { getPosition } from '../lib/geolocation'
import { searchPlaces, type DeparturePoint } from '../lib/departure'
import { Spinner } from './icons'
import { mapSelectionLabel } from './locationPickerLabel'

const DEFAULT_CENTER = { lat: 25.0478, lng: 121.517 } // 台北車站：純地圖顯示預設，不寫入資料

type Props = {
  value: DeparturePoint | null
  onChange: (p: DeparturePoint) => void
}

export default function LocationPicker({ value, onChange }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DeparturePoint[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const mapEl = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const selectionGen = useRef(0)
  const valueRef = useRef(value)
  const anchorRef = useRef<{ lat: number; lng: number } | null>(null)
  const lastLabelRef = useRef<string | null>(null)
  valueRef.current = value

  // 展開時才載 Leaflet（含 CSS）；卸載時銷毀地圖
  useEffect(() => {
    if (!expanded || !mapEl.current || mapRef.current) return
    let disposed = false
    Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([L]) => {
      if (disposed || !mapEl.current) return
      const start = valueRef.current ?? DEFAULT_CENTER
      const map = L.map(mapEl.current).setView([start.lat, start.lng], 15)
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors', maxZoom: 19,
      }).addTo(map)
      const icon = L.divIcon({
        className: '',
        html: '<div style="width:18px;height:18px;border-radius:9999px;background:#e11d48;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
        iconSize: [18, 18], iconAnchor: [9, 9],
      })
      const marker = L.marker([start.lat, start.lng], { draggable: true, icon }).addTo(map)
      marker.on('dragend', () => {
        const p = marker.getLatLng()
        selectionGen.current++
        const next = { lat: p.lat, lng: p.lng }
        onChange({ ...next, label: mapSelectionLabel(valueRef.current?.label, anchorRef.current, next) })
      })
      map.on('click', e => {
        marker.setLatLng(e.latlng)
        selectionGen.current++
        const next = { lat: e.latlng.lat, lng: e.latlng.lng }
        onChange({ ...next, label: mapSelectionLabel(valueRef.current?.label, anchorRef.current, next) })
      })
      mapRef.current = map
      markerRef.current = marker
    })
    return () => {
      disposed = true
      mapRef.current?.remove()
      mapRef.current = null
      markerRef.current = null
    }
  }, [expanded, onChange])

  // label 變更代表搜尋/GPS/外部帶入或遠距移動產生新標籤；錨點只在此時更新。
  // 同 label 的 250m 內微調不得搬移錨點，避免連續小步拖曳讓地名一路漂移。
  useEffect(() => {
    if (!value) {
      anchorRef.current = null
      lastLabelRef.current = null
      return
    }
    if (value.label !== lastLabelRef.current) {
      anchorRef.current = { lat: value.lat, lng: value.lng }
      lastLabelRef.current = value.label
    }
    if (mapRef.current && markerRef.current) {
      markerRef.current.setLatLng([value.lat, value.lng])
      mapRef.current.setView([value.lat, value.lng], 16)
    }
  }, [value])

  async function runSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!query.trim() || searching) return
    setSearching(true)
    setError('')
    try {
      const hits = await searchPlaces(query.trim())
      setResults(hits)
      if (hits.length === 0) setError('找不到這個地點，換個關鍵字或直接點地圖')
    } catch (err) {
      setError(err instanceof Error ? err.message : '地點搜尋失敗')
    } finally {
      setSearching(false)
    }
  }

  async function useGPS() {
    selectionGen.current++
    const gen = selectionGen.current
    setError('')
    try {
      const pos = await getPosition(navigator.geolocation)
      if (gen !== selectionGen.current) return
      onChange({ ...pos, label: '目前位置' })
    } catch (err) {
      if (gen !== selectionGen.current) return
      setError(err instanceof Error ? err.message : '無法取得目前位置')
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm">
          {value ? <>出發點：<span className="font-semibold">{value.label}</span></> : '尚未選擇出發點'}
        </span>
        <button type="button" className="btn btn-quiet px-3 text-sm"
          onClick={() => setExpanded(x => !x)}>
          {expanded ? '完成' : value ? '變更' : '選擇出發點'}
        </button>
      </div>
      {expanded && (
        <div className="space-y-2">
          <form onSubmit={runSearch} className="flex gap-2">
            <input className="field flex-1" placeholder="搜尋地點，如：台北車站" aria-label="搜尋出發點"
              value={query} onChange={e => setQuery(e.target.value)} />
            <button type="submit" className="btn btn-quiet px-4" disabled={searching}>
              {searching ? <Spinner className="h-4 w-4" /> : '搜尋'}
            </button>
          </form>
          {error && <p className="text-xs text-danger">{error}</p>}
          {results.length > 0 && (
            <ul className="space-y-1">
              {results.map((r, i) => (
                <li key={i}>
                  <button type="button" className="btn btn-quiet w-full justify-start px-3 text-left text-sm"
                    onClick={() => { selectionGen.current++; onChange(r); setResults([]) }}>
                    <span className="truncate">{r.label}</span>
                    {r.context && <span className="ml-2 shrink-0 text-xs text-fg-muted">{r.context}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-quiet w-full" onClick={useGPS}>
            使用目前位置
          </button>
          <div ref={mapEl} className="h-56 w-full overflow-hidden rounded-xl" aria-label="出發點地圖" />
          <p className="text-xs text-fg-muted">搜尋後可拖曳圖釘或點地圖微調</p>
        </div>
      )}
    </div>
  )
}
