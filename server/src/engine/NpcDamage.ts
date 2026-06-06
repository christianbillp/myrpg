/**
 * NpcDamage — the canonical "apply an NPC's attack hit to another NPC" path.
 *
 * Three call sites used to inline the same logic with subtle drift:
 *   • Combat-phase enemy turn (Pass 3a)  — XP not awarded.
 *   • Combat-phase ally turn              — XP awarded.
 *   • Off-camera world tick (Pass 3c)     — XP not awarded.
 *
 * Each one walked the resistance roll, primary damage, bonus components,
 * publishNpcDamage, kill detection, and chose between `killWithReward`
 * (with player XP) and `killNpc` (silent). Consolidating them here removes
 * the duplication and means future on-hit-effect work (attach, riders) only
 * has to land in one place.
 */
import type { GameContext } from './GameContext.js';
import type { NpcState, MonsterDef } from './types.js';
import type { RolledBonusDamage } from './CombatSystem.js';
import { applyDamageWithTempHp } from './CombatSystem.js';
import { publishNpcDamage } from './ThresholdPublisher.js';

export interface NpcAttackHit {
  damage: number;
  isCrit: boolean;
  bonusComponents: RolledBonusDamage[];
  /** Future scope — on-hit effects authored on the attack (attach, etc.). */
  attackOnHit?: import('./types.js').AttackOnHitEffect[];
}

export interface ApplyNpcAttackHitOpts {
  ctx: GameContext;
  /** The attacking NPC — used for the kill log's "slain by …" attribution. */
  attacker: NpcState;
  /** The defending NPC. The caller has already verified hp > 0. */
  target: NpcState;
  /** Resolved attacker MonsterDef. Used to look up the melee damage type for resistance routing. */
  attackerDef: MonsterDef;
  /** Resolved target MonsterDef. Used for the resistance roll + the XP grant on kill. */
  targetDef: MonsterDef;
  /** The roll outcome from `runEnemyTurn` / `runAllyTurn`. */
  result: NpcAttackHit;
  /**
   * Award player XP on kill?
   *   • Ally-driven kills during combat phase → true (player gets XP).
   *   • Enemy-driven NPC-vs-NPC kills (Pass 3a)  → false (player wasn't in the fight).
   *   • Off-camera tick kills (Pass 3c)         → false (player wasn't engaged at all).
   * The non-XP path also customises the kill log line with "slain by <attacker>"
   * so the player can read what just happened off-camera.
   */
  awardXp: boolean;
  /** Pre-disambiguated attacker name for the kill log. Defaults to `attacker.name`. */
  attackerDisplayName?: string;
}

/**
 * Apply an NPC's melee hit to another NPC. Mutates `target.hp`, publishes
 * damage + kill events, and either awards XP (when `awardXp: true`) or logs
 * a "slain by <attacker>" kill line and calls `ctx.killNpc` directly.
 *
 * No-op when `target.hp` is already 0 or no `targetDef` is supplied.
 */
export function applyNpcAttackHit(opts: ApplyNpcAttackHitOpts): void {
  const { ctx, attacker, target, attackerDef, targetDef, result, awardXp } = opts;
  if (target.hp <= 0) return;

  const meleeAttack = attackerDef.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  const damageType = meleeAttack?.damageType ?? '';

  const { finalDamage, log: resistLog } = ctx.resistMod(result.damage, damageType, targetDef, target.name);
  if (resistLog) ctx.addLog(resistLog);
  const hpBefore = target.hp;
  applyDamageWithTempHp(target, finalDamage);

  // Secondary damage riders (cultist necrotic, etc.) — each rolls through
  // resistance on its own type so a fire-resistant target halves the fire
  // rider but takes the slashing primary in full.
  for (const bd of result.bonusComponents) {
    const { finalDamage: bdFinal, log: bdResistLog } = ctx.resistMod(bd.damage, bd.damageType, targetDef, target.name);
    ctx.addLog({ left: `+ ${bdFinal} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
    if (bdResistLog) ctx.addLog(bdResistLog);
    applyDamageWithTempHp(target, bdFinal);
  }

  publishNpcDamage(ctx, target, hpBefore, target.hp);
  if (target.hp <= 0) {
    if (awardXp) {
      ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
    } else {
      const who = opts.attackerDisplayName ?? attacker.name;
      ctx.addLog({ left: `☠ ${target.name} is slain by ${who}!`, style: 'kill' });
      ctx.killNpc(target.id);
    }
  }
}
