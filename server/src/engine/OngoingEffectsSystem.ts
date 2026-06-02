import { GameEvent, NpcState, OngoingEffect, AttackOnHitEffect } from './types.js';
import type { GameContext } from './GameContext.js';
import { d as rollDie } from './Dice.js';

/**
 * Periodic-damage effects (DoTs, stirge Proboscis attach) sustained by an NPC
 * source. Each effect lives on whoever is taking the damage; the source NPC's
 * id is recorded so the engine can fire the damage at the start of that NPC's
 * turn and end the effect cleanly if the source is removed.
 *
 * Today only `attach` is implemented (SRD Stirge Proboscis). Adding more
 * periodic effects (poison-needle, burning, …) means extending OngoingEffect
 * and the application logic here — callers and turn hooks stay untouched.
 */

type AttachOngoingEffect = Extract<OngoingEffect, { kind: 'attach' }>;

function rollDot(dot: AttachOngoingEffect['dot']): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  for (let i = 0; i < dot.dice; i++) rolls.push(rollDie(dot.sides));
  return { total: rolls.reduce((a, b) => a + b, 0) + dot.bonus, rolls };
}

/**
 * Apply on-hit attach effects from a monster attack onto the player. Called
 * after primary damage lands. Idempotent — re-applying from the same source
 * just refreshes (we do not stack duplicates from the same NPC).
 */
export function applyMonsterAttachToPlayer(
  ctx: GameContext,
  source: NpcState,
  effects: AttackOnHitEffect[] | undefined,
): void {
  if (!effects) return;
  for (const eff of effects) {
    if (eff.kind !== 'attach') continue;
    const existing = ctx.state.player.ongoingEffects.find(
      (oe) => oe.kind === 'attach' && oe.sourceNpcId === source.id,
    );
    if (existing) continue;
    ctx.state.player.ongoingEffects.push({
      id: ctx.uid(),
      kind: 'attach',
      sourceNpcId: source.id,
      dot: eff.dot,
    });
    ctx.addLog({ left: `${source.name} latches on — ${eff.dot.dice}d${eff.dot.sides}${eff.dot.bonus ? `+${eff.dot.bonus}` : ''} ${eff.dot.damageType} at the start of its turns`, style: 'status' });
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
      npc.hp = Math.max(0, npc.hp - finalDamage);
    }
  }
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
