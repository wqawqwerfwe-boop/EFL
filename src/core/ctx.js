/**
 * Core - subsystem context / service locator.
 *
 * `ctx.get(name)` returns a registered service, `ctx.emit(event, payload)`
 * fans out to `ctx.on(event, fn)` listeners. This is the minimal contract
 * every subsystem in the engine is written against.
 */

export function createCtx(initial = {}) {
  const services = new Map(Object.entries(initial))
  const listeners = new Map()
  return {
    get(name) {
      return services.get(name) || null
    },
    set(name, service) {
      services.set(name, service)
      return service
    },
    has(name) {
      return services.has(name)
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event).delete(fn)
    },
    emit(event, payload) {
      const set = listeners.get(event)
      if (!set) return
      for (const fn of set) fn(payload)
    },
  }
}
