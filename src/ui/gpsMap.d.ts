/** The item that turns the chart into a positioning system. */
export const GPS_ITEM: string

/** Production alias, kept for back-compat with the rich device gate. */
export const GPS_ITEM_ID: string

/** Special-slot names the production device gate walks. */
export const SPECIAL_SLOTS: ReadonlyArray<string>

/** Marker palette (production widgets). */
export const MARKER: Record<string, Record<string, string>>

/** Reference marker palette: extract / active / future / done. */
export const MARKER_COLORS: Record<string, string>

/** Reference map ids, in schema order. */
export const MAP_IDS: ReadonlyArray<string>

/** Reference layout vectors for Factory / Customs / Woods / Interchange. */
export const MAP_SCHEMAS: Record<string, any>

export type Marker = {
  id: string
  kind: 'extract' | 'quest'
  status: 'active' | 'future' | 'done'
  label: string
  x: number
  z: number
  radius?: number
}

/**
 * Production tactical GPS tablet: a handheld chart device rendered as an
 * immersive 3D-tilted overlay rather than a bare canvas. Gated on owning
 * `item_gps_device` in a special slot; without it the chart shows the blind
 * `НЕТ СИГНАЛА` state.
 */
export class GpsMap {
  constructor(ctx: any, opts?: any)
  mount(parent: HTMLElement): void
  resize(): void
  setZoom(z: number): void
  hasDevice(): boolean
  setObjectives(list: Array<Partial<Marker>>): void
  toggle(): void
  setVisible(on: boolean): void
  update(dt: number): void
  draw(): void
  dispose(): void
}

/** Service-locator wrapper registrable as `ctx.get('gpsMap')`. */
export class GpsMapSystem {
  static id: string
  init(ctx: any): Promise<void> | void
  toggle(): void
  setVisible(on: boolean): void
  hasDevice(): boolean
  resize(w: number, h: number): void
  update(): void
  dispose(): void
}

export default GpsMap
