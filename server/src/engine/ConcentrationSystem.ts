// Concentration tracking and CON-save-on-damage logic.
//
// SRD: a caster maintaining Concentration on a spell makes a Constitution
// saving throw whenever they take damage (DC max(10, floor(damage/2))).
// On failure, Concentration breaks and the spell ends.

import type { GameContext } from './GameContext.js';
import { d20, mod } from './Dice.js';
import { Logger } from '../Logger.js';

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
  // Self-buff concentration spells set per-spell runtime flags that the
  // generic effect-cleanup above can't reach. Reset them here so the buff
  // doesn't linger past the spell's lifetime.
  if (spellId === 'expeditious-retreat') s.player.expeditiousRetreat = false;
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
  // Blur (Concentration) — strip the `blurred` condition from the caster.
  if (spellId === 'blur') {
    s.player.conditions = s.player.conditions.filter((c) => c !== 'blurred');
  }
  // Invisibility (Concentration) — strip the `invisible` condition from
  // whichever creature was the Invisibility target. `invisibilityTargetId`
  // points at the recipient ('player' for self-cast, or an NPC id). Clear
  // the field so future Invisibility casts start clean.
  if (spellId === 'invisibility') {
    const tid = s.player.invisibilityTargetId;
    if (tid === 'player') {
      s.player.conditions = s.player.conditions.filter((c) => c !== 'invisible');
    } else if (tid) {
      const t = s.npcs.find((n) => n.id === tid);
      if (t) t.conditions = t.conditions.filter((c) => c !== 'invisible');
    }
    s.player.invisibilityTargetId = undefined;
  }
  // Enhance Ability (Concentration) — clear the boosted ability so future
  // ability checks roll normally.
  if (spellId === 'enhance-ability') {
    s.player.enhancedAbility = undefined;
  }
  // Flaming Sphere (Concentration) — despawn the sphere when the spell
  // ends. The summon NPC carries `summonSpellId === 'flaming-sphere'`,
  // so the filter picks it up no matter how many were placed.
  if (spellId === 'flaming-sphere') {
    for (const sphere of s.npcs.filter((n) => n.summonSpellId === 'flaming-sphere' && n.summonOwnerId === 'player')) {
      ctx.removeNpc(sphere.id);
    }
  }
  // Ray of Enfeeblement (Concentration) — strip `enfeebled` from every NPC.
  // Multiple casters / sources aren't modelled in single-player, so the
  // blanket strip is safe.
  if (spellId === 'ray-of-enfeeblement') {
    for (const npc of s.npcs) {
      npc.conditions = npc.conditions.filter((c) => c !== 'enfeebled');
    }
  }
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
  const roll = d20();
  const total = roll + bonus;
  const success = total >= dc;
  ctx.addLog({
    left: `Concentration check (${success ? 'holds' : 'breaks'})`,
    right: `d20(${roll})+${bonus}=${total} vs DC ${dc}`,
    style: success ? 'normal' : 'miss',
  });
  if (!success) endConcentration(ctx, `failed CON save vs damage`);
}
