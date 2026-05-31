// Concentration tracking and CON-save-on-damage logic.
//
// SRD: a caster maintaining Concentration on a spell makes a Constitution
// saving throw whenever they take damage (DC max(10, floor(damage/2))).
// On failure, Concentration breaks and the spell ends.

import type { GameContext } from './GameContext.js';
import { d20, mod } from './Dice.js';

/** Begin concentrating on `spellId` — drops any previous concentration first. */
export function startConcentration(ctx: GameContext, spellId: string): void {
  const s = ctx.state;
  if (s.player.concentratingOn && s.player.concentratingOn !== spellId) {
    endConcentration(ctx, /*reason*/ 'replaced by a new concentration spell');
  }
  s.player.concentratingOn = spellId;
}

/** End concentration with an in-fiction log line. Clears any spell-specific lasting effect flags as needed. */
export function endConcentration(ctx: GameContext, reason: string): void {
  const s = ctx.state;
  if (!s.player.concentratingOn) return;
  const spellId = s.player.concentratingOn;
  const spell = ctx.defs.spells.find((sp) => sp.id === spellId);
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
  // Area-zone concentration spells (Fog Cloud) tagged their occupants with
  // a status condition at cast time. Strip it from every creature + the
  // caster so chips and the AIGM both reflect the cloud is gone.
  if (spellId === 'fog-cloud') {
    for (const npc of s.npcs) {
      npc.conditions = npc.conditions.filter((c) => c !== 'heavily-obscured');
    }
    s.player.conditions = s.player.conditions.filter((c) => c !== 'heavily-obscured');
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
