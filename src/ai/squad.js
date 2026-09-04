/**
 * Squad - shared permission, not shared knowledge.
 *
 * The old version had a `contact` field. One member saw the player, wrote the
 * position into the squad, and on the next tick every other member read it back
 * out with `alertness = 1`. That is the arcade behaviour this rewrite exists to
 * kill: it made a suppressor pointless, because shooting one scav in a closed
 * room instantly briefed the four in the building next door.
 *
 * What a squad legitimately shares is permission, not information:
 *   - only so many members break cover at once   (peek tokens)
 *   - only one member flanks at a time           (flanker)
 *   - only one grenade is in the air at a time   (grenadeCooldown)
 *
 * Information now travels the only way it can travel in the world: as sound.
 * `callOut()` takes a vocal call-out and delivers it through each member's
 * `hear(pos, loudness)` after attenuating it for distance and geometry. There is
 * no other path in or out. If the sound does not reach you, you do not know.
 */

let _nextSquad = 1

/**
 * What survives the trip. A call-out that has to bend around cover loses most of
 * its intelligibility; one through a poured concrete wall is a muffled thump
 * that tells you someone is over there and nothing else.
 */
export const PARTIAL_MUFFLE = 0.62
export const WALL_MUFFLE = 0.32

const EAR_HEIGHT = 1.6
const LOW_OFFSET = 0.35

function fallbackRng() {
  let a = 0x9e3779b9
  return {
    float() {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

function rngOf(src) {
  if (src && typeof src.float === 'function') return src
  if (src && src.rng && typeof src.rng.float === 'function') return src.rng
  return fallbackRng()
}

function posOf(a) {
  if (!a) return null
  if (a.root && a.root.position) return a.root.position
  if (a.position) return a.position
  return null
}

function dist(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * How loud a call-out still is by the time it reaches `listenerPos`.
 *
 * Two probes rather than one: ear height, and low along the floor. A body behind
 * a waist-high barricade blocks the first and not the second, and should still
 * hear the shout - just not clearly. Both blocked means real structure in the
 * way.
 *
 * Returns the loudness to hand to `hear()`, or 0 for "heard nothing". Exported
 * so an agent with no squad propagates identically.
 */
export function audibleLoudness(phys, listenerPos, sourcePos, range) {
  if (!listenerPos || !sourcePos || !(range > 0)) return 0
  if (dist(listenerPos, sourcePos) > range) return 0
  if (!phys || typeof phys.lineOfSight !== 'function') return range

  const mask = phys.MASK && phys.MASK.SIGHT !== undefined ? phys.MASK.SIGHT : 1
  const ear = { x: listenerPos.x, y: listenerPos.y + EAR_HEIGHT, z: listenerPos.z }
  const low = { x: listenerPos.x, y: listenerPos.y + LOW_OFFSET, z: listenerPos.z }

  let clear = 0
  try {
    if (phys.lineOfSight(ear, sourcePos, mask)) clear++
    if (phys.lineOfSight(low, sourcePos, mask)) clear++
  } catch (err) {
    // physics not ready - do not silence the squad over a query failure
    return range
  }

  if (clear === 2) return range
  if (clear === 1) return range * PARTIAL_MUFFLE
  return range * WALL_MUFFLE
}

export class Squad {
  constructor(id, rng) {
    this.id = id === undefined || id === null ? _nextSquad++ : id
    this.members = []
    this.rng = rngOf(rng)

    this.peekTokens = 1
    this.peekHolders = new Set()
    this.peekTimer = 0

    this.grenadeCooldown = 0
    this.flanker = null

    /**
     * The last call-out, for the debug overlay only. Deliberately not read by
     * any agent - if this ever becomes an input the telepathy is back.
     */
    this.lastCall = null
    this.callCount = 0

    this._phys = null
  }

  add(agent) {
    if (!agent || this.members.indexOf(agent) >= 0) return agent
    this.members.push(agent)
    agent.squad = this
    // half the squad may be exposed at once, never fewer than one
    this.peekTokens = Math.max(1, Math.round(this.members.length * 0.5))
    return agent
  }

  remove(agent) {
    const i = this.members.indexOf(agent)
    if (i >= 0) this.members.splice(i, 1)
    this.peekHolders.delete(agent)
    if (this.flanker === agent) this.flanker = null
    if (agent && agent.squad === this) agent.squad = null
    this.peekTokens = Math.max(1, Math.round(this.members.length * 0.5))
    return agent
  }

  get alive() {
    let n = 0
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i]
      if (m && m.state !== 'dead') n++
    }
    return n
  }

  /** Physics handle, resolved lazily off whichever member has a host. */
  physics() {
    if (this._phys) return this._phys
    for (let i = 0; i < this.members.length; i++) {
      const ai = this.members[i] ? this.members[i].ai : null
      if (!ai) continue
      const p = ai.phys || ai.physics || (ai.ctx ? ai.ctx.physics : null)
      if (p && typeof p.lineOfSight === 'function') {
        this._phys = p
        return p
      }
    }
    return null
  }

  /**
   * Rotate permission. No information moves in here any more - this used to be
   * where the shared contact was broadcast.
   */
  update(dt) {
    this.peekTimer -= dt
    if (this.peekTimer <= 0) {
      // drop the tokens so somebody else gets a turn at the corner
      this.peekHolders.clear()
      this.peekTimer = 1.1 + this.rng.float() * 1.2
    }
    if (this.grenadeCooldown > 0) this.grenadeCooldown -= dt
    if (this.flanker && this.flanker.state === 'dead') this.flanker = null
  }

  requestPeek(agent, dt) {
    if (!agent) return false
    if (this.peekHolders.has(agent)) return true
    if (this.peekHolders.size >= this.peekTokens) return false
    this.peekHolders.add(agent)
    return true
  }

  releasePeek(agent) {
    this.peekHolders.delete(agent)
  }

  canFlank(agent) {
    return this.flanker === null || this.flanker === agent
  }

  claimFlank(agent) {
    if (!this.canFlank(agent)) return false
    this.flanker = agent
    return true
  }

  releaseFlank(agent) {
    if (this.flanker === agent) this.flanker = null
  }

  requestGrenade(agent, delay) {
    if (this.grenadeCooldown > 0) return false
    this.grenadeCooldown = Number.isFinite(delay) ? delay : 14 + this.rng.float() * 12
    return true
  }

  /**
   * A member shouted. Deliver it as sound.
   *
   * This is the only route by which one agent's knowledge can reach another.
   * Every member gets the same treatment - distance, then geometry - and
   * whatever survives goes into `hear(pos, loudness)`, which is free to ignore
   * it. Nothing is written into another agent directly.
   *
   * @returns how many squadmates actually heard it
   */
  callOut(from, kind, pos, range) {
    if (!pos || !(range > 0)) return 0
    const phys = this.physics()
    let heard = 0
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i]
      if (!m || m === from || m.state === 'dead') continue
      if (typeof m.hear !== 'function') continue
      const lp = posOf(m)
      if (!lp) continue
      const carried = audibleLoudness(phys, lp, pos, range)
      if (carried <= 0) continue
      if (m.hear(pos, carried) !== false) heard++
    }
    this.callCount++
    this.lastCall = { kind, x: pos.x, y: pos.y, z: pos.z, range, heard }
    return heard
  }

  dispose() {
    for (let i = 0; i < this.members.length; i++) {
      if (this.members[i] && this.members[i].squad === this) this.members[i].squad = null
    }
    this.members.length = 0
    this.peekHolders.clear()
    this.flanker = null
    this._phys = null
  }
}

export default Squad