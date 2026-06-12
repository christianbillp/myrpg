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
import { applyDamageWithTempHp, tryUndeadFortitude, npcSaveMod } from './CombatSystem.js';
import { npcConditionImmune, autoFailsStrDexSave, onHitExempt } from './ConditionSystem.js';
import { d20 } from './Dice.js';
import { sizeRank } from '../../../shared/types.js';
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
 * Resolve a save-or-condition effect against an NPC target — monster on-hit
 * saves (Ghoul Claw) and attack-replacement save actions (Enthralling
 * Panache, US-125). Honours type exemptions, condition immunities, and the
 * Str/Dex auto-fail conditions. On a failed save the condition lands with a
 * `spell-condition` expiry (≈ until the end of the target's next turn; an
 * `untilSourceTurnStart` effect also expires when the source acts).
 */
export function applyOnHitSaveToNpc(
  ctx: GameContext,
  attacker: NpcState,
  target: NpcState,
  targetDef: MonsterDef,
  eff: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; dc: number; condition: string; exemptTypes?: string[]; untilSourceTurnStart?: boolean },
): void {
  if (onHitExempt(eff.exemptTypes, targetDef.type)) return;
  if (npcConditionImmune(targetDef, eff.condition)) return;
  if (target.conditions.includes(eff.condition)) return;
  const autoFail = (eff.ability === 'str' || eff.ability === 'dex') && autoFailsStrDexSave(target.conditions);
  const saveMod = npcSaveMod(target, targetDef, eff.ability);
  const roll = autoFail ? 0 : d20();
  const total = roll + saveMod;
  const success = !autoFail && total >= eff.dc;
  ctx.addLog({
    left: `${target.name} ${success ? 'resists' : `is ${eff.condition}`} — ${attacker.name}`,
    right: autoFail ? `auto-fail vs DC ${eff.dc}` : `${eff.ability.toUpperCase()} d20(${roll})${saveMod >= 0 ? '+' : ''}${saveMod}=${total} vs DC ${eff.dc}`,
    style: success ? 'normal' : 'status',
  });
  if (success) return;
  target.conditions.push(eff.condition);
  target.ongoingEffects.push({
    id: ctx.uid(),
    kind: 'spell-condition',
    spellId: attacker.name,
    condition: eff.condition,
    turnsRemaining: 2,
    sourceNpcId: attacker.id,
    untilSourceTurnStart: eff.untilSourceTurnStart,
  });
}

/**
 * The canonical single-instance NPC damage mutation: Temporary HP absorbs
 * first, real HP drops, and Undead Fortitude rolls immediately after — so the
 * caller's kill check only sees creatures the save didn't pick back up.
 * `amount` is POST-resistance (callers route through `ctx.resistMod` first).
 * Every per-instance on-damage mechanic belongs here, not at the call sites.
 */
export function applyNpcDamageInstance(
  ctx: GameContext,
  target: NpcState,
  targetDef: MonsterDef,
  amount: number,
  damageType: string,
  isCrit = false,
): void {
  applyDamageWithTempHp(target, amount);
  const { log } = tryUndeadFortitude(target, targetDef, amount, damageType, isCrit);
  if (log) ctx.addLog(log);
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
  applyNpcDamageInstance(ctx, target, targetDef, finalDamage, damageType, result.isCrit);

  // Secondary damage riders (cultist necrotic, etc.) — each rolls through
  // resistance on its own type so a fire-resistant target halves the fire
  // rider but takes the slashing primary in full.
  for (const bd of result.bonusComponents) {
    const { finalDamage: bdFinal, log: bdResistLog } = ctx.resistMod(bd.damage, bd.damageType, targetDef, target.name);
    ctx.addLog({ left: `+ ${bdFinal} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
    if (bdResistLog) ctx.addLog(bdResistLog);
    applyNpcDamageInstance(ctx, target, targetDef, bdFinal, bd.damageType, result.isCrit);
  }

  // On-hit riders against an NPC target: save-or-condition (Ghoul Claw →
  // Paralyzed) and auto-apply grapples (Bugbear Grab). Save conditions
  // expire via the same `spell-condition` tick the spell path uses (two
  // end-of-player-turn decrements ≈ "until the end of its next turn").
  if (target.hp > 0) {
    for (const eff of result.attackOnHit ?? []) {
      if (eff.kind === 'save') {
        applyOnHitSaveToNpc(ctx, attacker, target, targetDef, eff);
      } else if (eff.kind === 'condition') {
        if (npcConditionImmune(targetDef, eff.condition)) continue;
        if (target.conditions.includes(eff.condition)) continue;
        if (eff.maxTargetSize && sizeRank(target.size ?? targetDef.size ?? 'medium') > sizeRank(eff.maxTargetSize)) continue;
        target.conditions.push(eff.condition);
        if (eff.condition === 'grappled') target.grappledBy = attacker.id;
        ctx.addLog({ left: `${attacker.name} grabs ${target.name} — ${eff.condition} (escape DC ${eff.escapeDc})`, style: 'status' });
      }
    }
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
