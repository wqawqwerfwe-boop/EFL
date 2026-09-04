import { useEffect, useRef, useState } from 'react'
import { FactionBench, LINEUP } from '../bench/factionBench.js'

type Info = {
  index: number
  faction: string
  profile: string
  armorZones: string[]
  name: string
  parts: string[]
  meta: { garment?: string; seed: number }
}

const FACTION_NOTES: Record<string, string> = {
  scav: 'Random civil layers. Quilted jackets, tracksuits, jeans, ushankas and beanies. Armour mesh only compiles when a PACA is present in _armorZones.',
  raider: 'Matching dark operational kit. Combat helmet with visor, heavy modular plate carrier with pouches and radio, knee and elbow pads, gloves.',
  pmc: 'Camo uniform per side (USEC multicam / BEAR gorka), ballistic helmet, plate carrier, headset, large pack.',
  boss: 'Signature profiles. Killa: 6B13 assault armour + Maska-1Sch with the three white stripes. Shturman: open camo coat silhouette, ushanka, slung pack.',
}

export default function FactionPanel() {
  const host = useRef<HTMLDivElement>(null)
  const bench = useRef<FactionBench | null>(null)
  const [info, setInfo] = useState<Info | null>(null)
  const [spin, setSpin] = useState(true)
  const [seed, setSeed] = useState(1)

  useEffect(() => {
    if (!host.current) return
    const b = new FactionBench(host.current, (i: Info) => setInfo(i))
    bench.current = b
    b.select(6)
    return () => {
      b.dispose()
      bench.current = null
    }
  }, [])

  return (
    <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-[1fr_360px]">
      <div className="efl-panel relative min-h-[420px] overflow-hidden">
        <div ref={host} className="absolute inset-0" />
        <div className="pointer-events-none absolute left-3 top-3 text-[11px] leading-tight">
          <div className="text-emerald-300">FACTION MODEL COMPILER · buildActor()</div>
          <div className="text-emerald-100/50">click an actor to inspect · drag to orbit</div>
        </div>
        <div className="absolute right-3 top-3 flex gap-2">
          <button
            className="efl-btn"
            onClick={() => {
              bench.current?.reroll()
              setSeed((s) => s + 1)
            }}
          >
            reroll seed
          </button>
          <button
            className="efl-btn"
            data-active={spin}
            onClick={() => {
              const s = !spin
              setSpin(s)
              if (bench.current) bench.current.spin = s
            }}
          >
            turntable
          </button>
        </div>
        <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 p-2">
          {LINEUP.map((l, i) => (
            <button
              key={i}
              className="efl-btn !px-2 !py-1 !text-[10px]"
              data-active={info?.index === i}
              onClick={() => bench.current?.select(i)}
            >
              {l.faction}:{l.profile}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3 text-[11px]">
        <div className="efl-panel p-3">
          <div className="mb-2 uppercase tracking-widest text-emerald-300">Archetype</div>
          {info ? (
            <>
              <div className="text-base text-emerald-50">{info.name}</div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-emerald-100/80">
                <span className="text-emerald-100/40">faction</span>
                <span>{info.faction}</span>
                <span className="text-emerald-100/40">profile</span>
                <span>{info.profile}</span>
                <span className="text-emerald-100/40">garment</span>
                <span>{info.meta.garment}</span>
                <span className="text-emerald-100/40">_armorZones</span>
                <span>{info.armorZones.length ? info.armorZones.join(', ') : 'none'}</span>
                <span className="text-emerald-100/40">seed</span>
                <span>{info.meta.seed}</span>
              </div>
              <p className="mt-3 leading-relaxed text-emerald-100/60">{FACTION_NOTES[info.faction]}</p>
            </>
          ) : (
            <div className="text-emerald-100/40">select an actor</div>
          )}
        </div>

        <div className="efl-panel efl-log min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-2 uppercase tracking-widest text-emerald-300">Compiled part manifest</div>
          <ul className="space-y-1">
            {info?.parts.map((p, i) => (
              <li key={i} className="flex items-center gap-2 text-emerald-100/85">
                <span className="text-emerald-400">▸</span>
                {p}
              </li>
            ))}
          </ul>
          <div className="mt-3 text-emerald-100/40">lineup seed {seed} · textures cached per (faction, profile, seed)</div>
        </div>
      </div>
    </div>
  )
}
