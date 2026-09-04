export const LINEUP: ReadonlyArray<{ faction: string; profile: string; armorZones: string[]; name: string }>
export class FactionBench {
  constructor(container: HTMLElement, onSelect?: (info: any) => void)
  seed: number
  spin: boolean
  selected: number
  reroll(): void
  select(i: number): void
  build(): void
  resize(): void
  dispose(): void
}
