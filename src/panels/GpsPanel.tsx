import { useEffect, useRef, useState } from 'react'
import { createCtx } from '../core/ctx.js'
import { GpsMap, GPS_ITEM, MAP_IDS, MAP_SCHEMAS, MARKER_COLORS, type Marker } from '../ui/gpsMap.js'

const SPAWN: Record<string, [number, number]> = {
  factory: [-45, -45],
  customs: [-180, -80],
  woods: [-220, 20],
  interchange: [-140, -120],
}

export default function GpsPanel({ ctx: liveCtx }: { ctx?: any }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<GpsMap | null>(null)
  const keys = useRef<Set<string>>(new Set())
  const live = !!liveCtx
  const requestedMap = liveCtx?.peek?.('raid')?.mapId || liveCtx?.get?.('world')?.mapId || 'factory'
  const initialMap = MAP_IDS.includes(requestedMap) ? requestedMap : 'factory'
  const worldRef = useRef({ mapId: initialMap })
  const inventoryRef = useRef({ special: [GPS_ITEM, 'item_compass'] })
  const ctxRef = useRef<any>(liveCtx ? {
    get(name: string) {
      if (name === 'world') return worldRef.current
      if (name === 'inventory') return inventoryRef.current
      return liveCtx.get(name)
    },
  } : createCtx())
  const [mapId, setMapId] = useState(initialMap)
  const [device, setDevice] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [follow, setFollow] = useState(true)
  const [placing, setPlacing] = useState(false)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [pos, setPos] = useState({ x: 0, z: 0, yaw: 0 })

  // boot the tablet
  useEffect(() => {
    const ctx = ctxRef.current
    if (!live) {
      const [sx, sz] = SPAWN.factory
      ctx.set('world', { mapId: 'factory' })
      ctx.set('player', { position: { x: sx, y: 0, z: sz }, yaw: 0.6, fov: 75 })
      ctx.set('inventory', { special: [GPS_ITEM, 'item_compass'] })
    }
    const canvas = canvasRef.current!
    canvas.width = 960
    canvas.height = 640
    const map = new GpsMap(ctx, canvas, { zoom: 1 })
    mapRef.current = map
    setMarkers([...map.markers])

    let last = performance.now()
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const now = performance.now()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const p = ctx.get('player')
      if (!live) {
        const k = keys.current
        const turn = (k.has('q') || k.has('arrowleft') ? -1 : 0) + (k.has('e') || k.has('arrowright') ? 1 : 0)
        p.yaw += turn * 2.2 * dt
        const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0)
        const strafe = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0)
        const speed = k.has('shift') ? 10 : 5.5
        const sy = Math.sin(p.yaw)
        const cy = Math.cos(p.yaw)
        p.position.x += (sy * fwd + cy * strafe) * speed * dt
        p.position.z += (cy * fwd - sy * strafe) * speed * dt
        const b = MAP_SCHEMAS[ctx.get('world').mapId].bounds as number[][]
        const xs = b.map((v) => v[0])
        const zs = b.map((v) => v[1])
        p.position.x = Math.max(Math.min(...xs), Math.min(Math.max(...xs), p.position.x))
        p.position.z = Math.max(Math.min(...zs), Math.min(Math.max(...zs), p.position.z))
      }
      map.update(dt)
      map.render()
    }
    tick()
    const hud = window.setInterval(() => {
      const p = ctx.get('player')
      setPos({ x: p.position.x, z: p.position.z, yaw: p.yaw })
    }, 100)

    const down = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      keys.current.add(key)
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) e.preventDefault()
    }
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase())
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(hud)
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // reflect UI state into the engine services
  useEffect(() => {
    const ctx = ctxRef.current
    ctx.get('world').mapId = mapId
    const p = ctx.get('player')
    if (!live) {
      const [sx, sz] = SPAWN[mapId]
      p.position.x = sx
      p.position.z = sz
    }
    const map = mapRef.current
    if (map) {
      map.update(0)
      setMarkers([...map.markers])
    }
  }, [mapId, live])

  useEffect(() => {
    const inv = ctxRef.current.get('inventory')
    inv.special = device ? [GPS_ITEM, 'item_compass'] : ['item_compass']
  }, [device])

  useEffect(() => {
    mapRef.current?.setZoom(zoom)
  }, [zoom])

  useEffect(() => {
    if (mapRef.current) mapRef.current.followPlayer = follow
  }, [follow])

  const cycle = (id: string) => {
    const map = mapRef.current
    if (!map) return
    const m = map.markers.find((x) => x.id === id)
    if (!m || m.kind !== 'quest') return
    const next = m.status === 'future' ? 'active' : m.status === 'active' ? 'done' : 'future'
    map.setMarkerStatus(id, next)
    setMarkers([...map.markers])
  }

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const map = mapRef.current
    const canvas = canvasRef.current
    if (!map || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = ((e.clientX - rect.left) / rect.width) * canvas.width
    const sy = ((e.clientY - rect.top) / rect.height) * canvas.height
    if (placing) {
      const [wx, wz] = (map as any).toWorld(sx, sy) as [number, number]
      const n = map.markers.filter((m) => m.id.startsWith('q:custom')).length + 1
      map.addMarker({ id: `q:custom${n}`, label: `Тайник #${n}`, x: wx, z: wz, status: 'future', radius: 3 })
      setMarkers([...map.markers])
      setPlacing(false)
      return
    }
    const hit = map.pick(sx, sy)
    if (hit) cycle(hit.id)
  }

  const deg = ((((pos.yaw * 180) / Math.PI) % 360) + 360) % 360

  return (
    <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-[1fr_340px]">
      <div className="efl-panel efl-scan relative overflow-hidden p-2">
        <div className="relative mx-auto aspect-[3/2] w-full max-w-[1040px] border border-emerald-400/20 bg-black">
          <canvas
            ref={canvasRef}
            onClick={onCanvasClick}
            className={`block h-full w-full ${placing ? 'cursor-crosshair' : 'cursor-pointer'}`}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 px-1 text-[11px]">
          <span className="text-emerald-100/50">MAP</span>
          {MAP_IDS.map((id) => (
            <button key={id} className="efl-btn" data-active={mapId === id} onClick={() => setMapId(id)}>
              {id}
            </button>
          ))}
          <span className="ml-3 text-emerald-100/50">ZOOM</span>
          <input
            type="range"
            min={0.6}
            max={5}
            step={0.1}
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="w-32 accent-emerald-400"
          />
          <button className="efl-btn" data-active={follow} onClick={() => setFollow(!follow)}>
            follow
          </button>
          <button className="efl-btn" data-active={placing} onClick={() => setPlacing(!placing)}>
            {placing ? 'click map to drop pin' : '+ place objective pin'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <div className="efl-panel p-3">
          <div className="mb-2 text-[11px] uppercase tracking-widest text-emerald-300">Special slots</div>
          <button
            className="efl-btn w-full"
            data-active={device}
            data-danger={!device}
            onClick={() => setDevice(!device)}
          >
            {device ? `● ${GPS_ITEM} equipped` : `○ ${GPS_ITEM} missing — blind navigation`}
          </button>
          <div className="mt-2 text-[11px] text-emerald-100/50">
            Without the device the tablet renders only the raw top-down chart: no fix, no heading, no frustum.
          </div>
        </div>

        <div className="efl-panel p-3 text-[11px]">
          <div className="mb-2 uppercase tracking-widest text-emerald-300">Player ({live ? 'live raid' : 'simulated'})</div>
          <div className="grid grid-cols-3 gap-2 tabular-nums text-emerald-100/85">
            <div>
              <div className="text-emerald-100/40">X</div>
              {pos.x.toFixed(1)}
            </div>
            <div>
              <div className="text-emerald-100/40">Z</div>
              {pos.z.toFixed(1)}
            </div>
            <div>
              <div className="text-emerald-100/40">HDG</div>
              {deg.toFixed(0).padStart(3, '0')}°
            </div>
          </div>
          <div className="mt-2 text-emerald-100/40">{live ? "tracking ctx.get('player') in real time" : 'W/S move · A/D strafe · Q/E turn · Shift sprint'}</div>
        </div>

        <div className="efl-panel efl-log min-h-0 flex-1 overflow-auto p-3 text-[11px]">
          <div className="mb-2 uppercase tracking-widest text-emerald-300">Markers · {mapId}</div>
          <ul className="space-y-1">
            {markers.map((m) => {
              const color = m.kind === 'extract' ? MARKER_COLORS.extract : MARKER_COLORS[m.status]
              return (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-emerald-100/85">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                    <span>{m.label}</span>
                    <span className="text-emerald-100/30">{m.id}</span>
                  </span>
                  {m.kind === 'quest' ? (
                    <button className="efl-btn !px-2 !py-0.5" onClick={() => cycle(m.id)}>
                      {m.status}
                    </button>
                  ) : (
                    <span className="text-emerald-300/70">EXF</span>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="mt-3 flex gap-3 text-emerald-100/50">
            <span>
              <i className="inline-block h-2 w-2 rounded-full" style={{ background: MARKER_COLORS.extract }} /> extraction
            </span>
            <span>
              <i className="inline-block h-2 w-2 rounded-full" style={{ background: MARKER_COLORS.active }} /> current
            </span>
            <span>
              <i className="inline-block h-2 w-2 rounded-full" style={{ background: MARKER_COLORS.future }} /> future
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
