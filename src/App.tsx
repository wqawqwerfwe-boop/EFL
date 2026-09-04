import { useEffect, useState } from 'react'
import VaultPanel from './panels/VaultPanel'
import GpsPanel from './panels/GpsPanel'
import FactionPanel from './panels/FactionPanel'

type Tab = 'vault' | 'gps' | 'faction'
type AppProps = { ctx?: any }

const TABS: Array<{ id: Tab; label: string; sub: string }> = [
  { id: 'vault', label: '01 · AI vault physics', sub: 'roof warp telemetry' },
  { id: 'gps', label: '02 · GPS tactical map', sub: 'live raid tracking' },
  { id: 'faction', label: '03 · Faction compiler', sub: 'actor mesh manifest' },
]

export default function App({ ctx }: AppProps) {
  const [tab, setTab] = useState<Tab>('gps')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean; tab?: Tab }>).detail || {}
      if (detail.tab) setTab(detail.tab)
      setOpen(detail.open !== false)
    }
    window.addEventListener('efl:diagnostics', sync)
    return () => window.removeEventListener('efl:diagnostics', sync)
  }, [])

  if (!open) return null

  const close = () => window.dispatchEvent(new CustomEvent('efl:diagnostics-request', { detail: { open: false } }))

  return (
    <div className="efl-console-shell" role="dialog" aria-modal="true" aria-label="EFL systems console">
      <div className="efl-console flex h-full flex-col gap-3 p-3">
        <header className="efl-panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-emerald-400/70">Escape From Larpov · live systems console</div>
            <h1 className="text-lg font-semibold tracking-wide text-emerald-50">EFL — Physics · Navigation · Identity</h1>
          </div>
          <nav className="flex flex-wrap gap-2" aria-label="Diagnostic panels">
            {TABS.map((item) => (
              <button key={item.id} className="efl-btn text-left" data-active={tab === item.id} onClick={() => setTab(item.id)}>
                <div>{item.label}</div>
                <div className="normal-case tracking-normal text-emerald-100/40">{item.sub}</div>
              </button>
            ))}
            <button className="efl-btn" data-danger="true" onClick={close}>M · close</button>
          </nav>
        </header>

        <main className="min-h-0 flex-1">
          {tab === 'vault' && <VaultPanel />}
          {tab === 'gps' && <GpsPanel ctx={ctx} />}
          {tab === 'faction' && <FactionPanel />}
        </main>

        <footer className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-[10px] text-emerald-100/35">
          <span>vault · obstacle rise capped by STEP_CEILING</span>
          <span>gps · coordinates sourced from ctx.get('player')</span>
          <span>faction · procedural buildActor() manifest</span>
          <span>M · close tactical overlay</span>
        </footer>
      </div>
    </div>
  )
}
