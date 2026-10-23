// Simulation bridge for the multiplayer host (web addition).
//
// The local simulation plays its sounds straight through the ResourceCenter
// and spawns explosions as pure visuals. When the browser is hosting a room it
// must also stream those moments to the guests, so the few call sites that are
// addressed at "the player" route through the GameInstance helpers
// (shipSfx / shipNotification / explosionSfx) and this module tells the host
// session who the player was. With no host attached the helpers behave exactly
// like the original single-player code.

import type { ModelData, SpaceObject } from '../objects';

export interface ExplosionSpawnInfo {
  pos: [number, number, number];
  scale: number;
  life: number;
  /** Smoke puffs the burst spawned. */
  smoke: number;
  /** Debris pieces the burst spawned (0 = none). */
  debris: number;
  /** Debris source model (null when there is no debris). */
  model: ModelData | null;
}

/** Installed by mp/host.ts while a hosted match is running. */
export interface HostSimHooks {
  /** Sfx heard by the crew of `ship` (always a remote guest's ship). */
  shipSfx(ship: SpaceObject, name: string, volume: number): void;
  /** A voice line for the crew of `ship`. */
  shipNotification(ship: SpaceObject, field: string): void;
  /** A voice line raised for one team: routed to the guests that fly for it. */
  teamVoice(team: string, field: string): void;
  /** An explosion was spawned: stream it (visuals replay on every client). */
  explosion(info: ExplosionSpawnInfo): void;
  /** Distance sfx of a destroyed object, once per remote viewpoint. */
  explosionSfx(obj: SpaceObject): void;
}

export const simHooks: { host: HostSimHooks | null } = { host: null };
