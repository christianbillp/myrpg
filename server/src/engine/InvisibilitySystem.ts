/**
 * Invisibility concealment — the SRD "find me" layer on the Invisibility spell.
 *
 * The Invisible *condition* already grants attackers Disadvantage (see
 * `ConditionSystem`). On top of that, the Invisibility spell makes the creature
 * genuinely hard to locate, modelled on the SRD Hide action's find rule: when
 * the spell is cast, the creature's Dexterity (Stealth) total becomes a find DC,
 * and every nearby enemy makes a Wisdom (Perception) check against it. An enemy
 * that fails loses track of the creature and **cannot make a direct attack roll
 * against it** until it is found or the spell ends; an enemy that succeeds (or
 * has truesight / blindsight) still sees it and attacks normally — with the
 * Invisible condition's Disadvantage.
 *
 * The set of enemies that failed is stored on the concealed creature as
 * `unseenBy` (`PlayerState` / `NpcState`); the combat target picker skips a
 * concealed creature for any attacker in that set, and `endConcentration` clears
 * it when Invisibility ends.
 */
import type { GameContext } from './GameContext.js';
import type { NpcState, GameState } from './types.js';
import { d20, mod } from './Dice.js';
import { isHostileTo } from './FactionRelations.js';
import { PLAYER_ID, PLAYER_FACTION_ID } from '../../../shared/types.js';

/** A truesight/blindsight sense defeats Invisibility outright — such an enemy
 *  always finds the creature regardless of the Perception roll. */
function attackerPiercesInvisibility(ctx: GameContext, attacker: NpcState): boolean {
  const senses = ctx.resolveMonsterDef(attacker.defId)?.senses;
  return !!senses && ((senses.truesight ?? 0) > 0 || (senses.blindsight ?? 0) > 0);
}

/**
 * Roll the find checks for a freshly-cast Invisibility on `targetId` (`'player'`
 * or an NPC id). Records the enemies that fail to locate it in the carrier's
 * `unseenBy`. Returns the find DC + the number that lost track, for logging.
 */
export function applyInvisibilityConcealment(ctx: GameContext, targetId: string): { findDc: number; lost: number; total: number } {
  const s = ctx.state;
  const isPlayer = targetId === PLAYER_ID || targetId === 'player';

  // Find DC = the concealed creature's Dexterity (Stealth) total (SRD Hide).
  let findDc: number;
  let targetView: { id: string; factionId: string };
  if (isPlayer) {
    findDc = d20() + (ctx.playerDef.skills['stealth'] ?? mod(ctx.playerDef.dex));
    targetView = { id: PLAYER_ID, factionId: PLAYER_FACTION_ID };
  } else {
    const npc = s.npcs.find((n) => n.id === targetId);
    if (!npc) return { findDc: 0, lost: 0, total: 0 };
    findDc = d20() + (ctx.resolveMonsterDef(npc.defId)?.stealthBonus ?? 0);
    targetView = { id: npc.id, factionId: npc.factionId };
  }

  // Every living enemy of the concealed creature rolls Wisdom (Perception)
  // against the find DC. Failures lose track; truesight/blindsight auto-finds.
  const unseenBy: string[] = [];
  let total = 0;
  for (const enemy of s.npcs) {
    if (enemy.id === targetId || enemy.hp <= 0) continue;
    if (!isHostileTo(s, { id: enemy.id, factionId: enemy.factionId }, targetView)) continue;
    total++;
    if (attackerPiercesInvisibility(ctx, enemy)) continue; // always finds it
    const perceptionMod = (ctx.resolveMonsterDef(enemy.defId)?.passivePerception ?? 10) - 10;
    if (d20() + perceptionMod < findDc) unseenBy.push(enemy.id);
  }

  if (isPlayer) s.player.unseenBy = unseenBy;
  else { const npc = s.npcs.find((n) => n.id === targetId); if (npc) npc.unseenBy = unseenBy; }

  return { findDc, lost: unseenBy.length, total };
}

/** Log a one-line summary of how many nearby enemies lost track of the now-
 *  invisible creature. */
export function logInvisibilityFind(ctx: GameContext, result: { findDc: number; lost: number; total: number }, name: string): void {
  if (result.total === 0) return; // no enemies near — nothing to narrate
  const verb = result.lost === 1 ? 'enemy loses' : 'enemies lose';
  ctx.addLog({
    left: `${name} slips out of sight — ${result.lost}/${result.total} nearby ${verb} track of them`,
    right: `find DC ${result.findDc}`,
    style: 'status',
  });
}

/**
 * True when `attackerId` cannot make a direct attack roll against the given
 * concealed creature — it is Invisible and the attacker is in its `unseenBy`
 * set (failed to find it). Consulted by the combat target picker.
 */
export function attackerCannotLocate(
  attackerId: string,
  carrier: { conditions: string[]; unseenBy?: string[] },
): boolean {
  return carrier.conditions.includes('invisible') && (carrier.unseenBy?.includes(attackerId) ?? false);
}

/** Clear all Invisibility find-state when the spell ends (called from
 *  `endConcentration`). */
export function clearInvisibilityConcealment(s: Pick<GameState, 'player' | 'npcs'>): void {
  s.player.unseenBy = undefined;
  for (const npc of s.npcs) npc.unseenBy = undefined;
}
