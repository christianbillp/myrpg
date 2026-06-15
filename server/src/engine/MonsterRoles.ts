/**
 * Monster combat roles (Tactical Crucible #35) — resolution + inference, and the
 * helpers the tactical AI consults. A role drives POSITIONING and TARGET
 * PRIORITY; it composes with existing traits (Pack Tactics, Nimble Escape,
 * Multiattack) rather than replacing them.
 *
 * `resolveMonsterRole` returns the authored `MonsterDef.role` or, when absent,
 * an inferred role from the stat block so untagged content still behaves
 * sensibly. Implemented behaviors: brute (focus most-wounded), skirmisher /
 * artillery (hold range + kite), leader (morale anchor), controller (lock down
 * the most dangerous foe — stick to a grappled target, else fixate the player),
 * and support (heal the most-wounded ally via `MonsterDef.supportHeal`, hold
 * range when it can). `soldier` is the neutral advance-to-melee default.
 */
import type { GameContext } from './GameContext.js';
import type { MonsterDef, MonsterRole, NpcState } from './types.js';

/** Authored role, or one inferred from the stat block. */
export function resolveMonsterRole(def: MonsterDef): MonsterRole {
  return def.role ?? inferMonsterRole(def);
}

/**
 * Infer a role from the attack profile when none is authored. Deliberately
 * conservative — only the clear signals; everything else is a `soldier`.
 * (Leader / controller / support are author-tagged: a captain or a grappler is
 * a content decision, not reliably guessable.)
 */
export function inferMonsterRole(def: MonsterDef): MonsterRole {
  const attacks = def.attacks ?? [];
  if (attacks.length === 0) return 'soldier';
  const hasMelee = attacks.some((a) => a.attackType === 'melee' || a.attackType === 'both');
  const hasRanged = attacks.some((a) => (a.attackType === 'ranged' || a.attackType === 'both') && (a.rangeNormal ?? 0) > 0);

  // Pure shooter → artillery.
  if (hasRanged && !hasMelee) return 'artillery';

  // Strong, melee-only striker → brute. Best single-hit expected damage as a proxy.
  const meleeDmg = Math.max(0, ...attacks
    .filter((a) => a.attackType !== 'ranged')
    .map((a) => a.damageDice * (a.damageSides + 1) / 2 + a.damageBonus));
  if (!hasRanged && meleeDmg >= 9) return 'brute';

  return 'soldier';
}

/** True when this enemy should hold its weapon's range rather than march into
 *  melee — artillery always; a skirmisher or back-rank support when it actually
 *  has a ranged option. */
export function rolePrefersRange(role: MonsterRole, hasRanged: boolean): boolean {
  return role === 'artillery' || ((role === 'skirmisher' || role === 'support') && hasRanged);
}

/**
 * A living `leader` in this NPC's faction anchors squad morale: while one
 * stands, the rank-and-file hold (no surrender / flee). Its death collapses
 * morale. Excludes the NPC itself (a lone leader doesn't anchor its own morale).
 */
export function factionHasLivingLeader(ctx: GameContext, npc: NpcState): boolean {
  return ctx.state.npcs.some((n) => {
    if (n.id === npc.id || n.hp <= 0 || n.factionId !== npc.factionId) return false;
    const def = ctx.resolveMonsterDef(n.defId);
    return !!def && resolveMonsterRole(def) === 'leader';
  });
}
