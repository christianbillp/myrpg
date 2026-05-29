/**
 * Vision — SRD 5.2.1 line-of-sight + senses + perception resolver.
 *
 * The module exposes three pure-ish helpers:
 *
 *   - `canSee(ctx, observer, target)` walks a Bresenham line between the two
 *     tiles and accumulates the worst cover + obscurance the line passes
 *     through. Returns whether the observer perceives the target this frame
 *     and the cover bonus the target benefits from for combat purposes.
 *
 *   - `effectivePerception(senses, baselinePP, sightConditions)` adjusts a
 *     creature's passive perception for the sight conditions toward the
 *     target — Disadvantage from Lightly Obscured / Darkness without
 *     Darkvision (−5), Advantage from Truesight (+5), auto-find via
 *     Blindsight or Tremorsense within range.
 *
 *   - `runPerceptionSweep(ctx, hider)` opposes the hider's stored `hideDC`
 *     against the effective perception of every potentially-spotting
 *     observer. Clears the `hidden` / `invisible` conditions on a spot and
 *     logs the discovery. Called from the engine after movement and on
 *     turn boundaries.
 *
 * The walker treats both ground- and object-layer cover/obscurance through
 * the per-tile arrays baked into `GameMap` by SessionBuilder. Sense ranges
 * are in feet (5 ft per tile). The encounter's `environment.lightLevel`
 * provides the baseline obscurance (`dim` → `lightly`, `dark` → `heavily`)
 * before observer senses are applied — Darkvision converts darkness to dim
 * within range, Blindsight ignores it inside its range entirely.
 */

import type { GameContext } from './GameContext.js';
import type { GameMap, GameState, NpcState, Senses } from './types.js';
import { d20 } from './Dice.js';
import { clearHide } from './ConditionSystem.js';

const TILE_FT = 5;

export type Cover = 'none' | 'half' | 'three-quarters' | 'total';
export type Obscurance = 'none' | 'lightly' | 'heavily';

export interface Observer {
  tileX: number;
  tileY: number;
  /** SRD senses (darkvision / blindsight / tremorsense / truesight). */
  senses: Senses | undefined;
  /** Whether the observer has the Blinded condition — auto-fails sight. */
  blinded?: boolean;
}

export interface VisionTarget {
  tileX: number;
  tileY: number;
  /** Conditions that affect being seen (`hidden`, `invisible`). */
  conditions: string[];
  /** Optional id for diagnostics + perception-sweep handling. */
  id?: string;
}

export interface VisionResult {
  /** Did the observer perceive the target this check? */
  sees: boolean;
  /** Cover the target benefits from along the line. `none` when LOS is clear. */
  cover: Cover;
  /** Worst obscurance accumulated along the line (Lightly / Heavily / none). */
  obscurance: Obscurance;
  /** Which sense produced the perception: `sight`, `blindsight`, `tremorsense`,
   *  `truesight`, or `none` (target unseen). */
  via: 'sight' | 'blindsight' | 'tremorsense' | 'truesight' | 'none';
}

/**
 * Bresenham-walk from observer to target. Returns the LOS result + the
 * cover / obscurance the line accumulated along the way. The endpoints are
 * skipped — a creature does not provide cover to itself.
 */
export function canSee(state: GameState, observer: Observer, target: VisionTarget): VisionResult {
  // Same tile — always seen, never obscured (you're standing on it).
  if (observer.tileX === target.tileX && observer.tileY === target.tileY) {
    return { sees: true, cover: 'none', obscurance: 'none', via: 'sight' };
  }

  const distFt = chebyshevTiles(observer, target) * TILE_FT;
  const senses = observer.senses ?? {};

  // Truesight pierces invisibility + magical concealment + total cover within
  // its range. Treat it as the most permissive sense: if you're inside the
  // range, you see the target regardless of conditions or terrain.
  if (typeof senses.truesight === 'number' && distFt <= senses.truesight) {
    const ray = walkLOS(state.map, observer, target);
    // Truesight still respects Total Cover only when the line traverses a
    // wall whose properties say so — practically rare, since `total` cover
    // tiles are also impassable. We keep it strict for completeness.
    if (ray.cover !== 'total') {
      return { sees: true, cover: ray.cover, obscurance: 'none', via: 'truesight' };
    }
  }

  // Blindsight: see within range, ignoring sight requirements; only Total
  // Cover blocks it.
  if (typeof senses.blindsight === 'number' && distFt <= senses.blindsight) {
    const ray = walkLOS(state.map, observer, target);
    if (ray.cover !== 'total') {
      return { sees: true, cover: ray.cover, obscurance: 'none', via: 'blindsight' };
    }
  }

  // Tremorsense: pinpoint creatures on the same surface (ground). No
  // distinction for flying targets in this game yet, so range alone gates it.
  if (typeof senses.tremorsense === 'number' && distFt <= senses.tremorsense) {
    return { sees: true, cover: 'none', obscurance: 'none', via: 'tremorsense' };
  }

  // Fall through to ordinary sight. Blinded ⇒ no sight at all.
  if (observer.blinded) return { sees: false, cover: 'none', obscurance: 'none', via: 'none' };

  // Invisible target ⇒ unseen by sight (Truesight handles this above).
  if (target.conditions.includes('invisible')) {
    return { sees: false, cover: 'none', obscurance: 'none', via: 'none' };
  }

  // Hidden target ⇒ unseen by passive sight. Active Perception checks via
  // `runPerceptionSweep` opposed by `hideDC` are the only way to spot.
  if (target.conditions.includes('hidden')) {
    return { sees: false, cover: 'none', obscurance: 'none', via: 'none' };
  }

  const ray = walkLOS(state.map, observer, target);
  // Total Cover blocks LOS entirely.
  if (ray.cover === 'total') return { sees: false, cover: 'total', obscurance: ray.obscurance, via: 'none' };

  // Ambient light layered in: dim → lightly; dark → heavily (unless the
  // observer's Darkvision reaches the target's tile, which steps dark → dim).
  const ambient = ambientObscurance(state, observer, target, distFt, senses);
  const finalObscurance = worseObscurance(ray.obscurance, ambient);
  // Heavily Obscured blocks sight entirely (observer is Blinded toward it).
  if (finalObscurance === 'heavily') {
    return { sees: false, cover: ray.cover, obscurance: 'heavily', via: 'none' };
  }
  return { sees: true, cover: ray.cover, obscurance: finalObscurance, via: 'sight' };
}

/**
 * Effective passive perception toward a specific target. Returns a modified
 * PP score factoring in the obscurance and the observer's senses. Used by
 * `runPerceptionSweep` and by the Hide gate.
 */
export function effectivePerception(basePP: number, vision: VisionResult): number {
  if (vision.via === 'truesight' || vision.via === 'blindsight' || vision.via === 'tremorsense') {
    return basePP + 5;
  }
  if (vision.obscurance === 'lightly') return basePP - 5;
  return basePP;
}

/**
 * Run an opposed Perception sweep against the hider. For every potential
 * observer (non-ally, non-incapacitated NPC + the player if the hider is an
 * NPC), roll an active Wisdom (Perception) check + the observer's passive
 * sense modifiers vs the hider's stored `hideDC`. On success, clear the
 * hider's `hidden` (and any companion `invisible` granted by Hide) and log
 * the spot. Returns true when the hider was spotted by at least one
 * observer this sweep.
 */
export function runPerceptionSweep(ctx: GameContext, hider: 'player' | string): boolean {
  const s = ctx.state;
  let hiderObs: Observer | null = null;
  let hideDC = 0;
  let hiderTarget: VisionTarget;
  let hiderLabel: string;
  let clearHidden: () => void;

  if (hider === 'player') {
    if (!s.player.conditions.includes('hidden')) return false;
    if (typeof s.player.hideDC !== 'number') return false;
    hiderObs = {
      tileX: s.player.tileX, tileY: s.player.tileY,
      senses: ctx.playerDef.senses,
    };
    hideDC = s.player.hideDC;
    hiderTarget = {
      tileX: s.player.tileX, tileY: s.player.tileY,
      conditions: s.player.conditions, id: 'player',
    };
    hiderLabel = ctx.playerDef.name;
    clearHidden = () => { clearHide(s.player); };
  } else {
    const npc = s.npcs.find((n) => n.id === hider);
    if (!npc || !npc.conditions.includes('hidden') || typeof npc.hideDC !== 'number') return false;
    const def = ctx.resolveMonsterDef(npc.defId);
    hiderObs = { tileX: npc.tileX, tileY: npc.tileY, senses: def?.senses };
    hideDC = npc.hideDC;
    hiderTarget = { tileX: npc.tileX, tileY: npc.tileY, conditions: npc.conditions, id: npc.id };
    hiderLabel = npc.revealedName ?? npc.name;
    clearHidden = () => { clearHide(npc); };
  }

  const observers: { id: 'player' | string; pp: number; obs: Observer; label: string }[] = [];
  if (hider !== 'player') {
    observers.push({
      id: 'player',
      pp: 10 + (ctx.playerDef.skills['perception'] ?? 0),
      obs: { tileX: s.player.tileX, tileY: s.player.tileY, senses: ctx.playerDef.senses },
      label: ctx.playerDef.name,
    });
  }
  for (const npc of s.npcs) {
    if (npc.id === hider) continue;
    if (npc.hp <= 0) continue;
    if (npc.conditions.includes('incapacitated') || npc.conditions.includes('unconscious')) continue;
    const def = ctx.resolveMonsterDef(npc.defId);
    if (!def) continue;
    observers.push({
      id: npc.id, pp: def.passivePerception,
      obs: { tileX: npc.tileX, tileY: npc.tileY, senses: def.senses },
      label: npc.revealedName ?? npc.name,
    });
  }

  let spotted = false;
  for (const o of observers) {
    const vision = canSee(s, o.obs, { ...hiderTarget, conditions: hiderTarget.conditions.filter((c) => c !== 'hidden' && c !== 'invisible') });
    // Translate the vision result into an effective Perception value.
    const ePP = effectivePerception(o.pp, vision);
    const roll = d20() + (ePP - 10);
    if (roll >= hideDC) {
      ctx.addLog({ left: `${o.label} spots ${hiderLabel}`, right: `Perception ${roll} ≥ DC ${hideDC}`, style: 'status' });
      spotted = true;
      break;
    }
  }
  if (spotted) clearHidden();
  return spotted;
}

// ── Internals ────────────────────────────────────────────────────────────────

interface RayResult { cover: Cover; obscurance: Obscurance; }

/**
 * Bresenham walk between two integer tiles, accumulating the worst cover and
 * obscurance along the line. The endpoints are skipped — a creature does
 * not provide cover to itself, and the target's own tile property doesn't
 * impose obscurance against being seen from outside (you can see a target
 * standing in fog when you're standing right next to them).
 */
function walkLOS(map: GameMap, a: { tileX: number; tileY: number }, b: { tileX: number; tileY: number }): RayResult {
  let x0 = a.tileX, y0 = a.tileY;
  const x1 = b.tileX, y1 = b.tileY;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let cover: Cover = 'none';
  let obs: Obscurance = 'none';

  // Skip the start tile.
  while (true) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    if (x0 === x1 && y0 === y1) break;     // skip end tile too
    cover = worseCover(cover, tileCover(map, x0, y0));
    obs = worseObscurance(obs, tileObs(map, x0, y0));
    if (cover === 'total') break;          // total cover short-circuits
  }
  return { cover, obscurance: obs };
}

function tileCover(map: GameMap, x: number, y: number): Cover {
  const v = map.cover?.[y]?.[x];
  return v ?? 'none';
}

function tileObs(map: GameMap, x: number, y: number): Obscurance {
  const v = map.obscurance?.[y]?.[x];
  return v ?? 'none';
}

const COVER_ORDER: Record<Cover, number> = { 'none': 0, 'half': 1, 'three-quarters': 2, 'total': 3 };
function worseCover(a: Cover, b: Cover): Cover {
  return COVER_ORDER[a] >= COVER_ORDER[b] ? a : b;
}

const OBS_ORDER: Record<Obscurance, number> = { 'none': 0, 'lightly': 1, 'heavily': 2 };
function worseObscurance(a: Obscurance, b: Obscurance): Obscurance {
  return OBS_ORDER[a] >= OBS_ORDER[b] ? a : b;
}

function chebyshevTiles(a: { tileX: number; tileY: number }, b: { tileX: number; tileY: number }): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

/**
 * Ambient obscurance from the encounter's lightLevel, modulated by the
 * observer's Darkvision range. Darkvision converts Dark → Dim within range
 * (so the result is `lightly` instead of `heavily`).
 */
function ambientObscurance(
  state: GameState, observer: Observer, target: VisionTarget, distFt: number, senses: Senses,
): Obscurance {
  const baseline = state.environment.lightLevel ?? 'bright';
  if (baseline === 'bright') return 'none';
  if (baseline === 'dim') return 'lightly';
  // baseline === 'dark'
  if (typeof senses.darkvision === 'number' && distFt <= senses.darkvision) return 'lightly';
  void observer; void target;
  return 'heavily';
}
