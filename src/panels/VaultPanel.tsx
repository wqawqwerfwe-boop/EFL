import { useEffect, useRef, useState } from 'react'
import { VaultBench, LANES } from '../bench/vaultBench.js'
import { VAULT } from '../ai/agent.js'

type Stat = {
  id: number
  faction: string
  profile: string
  state: string
  speed: number
  y: number
  wallHits: number
  steps: number
  lane: string
  expect: string
  x: number
  z: number
  overCeiling: boolean
}

type Ev = { frame: number; msg: string }

export default function VaultPanel() {
  const host = useRef<HTMLDivElement>(null)
  const bench = useRef<VaultBench | null>(null)
  const [mode, setMode] = useState<'fixed' | 'legacy'>('fixed')
  const [paused, setPaused] = useState(false)
  const [stats, setStats] = useState<Stat[]>([])
  const [events, setEvents] = useState<Ev[]>([])

  useEffect(() => {
    if (!host.current) return
    const b = new VaultBench(host.current)
    bench.current = b
    const id = window.setInterval(() => {
      setStats(b.stats() as Stat[])
      setEvents(b.events.slice(0, 14))
    }, 120)
    return () => {
      window.clearInterval(id)
      b.dispose()
      bench.current = null
    }
  }, [])

  const switchMode = (m: 'fixed' | 'legacy') => {
    setMode(m)
    bench.current?.setMode(m)
  }

  const anyWarp = stats.some((s) => s.overCeiling)

  return (
    <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-[1fr_360px]">
      <div className="efl-panel relative min-h-[420px] overflow-hidden">
        <div ref={host} className="absolute inset-0" />
        <div className="pointer-events-none absolute left-3 top-3 space-y-1 text-[11px] leading-tight">
          <div className="text-emerald-300">AI VAULT REGRESSION COURSE</div>
          <div className="text-emerald-100/60">
            STEP_CEILING {VAULT.STEP_CEILING} m · LOW_PROBE {VAULT.LOW_PROBE} m · CLEARANCE {VAULT.CLEARANCE} m · PROBE {VAULT.PROBE} m
          </div>
          <div className="text-emerald-100/40">drag to orbit · yellow plane = obstacle height ceiling</div>
        </div>
        <div className="absolute right-3 top-3 flex gap-2">
          <button className="efl-btn" data-active={mode === 'fixed'} onClick={() => switchMode('fixed')}>
            fixed _tryVault
          </button>
          <button className="efl-btn" data-active={mode === 'legacy'} data-danger="true" onClick={() => switchMode('legacy')}>
            legacy (bug)
          </button>
          <button
            className="efl-btn"
            onClick={() => {
              const p = !paused
              setPaused(p)
              if (bench.current) bench.current.paused = p
            }}
          >
            {paused ? 'resume' : 'pause'}
          </button>
          <button className="efl-btn" onClick={() => bench.current?.reset()}>
            reset
          </button>
        </div>
        <div
          className={`absolute bottom-3 left-3 border px-3 py-1.5 text-[11px] ${
            anyWarp ? 'border-red-500/70 bg-red-950/70 text-red-200' : 'border-emerald-500/50 bg-emerald-950/60 text-emerald-200'
          }`}
        >
          {anyWarp ? '⚠ ACTOR ABOVE CEILING — ROOF WARP REPRODUCED' : '✓ NO ACTOR ABOVE OBSTACLE CEILING'}
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <div className="efl-panel p-3">
          <div className="mb-2 text-[11px] uppercase tracking-widest text-emerald-300">Lanes</div>
          <ul className="space-y-1 text-[11px]">
            {LANES.map((l, i) => (
              <li key={i} className="flex justify-between gap-2 text-emerald-100/80">
                <span>
                  L{i + 1} · {l.label}
                </span>
                <span className="text-emerald-100/40">{l.expect}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="efl-panel p-3">
          <div className="mb-2 text-[11px] uppercase tracking-widest text-emerald-300">Agent telemetry</div>
          <table className="w-full text-[11px]">
            <thead className="text-emerald-100/40">
              <tr className="text-left">
                <th className="font-normal">actor</th>
                <th className="font-normal">state</th>
                <th className="font-normal text-right">y</th>
                <th className="font-normal text-right">walls</th>
                <th className="font-normal text-right">steps</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.id} className={s.overCeiling ? 'text-red-300' : 'text-emerald-100/85'}>
                  <td>
                    #{s.id} {s.faction}
                  </td>
                  <td>{s.state}</td>
                  <td className="text-right tabular-nums">{s.y.toFixed(2)}</td>
                  <td className="text-right tabular-nums">{s.wallHits}</td>
                  <td className="text-right tabular-nums">{s.steps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="efl-panel efl-log min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-2 text-[11px] uppercase tracking-widest text-emerald-300">Locomotion events</div>
          <ul className="space-y-0.5 text-[11px]">
            {events.map((e, i) => (
              <li key={i} className={e.msg.includes('WARPED') ? 'text-red-300' : 'text-emerald-100/70'}>
                <span className="text-emerald-100/30">f{e.frame} </span>
                {e.msg}
              </li>
            ))}
            {!events.length && <li className="text-emerald-100/40">walking…</li>}
          </ul>
        </div>
      </div>
    </div>
  )
}
