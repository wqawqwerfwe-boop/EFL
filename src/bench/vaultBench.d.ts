export const LANES: ReadonlyArray<{ x: number; label: string; expect: string }>
export class VaultBench {
  constructor(container: HTMLElement)
  mode: 'fixed' | 'legacy'
  paused: boolean
  events: Array<{ frame: number; msg: string }>
  setMode(mode: 'fixed' | 'legacy'): void
  reset(): void
  stats(): Array<Record<string, any>>
  resize(): void
  dispose(): void
}
