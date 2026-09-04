export type Ctx = {
  get(name: string): any
  set<T>(name: string, service: T): T
  has(name: string): boolean
  on(event: string, fn: (payload: any) => void): () => void
  emit(event: string, payload?: any): void
}
export function createCtx(initial?: Record<string, any>): Ctx
