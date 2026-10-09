import { useEffect, useRef, useState } from 'react'
import type { Map as LeafletMap, Marker } from 'leaflet'
import { getPosition } from '../lib/geolocation'
import { searchPlaces, type DeparturePoint } from '../lib/departure'
import { Spinner } from './icons'
import { mapSelectionLabel } from './locationPickerLabel'

const DEFAULT_CENTER = { lat: 25.0478, lng: 121.517 } // 台北車站：地圖顯示與搜尋偏向的預設，不寫入資料

type Props = {
  value: DeparturePoint | null
  onChange: (p: DeparturePoint) => void
  // 已有出發點但地名不明時顯示的字（房內 lobby）；不給就是真的還沒選
  fallbackLabel?: string
}

export default function LocationPicker({ value, onChange, fallbackLabel }: Props) {
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
      // 圖磚兩種主題都是淺色，圖釘用 brand-fill（兩主題都夠深）＋on-brand 白圈，跟著主題又不失對比
      const icon = L.divIcon({
        className: '',
        html: '<div style="width:18px;height:18px;border-radius:9999px;background:var(--color-brand-fill);border:3px solid var(--color-on-brand);box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
        iconSize: [18, 18], iconAnchor: [9, 9],
      })
      const marker = L.marker([start.lat, start.lng], { draggable: true, icon }).addTo(map)
      // 縮小後點到重複的世界副本時 Leaflet 給的 lng 會超出 ±180（伺服器拒收），一律先 wrap
      marker.on('dragend', () => {
        const p = marker.getLatLng().wrap()
        selectionGen.current++
        const next = { lat: p.lat, lng: p.lng }
        onChange({ ...next, label: mapSelectionLabel(valueRef.current?.label, anchorRef.current, next) })
      })
      map.on('click', e => {
        const p = e.latlng.wrap()
        marker.setLatLng(p)
        selectionGen.current++
        const next = { lat: p.lat, lng: p.lng }
        onChange({ ...next, label: mapSelectionLabel(valueRef.current?.label, anchorRef.current, next) })
      })
      mapRef.current = map
      markerRef.current = marker
    })
    return () => {
      disposed = true
      // Leaflet 1.9 的 remove() 不取消縮放動畫的 250ms setTimeout；動畫中卸載（如點地圖後立刻按完成）
      // 計時器會讀已刪的 _mapPane 丟 _leaflet_pos TypeError。先收尾動畫，計時器到時就直接 return。
      const map = mapRef.current as (LeafletMap & { _onZoomTransitionEnd?: () => void }) | null
      map?._onZoomTransitionEnd?.()
      map?.remove()
      mapRef.current = null
      markerRef.current = null
    }
  }, [expanded, onChange])

  // label 變更代表搜尋/GPS/外部帶入或遠距移動產生新標籤；錨點只在此時更新。
  // 同 label 的 250m 內微調不得搬移錨點，避免連續小步拖曳讓地名一路漂移。
  // 明確選擇（搜尋結果/GPS）走直接重設，不依賴 label 比對（同名結果 label 相同比不出來）。
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
      const hits = await searchPlaces(query.trim(), value ?? DEFAULT_CENTER)
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
      anchorRef.current = { lat: pos.lat, lng: pos.lng }
      lastLabelRef.current = '目前位置'
      onChange({ ...pos, label: '目前位置' })
    } catch (err) {
      if (gen !== selectionGen.current) return
      setError(err instanceof Error ? err.message : '無法取得目前位置')
    }
  }

  const shownLabel = value?.label ?? fallbackLabel

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate text-sm">
          {shownLabel ? <>出發點：<span className="font-semibold">{shownLabel}</span></> : '尚未選擇出發點'}
        </span>
        <button type="button" className="btn btn-quiet px-3 text-sm"
          onClick={() => setExpanded(x => !x)}>
          {expanded ? '完成' : shownLabel ? '變更' : '選擇出發點'}
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
                    onClick={() => {
                      selectionGen.current++
                      anchorRef.current = { lat: r.lat, lng: r.lng }
                      lastLabelRef.current = r.label
                      onChange(r)
                      setResults([])
                    }}>
                    <span className="min-w-0 flex-1 truncate text-left">{r.label}</span>
                    {r.context && <span className="ml-2 max-w-[45%] truncate text-xs text-fg-muted">{r.context}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-quiet w-full" onClick={useGPS}>
            使用目前位置
          </button>
          <div ref={mapEl} className="h-56 w-full overflow-hidden rounded-card border border-border" aria-label="出發點地圖" />
          <p className="text-xs text-fg-muted">搜尋後可拖曳圖釘或點地圖微調</p>
        </div>
      )}
    </div>
  )
}
