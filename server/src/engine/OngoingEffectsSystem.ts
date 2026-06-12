import { GameEvent, NpcState, OngoingEffect, AttackOnHitEffect } from './types.js';
import type { GameContext } from './GameContext.js';
import { d as rollDie, d20, mod } from './Dice.js';
import { autoFailsStrDexSave, onHitExempt } from './ConditionSystem.js';
import { applyNpcDamageInstance } from './NpcDamage.js';
import { sizeRank } from '../../../shared/types.js';

/**
 * On-hit effects authored on monster attacks (`MonsterAttack.onHit`) and the
 * periodic-damage effects they leave behind. Each periodic effect lives on
 * whoever is taking the damage; the source NPC's id is recorded so the engine
 * can fire the damage at the start of that NPC's turn and end the effect
 * cleanly if the source is removed.
 *
 * Implemented kinds: `attach` (SRD Stirge Proboscis), `save` (SRD Ghoul Claw
 * — save or gain a condition until the end of the target's next turn) and
 * `ability_drain` (SRD Shadow Draining Swipe — Strength −1d4, death at 0).
 */

type AttachOngoingEffect = Extract<OngoingEffect, { kind: 'attach' }>;

function rollDot(dot: AttachOngoingEffect['dot']): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  for (let i = 0; i < dot.dice; i++) rolls.push(rollDie(dot.sides));
  return { total: rolls.reduce((a, b) => a + b, 0) + dot.bonus, rolls };
}

/**
 * Apply on-hit effects from a monster attack onto the player. Called after
 * primary damage lands. `attach` is idempotent — re-applying from the same
 * source just refreshes (we do not stack duplicates from the same NPC).
 */
export function applyMonsterOnHitToPlayer(
  ctx: GameContext,
  source: NpcState,
  effects: AttackOnHitEffect[] | undefined,
): void {
  if (!effects) return;
  const player = ctx.state.player;
  for (const eff of effects) {
    if (eff.kind === 'attach') {
      const existing = player.ongoingEffects.find(
        (oe) => oe.kind === 'attach' && oe.sourceNpcId === source.id,
      );
      if (existing) continue;
      player.ongoingEffects.push({
        id: ctx.uid(),
        kind: 'attach',
        sourceNpcId: source.id,
        dot: eff.dot,
      });
      ctx.addLog({ left: `${source.name} latches on — ${eff.dot.dice}d${eff.dot.sides}${eff.dot.bonus ? `+${eff.dot.bonus}` : ''} ${eff.dot.damageType} at the start of its turns`, style: 'status' });
    } else if (eff.kind === 'save') {
      if (onHitExempt(eff.exemptTypes, `${ctx.playerDef.speciesName} ${ctx.playerDef.speciesId}`)) continue;
      if (player.conditions.includes(eff.condition)) continue;
      const autoFail = (eff.ability === 'str' || eff.ability === 'dex') && autoFailsStrDexSave(player.conditions);
      const saveBonus = mod(ctx.playerDef[eff.ability])
        + (ctx.playerDef.savingThrowProficiencies.includes(eff.ability) ? ctx.playerDef.proficiencyBonus : 0);
      const roll = autoFail ? 0 : d20();
      const total = roll + saveBonus;
      const success = !autoFail && total >= eff.dc;
      ctx.addLog({
        left: `${ctx.playerDef.name} ${success ? 'resists' : `is ${eff.condition}`} — ${source.name}`,
        right: autoFail ? `auto-fail vs DC ${eff.dc}` : `${eff.ability.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${eff.dc}`,
        style: success ? 'normal' : 'status',
      });
      if (success) continue;
      player.conditions.push(eff.condition);
      // "Until the end of its next turn" — ticked down by endPlayerTurn, so
      // the strip fires at the end of the player's first full turn after the
      // hit. `spellId` carries the source's name for the recovery log line.
      // `untilSourceTurnStart` effects (Enthralling Panache) additionally
      // expire when the source NPC's next turn begins — whichever comes first.
      player.ongoingEffects.push({
        id: ctx.uid(),
        kind: 'spell-condition',
        spellId: source.name,
        condition: eff.condition,
        turnsRemaining: 1,
        sourceNpcId: source.id,
        untilSourceTurnStart: eff.untilSourceTurnStart,
      });
    } else if (eff.kind === 'condition') {
      // SRD 2024 monster grapple (Bugbear Grab): auto-applies on the hit —
      // no save — gated by target size; the Escape action (Athletics /
      // Acrobatics vs `escapeDc`) or the grappler's death ends it.
      if (player.conditions.includes(eff.condition)) continue;
      if (eff.maxTargetSize && sizeRank(ctx.playerDef.size ?? 'medium') > sizeRank(eff.maxTargetSize)) continue;
      player.conditions.push(eff.condition);
      if (eff.condition === 'grappled') {
        player.grappledBy = { npcId: source.id, escapeDc: eff.escapeDc };
      }
      ctx.addLog({ left: `${source.name} grabs ${ctx.playerDef.name} — ${eff.condition} (escape DC ${eff.escapeDc})`, style: 'status' });
    } else if (eff.kind === 'ability_drain') {
      const rolls: number[] = [];
      for (let i = 0; i < eff.dice; i++) rolls.push(rollDie(eff.sides));
      const drain = rolls.reduce((a, b) => a + b, 0);
      const before = ctx.playerDef[eff.ability];
      const drained = Math.min(before, drain);
      ctx.playerDef[eff.ability] = before - drained;
      player.strengthDrained = (player.strengthDrained ?? 0) + drained;
      ctx.addLog({
        left: `${source.name} drains ${ctx.playerDef.name}'s Strength — ${before} → ${ctx.playerDef[eff.ability]}`,
        right: `${eff.dice}d${eff.sides}[${rolls.join(',')}]`,
        style: 'hit',
      });
      if (ctx.playerDef[eff.ability] <= 0) {
        player.hp = 0;
        ctx.addLog({ left: `${ctx.playerDef.name}'s strength is utterly consumed — they have died.`, style: 'kill' });
        ctx.state.phase = 'defeat';
      }
    }
  }
}

/**
 * Returns true when `npc` currently has at least one attach effect attached
 * to the player (or to any other target). Used by AI to decide whether the
 * attacker can act normally this turn — attached attackers skip Proboscis.
 */
export function isAttacker(npc: NpcState, ctx: GameContext): boolean {
  const onPlayer = ctx.state.player.ongoingEffects.some(
    (oe) => oe.kind === 'attach' && oe.sourceNpcId === npc.id,
  );
  if (onPlayer) return true;
  return ctx.state.npcs.some((n) =>
    n.ongoingEffects.some((oe) => oe.kind === 'attach' && oe.sourceNpcId === npc.id),
  );
}

/**
 * Fire periodic damage authored by `combatantId` at the start of their turn.
 * Iterates the player and every NPC, applying any `attach` effect whose
 * sourceNpcId matches.
 */
export function applyTurnStartPeriodicDamage(
  ctx: GameContext,
  combatantId: string,
  events: GameEvent[],
): void {
  const s = ctx.state;

  // Player victim.
  const playerHits = s.player.ongoingEffects.filter(
    (oe): oe is AttachOngoingEffect => oe.kind === 'attach' && oe.sourceNpcId === combatantId,
  );
  for (const eff of playerHits) {
    if (s.player.hp <= 0) break;
    const { total, rolls } = rollDot(eff.dot);
    const damage = Math.max(0, total);
    const source = s.npcs.find((n) => n.id === combatantId);
    const sourceName = source?.name ?? 'creature';
    ctx.addLog({
      left: `${sourceName} drains ${ctx.playerDef.name} — ${damage} ${eff.dot.damageType}`,
      right: `${eff.dot.dice}d${eff.dot.sides}[${rolls.join(',')}]${eff.dot.bonus ? `+${eff.dot.bonus}` : ''}`,
      style: 'hit',
    });
    ctx.applyDamageToPlayer(damage, events);
  }

  // NPC victims.
  for (const npc of s.npcs) {
    if (npc.hp <= 0) continue;
    const npcHits = npc.ongoingEffects.filter(
      (oe): oe is AttachOngoingEffect => oe.kind === 'attach' && oe.sourceNpcId === combatantId,
    );
    for (const eff of npcHits) {
      if (npc.hp <= 0) break;
      const { total, rolls } = rollDot(eff.dot);
      const damage = Math.max(0, total);
      const def = ctx.resolveMonsterDef(npc.defId);
      const targetName = npc.name;
      let finalDamage = damage;
      if (def) {
        const { finalDamage: fd, log } = ctx.resistMod(damage, eff.dot.damageType, def, targetName);
        finalDamage = fd;
        if (log) ctx.addLog(log);
      }
      ctx.addLog({
        left: `${targetName} bleeds — ${finalDamage} ${eff.dot.damageType}`,
        right: `${eff.dot.dice}d${eff.dot.sides}[${rolls.join(',')}]${eff.dot.bonus ? `+${eff.dot.bonus}` : ''}`,
        style: 'hit',
      });
      if (def) applyNpcDamageInstance(ctx, npc, def, finalDamage, eff.dot.damageType);
      else npc.hp = Math.max(0, npc.hp - finalDamage);
    }
  }
}

/**
 * Expire every "until the start of the source's next turn" condition imposed
 * by `sourceNpcId` (US-125, Enthralling Panache) — called when that NPC's
 * turn begins. Sweeps the player and every NPC victim.
 */
export function expireSourceTurnStartConditions(ctx: GameContext, sourceNpcId: string): void {
  const sweep = (holder: { conditions: string[]; ongoingEffects: OngoingEffect[] }, name: string): void => {
    const expiring = holder.ongoingEffects.filter(
      (oe) => oe.kind === 'spell-condition' && oe.sourceNpcId === sourceNpcId && oe.untilSourceTurnStart,
    );
    if (expiring.length === 0) return;
    for (const oe of expiring) {
      if (oe.kind !== 'spell-condition') continue;
      holder.conditions = holder.conditions.filter((c) => c !== oe.condition);
      ctx.addLog({ left: `${name} recovers from ${oe.spellId} (${oe.condition})`, style: 'status' });
    }
    holder.ongoingEffects = holder.ongoingEffects.filter((oe) => !expiring.includes(oe));
  };
  sweep(ctx.state.player, ctx.playerDef.name);
  for (const npc of ctx.state.npcs) sweep(npc, npc.name);
}

/**
 * Detach every `attach` effect on the player sourced from `npcId`. Used both
 * by the player's Detach action and when the source NPC dies / is removed.
 */
export function detachPlayerEffectsFrom(ctx: GameContext, npcId: string): boolean {
  const before = ctx.state.player.ongoingEffects.length;
  ctx.state.player.ongoingEffects = ctx.state.player.ongoingEffects.filter(
    (oe) => !(oe.kind === 'attach' && oe.sourceNpcId === npcId),
  );
  return ctx.state.player.ongoingEffects.length < before;
}
