/**
 * NPC-side concentration (US-117, mage-monster-plan.md slice 5) — a caster
 * monster sustaining its OWN spell (self-Invisibility, Fly). Kept as a leaf
 * module so the NPC damage funnel (`ThresholdPublisher.publishNpcDamage`)
 * can run the SRD check without importing the spell executor. Distinct from
 * buffs the PLAYER sustains on an NPC — those live on `npc.activeBuffs` and
 * end via the player's `endConcentration`.
 */
import type { GameContext } from './GameContext.js';
import type { NpcState } from './types.js';
import { d20 } from './Dice.js';
import { npcSaveMod } from './CombatSystem.js';
import { combatantDisplayName } from './CombatFlow.js';

/** Strip whatever buff `concentratingOn` sustains. */
export function dropNpcConcentration(ctx: GameContext, npc: NpcState): void {
  if (!npc.concentratingOn) return;
  const spellId = npc.concentratingOn;
  npc.concentratingOn = undefined;
  if (spellId === 'invisibility') {
    npc.conditions = npc.conditions.filter((c) => c !== 'invisible');
  }
  if (spellId === 'fly') {
    npc.flying = false;
  }
  ctx.addLog({ left: `${combatantDisplayName(npc, ctx.state.npcs)}'s ${spellId} ends`, style: 'status' });
}

/**
 * SRD concentration check for an NPC caster that just took damage: CON save,
 * DC = max(10, half the damage). On a failure the sustained buff drops.
 * Called from `publishNpcDamage` AFTER hp is updated.
 */
export function breakNpcConcentrationOnDamage(ctx: GameContext, npc: NpcState, damage: number): void {
  if (!npc.concentratingOn || damage <= 0 || npc.hp <= 0) return;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  const dc = Math.max(10, Math.floor(damage / 2));
  const saveBonus = npcSaveMod(npc, def, 'con');
  const roll = d20();
  const total = roll + saveBonus;
  const held = total >= dc;
  ctx.addLog({
    left: `${combatantDisplayName(npc, ctx.state.npcs)} ${held ? 'holds' : 'loses'} concentration`,
    right: `CON d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
    style: held ? 'normal' : 'status',
  });
  if (!held) dropNpcConcentration(ctx, npc);
}
