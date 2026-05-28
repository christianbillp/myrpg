/**
 * WorldTick — Pass 3c real-time off-camera resolve loop.
 *
 * Runs one SRD round (6 seconds of game-world time per real-time tick) of
 * NPC-vs-NPC combat during exploration phase. The player isn't a candidate
 * here — if the player is hostile to anyone, combat phase already handles
 * that via the existing initiative-tracked path. This loop is strictly for
 * "the bandits are fighting the guards while the party watches from cover."
 *
 * Each tick, for every living NPC in random order:
 *   • Pick the nearest hostile NON-PLAYER target via `isHostileTo`.
 *   • Run one full turn through `runEnemyTurn` (move up to speed + one attack).
 *   • Apply damage via `applyEnemyHitToNpc`-equivalent inline logic.
 *
 * Logs are written to the encounter event log; map deltas (movement, kills)
 * surface in the events array the caller broadcasts via `state_update`. The
 * caller is responsible for pause gating (`isWorldTickEligible`) and for
 * pushing the resulting events to the connected client.
 */
import type { GameContext } from './GameContext.js';
import type { GameEvent, NpcState } from './types.js';
import { runEnemyTurn, chebyshev, type EnemyAttackTarget } from './EnemyAI.js';
import { isHostileTo } from './FactionRelations.js';
import { publishNpcDamage } from './ThresholdPublisher.js';

/**
 * Run one round of off-camera NPC-vs-NPC combat. Returns the events the
 * caller should broadcast (entity moves + a final state_update). Mutates the
 * session state in place.
 */
export function runOffCameraTick(ctx: GameContext): GameEvent[] {
  const s = ctx.state;
  const events: GameEvent[] = [];

  // Sort by initiative-equivalent deterministic key so the same NPC doesn't
  // always get the first swing each tick (would feel rigged). Shuffle by a
  // simple per-id hash + tick counter — tick counter is just Date.now().
  const tickSalt = Date.now();
  const order = [...s.npcs]
    .filter((n) => n.hp > 0)
    .sort((a, b) => hash(a.id, tickSalt) - hash(b.id, tickSalt));

  for (const npc of order) {
    // The npc may have been killed earlier in this tick — re-check.
    if (npc.hp <= 0) continue;

    const target = pickHostileNpcTarget(ctx, npc);
    if (!target) continue;

    const def = ctx.resolveMonsterDef(npc.defId);
    if (!def) continue;

    const targetDef = ctx.resolveMonsterDef(target.defId);
    if (!targetDef) continue;

    const occupied: [number, number][] = s.npcs
      .filter((n) => n !== npc && n.hp > 0)
      .map((n): [number, number] => [n.tileX, n.tileY]);

    const snapshot: EnemyAttackTarget = {
      id: target.id,
      displayName: target.name,
      tileX: target.tileX,
      tileY: target.tileY,
      ac: targetDef.ac,
      hp: target.hp,
      hidden: target.conditions.includes('hidden'),
      dodging: target.conditions.includes('dodging'),
      invisible: target.conditions.includes('invisible'),
      passivePerception: 10,
    };

    const result = runEnemyTurn(npc, def, {
      displayName: npc.name,
      target: snapshot,
      passable: s.map.passable,
      mapCols: s.map.cols,
      mapRows: s.map.rows,
      occupiedTiles: occupied,
    });

    // Commit movement + flush the attacker's log.
    npc.tileX = result.finalTileX;
    npc.tileY = result.finalTileY;
    events.push(...result.events);
    ctx.addLogs(result.logs);

    // Apply damage if the attack landed.
    if (result.attacked && result.isHit && result.attackedTargetId && result.attackedTargetId !== 'player') {
      const live = s.npcs.find((n) => n.id === result.attackedTargetId);
      if (live && live.hp > 0) {
        const meleeAttack = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
        const damageType = meleeAttack?.damageType ?? '';
        const { finalDamage, log: resistLog } = ctx.resistMod(result.damage, damageType, targetDef, live.name);
        if (resistLog) ctx.addLog(resistLog);
        const hpBefore = live.hp;
        live.hp = Math.max(0, live.hp - finalDamage);
        for (const bd of result.bonusComponents) {
          const { finalDamage: bdFinal, log: bdResistLog } = ctx.resistMod(bd.damage, bd.damageType, targetDef, live.name);
          ctx.addLog({ left: `+ ${bdFinal} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
          if (bdResistLog) ctx.addLog(bdResistLog);
          live.hp = Math.max(0, live.hp - bdFinal);
        }
        publishNpcDamage(ctx, live, hpBefore, live.hp);
        if (live.hp <= 0) {
          ctx.addLog({ left: `☠ ${live.name} is slain by ${npc.name}!`, style: 'kill' });
          ctx.killNpc(live.id);
        }
      }
    }
  }

  return events;
}

/**
 * Find the nearest non-player creature this NPC considers hostile. Returns
 * undefined when there are no hostile NPC targets — typical of a peaceful
 * scene where the only enmity is toward the player (which combat phase
 * handles, not this loop).
 */
function pickHostileNpcTarget(ctx: GameContext, attacker: NpcState): NpcState | undefined {
  const s = ctx.state;
  const attackerView = { factionId: attacker.factionId, disposition: attacker.disposition };
  let best: NpcState | undefined;
  let bestDist = Infinity;
  for (const other of s.npcs) {
    if (other === attacker || other.hp <= 0) continue;
    const otherView = { factionId: other.factionId, disposition: other.disposition };
    if (!isHostileTo(s, attackerView, otherView)) continue;
    const d = chebyshev(attacker.tileX, attacker.tileY, other.tileX, other.tileY);
    if (d < bestDist) { best = other; bestDist = d; }
  }
  return best;
}

/**
 * Fast deterministic id-string hash used to shuffle the turn order each
 * tick. Mixing in `tickSalt` (the wall clock) means consecutive ticks
 * shuffle differently without us threading a counter through state.
 */
function hash(id: string, salt: number): number {
  let h = salt >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) >>> 0;
  }
  return h;
}
