/**
 * Surface & layer vocabulary, physics side.
 *
 * The surface registry itself now lives in src/core/surfaces.js and is shared
 * with the ballistics solver, items and materials. This file used to declare
 * its own twelve-entry table in a different order from penetration.js, so the
 * one-byte index physics writes onto every triangle was read as a different
 * material by the solver — index 11 was plaster here and flesh there. The
 * table is gone; only the collision layers below are physics-owned.
 *
 * Physics still stores the *index* per triangle and hands the *name* back to
 * callers, so nobody outside this directory has to care about the packing.
 */

import {
	SURFACE,
	SURFACE_COUNT,
	SURFACE_NAMES,
	SURFACE_PROPS,
	SURFACE_PROPS_BY_NAME,
	SURFACE_THICKNESS,
	guessSurface,
	isSurface,
	surfaceIndex,
	surfaceName
} from '../core/surfaces.js'

export {
	SURFACE,
	SURFACE_COUNT,
	SURFACE_NAMES,
	SURFACE_PROPS,
	SURFACE_PROPS_BY_NAME,
	SURFACE_THICKNESS,
	guessSurface,
	isSurface,
	surfaceIndex,
	surfaceName
}

/* ------------------------------------------------------------------ */
/* Collision layers                                                    */
/* ------------------------------------------------------------------ */

export const LAYER = {
	/** Immovable level geometry. */ STATIC: 1 << 0,
	/** Static props — crates, cars. Same BVH, separate bit so AI can ignore. */ PROP: 1 << 1,
	/** Simulated debris & dropped weapons. */ DEBRIS: 1 << 2,
	/** Player capsule. */ PLAYER: 1 << 3,
	/** AI character capsules / hitboxes. */ ACTOR: 1 << 4,
	/** Ragdoll bones. */ RAGDOLL: 1 << 5,
	/** Breakable glass — blocks bullets briefly, never blocks sight. */ GLASS: 1 << 6,
	/** Water volumes. */ WATER: 1 << 7,
	/** Invisible clip: stops characters, ignored by bullets and cameras. */ CLIP: 1 << 8,
	/** Blocks bullets but not movement (grates, railings modelled thin). */ SHOOT_ONLY: 1 << 9,
	/** Non-colliding trigger volume. */ TRIGGER: 1 << 10,
	/** Foliage — no collision, deflects bullets barely, blocks nothing. */ FOLIAGE: 1 << 11
}

export const MASK = {
	ALL: 0xffff & ~LAYER.TRIGGER,
	/** Everything a character capsule collides with. */
	CHARACTER: LAYER.STATIC | LAYER.PROP | LAYER.CLIP,
	/** Everything a bullet can strike. */
	BULLET:
		LAYER.STATIC | LAYER.PROP | LAYER.DEBRIS | LAYER.ACTOR | LAYER.RAGDOLL |
		LAYER.GLASS | LAYER.SHOOT_ONLY | LAYER.FOLIAGE,
	/** Static-only: camera collision, cover queries, decal projection. */
	WORLD: LAYER.STATIC | LAYER.PROP,
	/** Line of sight — glass and foliage do not block vision. */
	SIGHT: LAYER.STATIC | LAYER.PROP | LAYER.DEBRIS,
	/** What rigid debris bounces off. */
	DEBRIS: LAYER.STATIC | LAYER.PROP | LAYER.CLIP,
	/** Explosion occlusion. */
	EXPLOSION: LAYER.STATIC | LAYER.PROP
}
