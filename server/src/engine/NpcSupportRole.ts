/**
 * Support-role healing (Tactical Crucible #35 v2) — the NON-spell heal path.
 *
 * A `support`-role creature without a full Spellcasting block (a goblin shaman's
 * bound-wounds, a cultist's healing draught) patches up its most-wounded ally
 * from the back rank instead of trading blows. Spellcaster healers go through
 * `NpcSpellcasting.tryNpcSupportCast` (Healing Word / Bless); this is the
 * lighter, stat-driven twin authored via `MonsterDef.supportHeal`.
 *
 * Called from `runSingleEnemyTurn` before the attack phase: when it heals, the
 * creature has spent its action and the turn ends (it stays at range rather than
 * marching into melee). Limited to `supportHeal.uses` per combat, tracked on
 * `NpcState.supportHealUsed`.
 */
import type { GameContext } from './GameContext.js';
import type { NpcState, MonsterDef } from './types.js';
import { combatantDisplayName } from './DisplayNames.js';
import { chebyshev } from './EnemyAI.js';
import { Logger } from '../Logger.js';

/** Roll `dice`d`sides` + bonus for a heal amount (min 1). */
function rollHeal(dice: number, sides: number, bonus: number): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  for (let i = 0; i < Math.max(1, dice); i++) rolls.push(1 + Math.floor(Math.random() * sides));
  return { total: Math.max(1, rolls.reduce((a, b) => a + b, 0) + bonus), rolls };
}

/**
 * If this creature is a support-role healer with a `supportHeal` ability and a
 * wounded ally in reach, mend the most-wounded one and return true (the caller
 * ends the turn). Returns false when there's nothing to heal, no uses left, or
 * the creature isn't a non-spell support healer.
 */
export function tryNpcRoleHeal(ctx: GameContext, caster: NpcState, def: MonsterDef): boolean {
  const heal = def.supportHeal;
  if (!heal) return false;
  const maxUses = heal.uses ?? 2;
  if ((caster.supportHealUsed ?? 0) >= maxUses) return false;

  const s = ctx.state;
  const rangeTiles = Math.max(1, Math.floor((heal.rangeFeet ?? 30) / 5));
  // Most-wounded bloodied friend in reach (self included — a hurt healer mends
  // itself). Pick the lowest HP fraction.
  const wounded = [caster, ...s.npcs.filter((n) =>
    n !== caster && n.hp > 0 && n.disposition === caster.disposition,
  )]
    .filter((n) => n.hp > 0 && n.hp <= n.maxHp / 2
      && chebyshev(caster.tileX, caster.tileY, n.tileX, n.tileY) <= rangeTiles)
    .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
  if (!wounded) return false;

  const { total, rolls } = rollHeal(heal.dice, heal.sides, heal.bonus ?? 0);
  const before = wounded.hp;
  wounded.hp = Math.min(wounded.maxHp, wounded.hp + total);
  caster.supportHealUsed = (caster.supportHealUsed ?? 0) + 1;
  const casterName = combatantDisplayName(caster, s.npcs);
  ctx.addLog({
    left: `${casterName} uses ${heal.name} — ${wounded === caster ? 'it' : combatantDisplayName(wounded, s.npcs)} regains ${wounded.hp - before} HP`,
    right: `${heal.dice}d${heal.sides}[${rolls.join(',')}]${heal.bonus ? `+${heal.bonus}` : ''}`,
    style: 'heal',
  });
  Logger.log('ai.role_heal', { casterId: caster.id, ability: heal.name, targetId: wounded.id, healed: wounded.hp - before });
  return true;
}
