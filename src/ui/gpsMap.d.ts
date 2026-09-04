export const GPS_ITEM: string
export const MAP_IDS: ReadonlyArray<string>
export const MARKER_COLORS: Record<string, string>
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
export class GpsMap {
  constructor(ctx: any, canvas: HTMLCanvasElement, opts?: any)
  mapId: string
  zoom: number
  followPlayer: boolean
  markers: Marker[]
  readonly questsLive: boolean
  setMap(id: string): void
  setObjectives(markers: Marker[] | null): void
  update(dt: number): void
  render(): void
  hasDevice(): boolean
  pick(x: number, y: number): Marker | null
  setZoom(z: number): void
  setMarkerStatus(id: string, status: string): void
  addMarker(m: Partial<Marker>): void
  removeMarker(id: string): void
  panBy(dx: number, dz: number): void
  dispose(): void
}
