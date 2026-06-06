// Concentration tracking and CON-save-on-damage logic.
//
// SRD: a caster maintaining Concentration on a spell makes a Constitution
// saving throw whenever they take damage (DC max(10, floor(damage/2))).
// On failure, Concentration breaks and the spell ends.

import type { GameContext } from './GameContext.js';
import { d20, mod, applyHalflingLuck } from './Dice.js';
import { Logger } from '../Logger.js';
import { removeBuffsForSpell, removeSpellBuffsFrom } from './Buffs.js';

/** Begin concentrating on `spellId` — drops any previous concentration first. */
export function startConcentration(ctx: GameContext, spellId: string): void {
  const s = ctx.state;
  if (s.player.concentratingOn && s.player.concentratingOn !== spellId) {
    endConcentration(ctx, /*reason*/ 'replaced by a new concentration spell');
  }
  s.player.concentratingOn = spellId;
  Logger.log('spell.concentration_started', { spellId });
}

/** End concentration with an in-fiction log line. Clears any spell-specific lasting effect flags as needed. */
export function endConcentration(ctx: GameContext, reason: string): void {
  const s = ctx.state;
  if (!s.player.concentratingOn) return;
  const spellId = s.player.concentratingOn;
  const spell = ctx.defs.spells.find((sp) => sp.id === spellId);
  Logger.log('spell.concentration_ended', { spellId, reason });
  ctx.addLog({ left: `Concentration on ${spell?.name ?? spellId} ends — ${reason}`, style: 'status' });

  // Strip every condition the spell's effect block applied (Sleep →
  // incapacitated, unconscious; Hideous Laughter → prone, incapacitated;
  // Charm Person → charmed). The cleanup is approximate — a creature with
  // the same condition from another source loses it too — but acceptable
  // given the shipped roster has no overlapping sources.
  if (spell?.effect) {
    const cleanup = new Set<string>();
    const fail = spell.effect.onFail;
    if (Array.isArray(fail))      for (const c of fail) cleanup.add(c);
    else if (typeof fail === 'string') cleanup.add(fail);
    if (spell.effect.onSecondFail) cleanup.add(spell.effect.onSecondFail);
    if (cleanup.size > 0) {
      for (const npc of s.npcs) {
        npc.conditions = npc.conditions.filter((c) => !cleanup.has(c));
      }
    }
  }
  // Active zones tied to this spell — SRD ruling: a concentration spell's
  // area ends when concentration ends. Strip the zone's `condition` from
  // every creature it tagged (tracked via `affectedNpcIds` so a creature
  // that's been pushed / teleported out of the original tile set still
  // clears the condition), then drop the zone record. Non-concentration
  // zone spells (Grease) survive concentration events.
  if (s.activeZones && s.activeZones.length > 0) {
    const dyingZones = s.activeZones.filter((z) => z.spellId === spellId);
    s.activeZones = s.activeZones.filter((z) => z.spellId !== spellId);
    for (const z of dyingZones) {
      if (!z.condition) continue;
      for (const id of z.affectedNpcIds) {
        const npc = s.npcs.find((n) => n.id === id);
        if (!npc) continue;
        npc.conditions = npc.conditions.filter((c) => c !== z.condition);
      }
      if (z.affectedPlayer) {
        s.player.conditions = s.player.conditions.filter((c) => c !== z.condition);
      }
    }
  }
  // Self-buffs recorded on `activeBuffs` (Blur's `blurred` condition, Magic
  // Weapon's bonus, …) — strip their conditions, drop the buff, and recompute
  // the derived fields generically. Replaces the per-spell branches. The buff
  // may live on the player (self-cast) OR an NPC (Invisibility on another
  // creature), so sweep every creature for buffs from the ending spell.
  removeBuffsForSpell(ctx, spellId);
  for (const npc of s.npcs) removeSpellBuffsFrom(npc, spellId);
  // Invisibility's `invisible` condition is stripped by the creature-agnostic
  // buff cleanup above; clear the end-on-attack pointer so a future cast starts
  // clean.
  if (spellId === 'invisibility') s.player.invisibilityTargetId = undefined;
  // Concentration-bound summons (Flaming Sphere, …) despawn when the spell
  // ends. Each summon NPC carries the `summonSpellId` that conjured it, so
  // dropping every player-owned summon from the ending spell is generic — a
  // new tethered-summon spell gets this for free, no id branch.
  for (const summon of s.npcs.filter((n) => n.summonSpellId === spellId && n.summonOwnerId === 'player')) {
    ctx.removeNpc(summon.id);
  }
  // (Ray of Enfeeblement's `enfeebled` is stripped by the generic
  // `effect.onFail` cleanup above — no spell-specific branch needed.)
  s.player.concentratingOn = null;
}

/**
 * Roll a CON save when the player takes damage while concentrating.
 * DC = max(10, ⌊damage/2⌋). On failure, concentration ends.
 */
export function maybeBreakConcentration(ctx: GameContext, damage: number): void {
  const s = ctx.state;
  if (!s.player.concentratingOn || damage <= 0) return;
  const dc = Math.max(10, Math.floor(damage / 2));
  const conMod = mod(ctx.playerDef.con);
  const conProf = ctx.playerDef.savingThrowProficiencies.includes('con') ? ctx.playerDef.proficiencyBonus : 0;
  const bonus = conMod + conProf;
  const roll = applyHalflingLuck(d20(), ctx.playerDef.halflingLuck).natural;
  const total = roll + bonus;
  const success = total >= dc;
  ctx.addLog({
    left: `Concentration check (${success ? 'holds' : 'breaks'})`,
    right: `d20(${roll})+${bonus}=${total} vs DC ${dc}`,
    style: success ? 'normal' : 'miss',
  });
  if (!success) endConcentration(ctx, `failed CON save vs damage`);
}
