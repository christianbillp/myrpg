/**
 * NpcTurnRunners — `runSingleEnemyTurn` and `runSingleAllyTurn` and the
 * helpers unique to them. Extracted from `CombatFlow.ts` to keep that file
 * focused on combat lifecycle (start / end / advance / reactions /
 * death-saves) and let the per-NPC turn logic evolve independently.
 *
 * What stays in CombatFlow and is imported back here:
 *   • `combatantDisplayName` — disambiguated label for log lines.
 *   • `playerCanReact`, `shieldAvailable` — gate the player reaction prompts.
 *   • `applyEnemyHitToPlayer` — death-save / Shield-decline path (also used
 *     by `doResolveReaction`).
 *   • `finalizeNpcTurn` — Sleep re-save + per-turn cleanup (also used by
 *     `doResolveReaction`).
 */
import type { GameContext } from './GameContext.js';
import type { GameEvent, NpcState, MonsterDef } from './types.js';
import {
  combatantDisplayName, playerCanReact, shieldAvailable,
  applyEnemyHitToPlayer, finalizeNpcTurn,
} from './CombatFlow.js';
import {
  runEnemyTurn, runAllyTurn, chebyshev, type EnemyAttackTarget,
} from './EnemyAI.js';
import { isHostileTo } from './FactionRelations.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';
import { isIncapacitated, isVisible, TURN_CONDITIONS } from './ConditionSystem.js';
import { doNpcOpportunityAttack } from './CombatActions.js';
import { applyNpcAttackHit } from './NpcDamage.js';
import { chooseNpcBehavior, fleeFromThreat, isMapEdge } from './NpcBrain.js';
import { applyTurnStartPeriodicDamage, isAttacker } from './OngoingEffectsSystem.js';

/**
 * Sum the trait-derived attack-roll modifiers an enemy receives this turn.
 * Pack tactics grants Advantage when at least one ally is also threatening
 * the target; Sunlight Sensitivity imposes Disadvantage when the encounter
 * is flagged sunlit. The two booleans thread into EnemyAI's existing
 * withAdvantage/withDisadvantage logic, where the standard SRD cancellation
 * rule still applies.
 */
/**
 * Flavour line for an incapacitated NPC's "hold" turn, so the log says
 * something more evocative than the bare generic "holds its ground". Picks
 * the most specific match in priority order (unconscious > stunned >
 * paralyzed > prone + incapacitated → Hideous Laughter flavor > plain
 * incapacitated).
 */
function incapacitatedFlavor(conditions: string[]): string {
  if (conditions.includes('unconscious'))  return 'lies unconscious';
  if (conditions.includes('stunned'))      return 'is stunned — cannot act';
  if (conditions.includes('paralyzed'))    return 'is paralyzed — cannot move or act';
  if (conditions.includes('prone') && conditions.includes('incapacitated')) {
    return 'rolls on the ground, helpless with laughter';
  }
  return 'is incapacitated — takes no action';
}

function collectEnemyTraitModifiers(
  ctx: GameContext,
  attacker: NpcState,
  def: MonsterDef,
): { advantage: boolean; disadvantage: boolean } {
  const traits = def.traits ?? [];
  let advantage = false;
  let disadvantage = false;
  if (traits.includes('pack_tactics')) {
    const s = ctx.state;
    const allyAdjacent = s.npcs.some((n) =>
      n !== attacker
      && n.disposition === 'enemy'
      && n.hp > 0
      && !isIncapacitated(n.conditions)
      && chebyshev(n.tileX, n.tileY, s.player.tileX, s.player.tileY) <= 1,
    );
    if (allyAdjacent) advantage = true;
  }
  if (traits.includes('sunlight_sensitivity') && ctx.state.environment.sunlit) {
    disadvantage = true;
  }
  return { advantage, disadvantage };
}

/**
 * Build the `EnemyAttackTarget` snapshot this NPC will engage on its turn.
 * Pass 3a target picking:
 *   • Candidates = the player (always) + every living NPC whose faction
 *     the attacker considers hostile via `isHostileTo` (matrix-first,
 *     disposition fallback).
 *   • Pick the nearest by Chebyshev distance. Ties: prefer the player
 *     (matches the pre-Pass-3 behaviour when nothing else is in range).
 *
 * The result is a generic snapshot — the caller routes damage by checking
 * `result.attackedTargetId === 'player'` vs an NPC id.
 */
function pickEnemyAttackTarget(ctx: GameContext, attacker: NpcState): EnemyAttackTarget {
  const s = ctx.state;
  const attackerView = { factionId: attacker.factionId, disposition: attacker.disposition };
  const playerView = { factionId: PLAYER_FACTION_ID };
  const candidates: Array<{ target: EnemyAttackTarget; dist: number; isPlayer: boolean }> = [];

  if (isHostileTo(s, attackerView, playerView)) {
    candidates.push({
      target: {
        id: 'player',
        displayName: ctx.playerDef.name,
        tileX: s.player.tileX,
        tileY: s.player.tileY,
        ac: ctx.playerDef.ac,
        hp: s.player.hp,
        hidden: s.player.conditions.includes('hidden'),
        dodging: s.player.conditions.includes('dodging'),
        invisible: s.player.conditions.includes('invisible'),
        passivePerception: 10 + (ctx.playerDef.skills['perception'] ?? 0),
      },
      dist: chebyshev(attacker.tileX, attacker.tileY, s.player.tileX, s.player.tileY),
      isPlayer: true,
    });
  }
  for (const other of s.npcs) {
    if (other === attacker || other.hp <= 0) continue;
    const otherView = { factionId: other.factionId, disposition: other.disposition };
    if (!isHostileTo(s, attackerView, otherView)) continue;
    candidates.push({
      target: {
        id: other.id,
        displayName: combatantDisplayName(other, s.npcs),
        tileX: other.tileX,
        tileY: other.tileY,
        ac: ctx.resolveMonsterDef(other.defId)?.ac ?? 10,
        hp: other.hp,
        hidden: other.conditions.includes('hidden'),
        dodging: other.conditions.includes('dodging'),
        invisible: other.conditions.includes('invisible'),
        passivePerception: 10,
      },
      dist: chebyshev(attacker.tileX, attacker.tileY, other.tileX, other.tileY),
      isPlayer: false,
    });
  }
  // No hostile target — synthesise a player-pointed snapshot so the existing
  // "out of reach" / log message still fires. Damage application paths
  // already guard on `result.attacked` so this is harmless.
  if (candidates.length === 0) {
    return {
      id: 'player',
      displayName: ctx.playerDef.name,
      tileX: s.player.tileX, tileY: s.player.tileY,
      ac: ctx.playerDef.ac, hp: s.player.hp,
      hidden: s.player.conditions.includes('hidden'),
      dodging: s.player.conditions.includes('dodging'),
      invisible: s.player.conditions.includes('invisible'),
      passivePerception: 10 + (ctx.playerDef.skills['perception'] ?? 0),
    };
  }
  candidates.sort((a, b) => (a.dist - b.dist) || (a.isPlayer ? -1 : b.isPlayer ? 1 : 0));
  return candidates[0].target;
}

/**
 * Resolve one enemy NPC's combat-phase turn — move, attack, OAs, Shield
 * prompt, damage application. The shared CombatFlow plumbing (advanceTurn /
 * doResolveReaction) calls this; off-camera fights go through `WorldTick`
 * instead.
 */
export function runSingleEnemyTurn(ctx: GameContext, npc: NpcState, events: GameEvent[]): void {
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) { npc.isActive = false; return; }
  // Per SRD: a creature's Reaction refreshes at the start of its own turn,
  // and turn-scoped conditions (Dodge / Dash / Disengage / Slowed) expire
  // at the start of that creature's next turn — clear them here so they
  // actually protect the NPC against incoming attacks during the round.
  npc.reactionUsed = false;
  npc.conditions = npc.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  ctx.publish({ type: 'turn_started', combatantId: npc.id });

  // Periodic damage authored by this NPC (e.g. stirge attach DoT) fires now.
  applyTurnStartPeriodicDamage(ctx, npc.id, events);
  if (s.player.hp <= 0) {
    // The DoT downed the player — let the normal flow handle the unconscious
    // state at the next turn boundary; for this NPC's turn we still finalise.
    finalizeNpcTurn(ctx, npc);
    ctx.publish({ type: 'turn_ended', combatantId: npc.id });
    return;
  }
  // If this NPC is currently attached to a target, it can't make its
  // Proboscis-style attack — skip the attack phase entirely. The DoT fired
  // above is the only thing it accomplishes this turn.
  if (isAttacker(npc, ctx)) {
    finalizeNpcTurn(ctx, npc);
    ctx.publish({ type: 'turn_ended', combatantId: npc.id });
    return;
  }

  // ── NpcBrain — decide behavior ─────────────────────────────────────────
  const behavior = chooseNpcBehavior(ctx, npc, def);
  if (behavior === 'hold') {
    if (!isIncapacitated(npc.conditions)) {
      npc.conditions.push('dodging');
      ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} Dodges — attackers have Disadvantage`, style: 'status' });
    } else {
      ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} ${incapacitatedFlavor(npc.conditions)}`, style: 'status' });
    }
    finalizeNpcTurn(ctx, npc);
    ctx.publish({ type: 'turn_ended', combatantId: npc.id });
    return;
  }
  if (behavior === 'flee') {
    const flee = fleeFromThreat(ctx, npc, def, s.player.tileX, s.player.tileY);
    for (const step of flee.pathTaken) events.push({ type: 'entity_move', entityId: npc.id, toX: step.x, toY: step.y });
    npc.tileX = flee.finalTileX;
    npc.tileY = flee.finalTileY;
    ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} breaks and flees!`, style: 'status' });
    finalizeNpcTurn(ctx, npc);
    ctx.publish({ type: 'turn_ended', combatantId: npc.id });
    // Escape off the map edge — the creature leaves the encounter entirely.
    if (isMapEdge(ctx, npc.tileX, npc.tileY)) {
      ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} escapes off the map edge — gone.`, style: 'status' });
      ctx.removeNpc(npc.id);
    }
    return;
  }
  // behavior === 'attack' — fall through to the existing AI loop.

  const occupied: [number, number][] = s.npcs
    .filter((n) => n !== npc && n.hp > 0)
    .map((n): [number, number] => [n.tileX, n.tileY]);

  const startedAdjacentToPlayer = chebyshev(npc.tileX, npc.tileY, s.player.tileX, s.player.tileY) <= 1;

  const { advantage: traitAdvantage, disadvantage: traitDisadvantage } = collectEnemyTraitModifiers(ctx, npc, def);

  // Pick the nearest creature this enemy considers hostile (matrix + disposition).
  const target = pickEnemyAttackTarget(ctx, npc);

  const result = runEnemyTurn(npc, def, {
    displayName: combatantDisplayName(npc, s.npcs),
    target,
    passable: s.map.passable,
    mapCols: s.map.cols,
    mapRows: s.map.rows,
    occupiedTiles: occupied,
    traitAdvantage,
    traitDisadvantage,
  });

  const endedAdjacentToPlayer = chebyshev(result.finalTileX, result.finalTileY, s.player.tileX, s.player.tileY) <= 1;

  // Snapshot which allies were adjacent at the START of this enemy's movement.
  const allyOAProvokers = s.npcs.filter((ally) =>
    ally.disposition === 'ally' && ally.hp > 0
    && chebyshev(ally.tileX, ally.tileY, npc.tileX, npc.tileY) <= 1,
  );

  npc.tileX = result.finalTileX;
  npc.tileY = result.finalTileY;
  if (result.hidden) {
    if (!npc.conditions.includes('hidden')) npc.conditions.push('hidden');
  } else {
    npc.conditions = npc.conditions.filter((c) => c !== 'hidden');
  }
  npc.conditions = npc.conditions.filter((c) => c !== 'vexed');
  if (!isIncapacitated(npc.conditions)) npc.conditions = npc.conditions.filter((c) => c !== 'prone');
  events.push(...result.events);

  // ── Ally OAs against this moving enemy ─────────────────────────────────
  for (const ally of allyOAProvokers) {
    if (ally.reactionUsed) continue;
    if (isIncapacitated(ally.conditions)) continue;
    if (!isVisible(npc.conditions)) continue;
    if (chebyshev(ally.tileX, ally.tileY, npc.tileX, npc.tileY) <= 1) continue;
    doNpcOpportunityAttack(
      ctx, ally, npc,
      combatantDisplayName(ally, s.npcs),
      combatantDisplayName(npc, s.npcs),
    );
    if (npc.hp <= 0) {
      ctx.addLogs(result.logs);
      finalizeNpcTurn(ctx, npc);
      return;
    }
  }

  // ── Player OA against this moving enemy ────────────────────────────────
  // Only fires when the enemy walked AWAY from the player — an enemy moving
  // toward a hostile NPC doesn't provoke the player's OA unless they were
  // adjacent at the start.
  if (startedAdjacentToPlayer && !endedAdjacentToPlayer && !result.attacked) {
    if (playerCanReact(ctx) && isVisible(npc.conditions)) {
      ctx.addLogs(result.logs);  // Surface the move log BEFORE the prompt fires.
      s.pendingReaction = {
        kind: 'opportunity_attack',
        npcId: npc.id,
        npcName: combatantDisplayName(npc, s.npcs),
      };
      ctx.addLog({ left: `⚡ Opportunity Attack: ${combatantDisplayName(npc, s.npcs)} provokes`, style: 'header' });
      return;
    }
  }

  ctx.addLogs(result.logs);

  // ── Shield reaction ────────────────────────────────────────────────────
  // Only triggers when the attack targets the player — NPC-vs-NPC attacks
  // bypass the Shield prompt.
  const targetedPlayer = result.attackedTargetId === 'player';
  if (targetedPlayer && result.attacked && result.isHit && !result.isCrit && shieldAvailable(ctx)) {
    s.pendingReaction = {
      kind: 'shield',
      attackerId: npc.id,
      attackerName: combatantDisplayName(npc, s.npcs),
      incomingDamage: result.damage,
      incomingBonusComponents: result.bonusComponents,
      attackTotal: result.attackTotal,
      shieldedAc: ctx.state.player.ac + 5,
    };
    ctx.addLog({ left: `⚡ Shield: ${combatantDisplayName(npc, s.npcs)} hits for ${result.damage} — react with Shield?`, style: 'header' });
    return;
  }

  if (result.attacked && targetedPlayer) {
    // Player-facing physical-attack sound (hit thump or swing whoosh). NPC vs
    // NPC attacks would also be physical but we leave them silent for now —
    // the player's audio attention belongs on attacks involving them.
    events.push({ type: 'play_sound', sound: result.isHit ? 'physical_hit' : 'physical_miss' });
  }
  if (result.attacked && result.isHit) {
    if (targetedPlayer) {
      applyEnemyHitToPlayer(ctx, npc, result, events);
    } else if (result.attackedTargetId) {
      applyEnemyHitToNpc(ctx, npc, result.attackedTargetId, result);
    }
  }
  finalizeNpcTurn(ctx, npc);
  ctx.publish({ type: 'turn_ended', combatantId: npc.id });
}

/**
 * Damage routing for an enemy NPC that successfully struck another NPC (Pass
 * 3a). Resolves the live target, picks attacker / target MonsterDefs, hands
 * off to the shared `applyNpcAttackHit` helper with `awardXp: false` (player
 * wasn't in the fight) and a disambiguated kill-line attribution.
 */
function applyEnemyHitToNpc(
  ctx: GameContext,
  attacker: NpcState,
  attackedId: string,
  result: { damage: number; isCrit: boolean; bonusComponents: import('./CombatSystem.js').RolledBonusDamage[]; attackOnHit?: import('./types.js').AttackOnHitEffect[] },
): void {
  const target = ctx.state.npcs.find((n) => n.id === attackedId);
  if (!target || target.hp <= 0) return;
  const attackerDef = ctx.resolveMonsterDef(attacker.defId);
  const targetDef = ctx.resolveMonsterDef(target.defId);
  if (!attackerDef || !targetDef) return;
  applyNpcAttackHit({
    ctx, attacker, target, attackerDef, targetDef, result,
    awardXp: false,
    attackerDisplayName: combatantDisplayName(attacker, ctx.state.npcs),
  });
}

/**
 * Resolve one ally NPC's combat-phase turn — same flow as the enemy runner
 * but targets are picked from `isHostileTo(ally, other)` and kills credit
 * the player with XP (the player commands the ally).
 */
export function runSingleAllyTurn(ctx: GameContext, ally: NpcState, events: GameEvent[]): void {
  if (ally.combatPassive) return;
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(ally.defId);
  if (!def) return;
  ally.reactionUsed = false;
  ally.conditions = ally.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  ctx.publish({ type: 'turn_started', combatantId: ally.id });

  const allyBehavior = chooseNpcBehavior(ctx, ally, def);
  if (allyBehavior === 'flee') {
    // Threat = nearest hostile.
    const enemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
    if (enemies.length > 0) {
      const nearest = enemies.reduce((a, b) =>
        chebyshev(ally.tileX, ally.tileY, a.tileX, a.tileY) <= chebyshev(ally.tileX, ally.tileY, b.tileX, b.tileY) ? a : b,
      );
      const flee = fleeFromThreat(ctx, ally, def, nearest.tileX, nearest.tileY);
      for (const step of flee.pathTaken) events.push({ type: 'entity_move', entityId: ally.id, toX: step.x, toY: step.y });
      ally.tileX = flee.finalTileX;
      ally.tileY = flee.finalTileY;
      ctx.addLog({ left: `${combatantDisplayName(ally, s.npcs)} breaks and flees!`, style: 'status' });
      ctx.publish({ type: 'turn_ended', combatantId: ally.id });
      if (isMapEdge(ctx, ally.tileX, ally.tileY)) {
        ctx.addLog({ left: `${combatantDisplayName(ally, s.npcs)} escapes off the map edge — gone.`, style: 'status' });
        ctx.removeNpc(ally.id);
      }
      return;
    }
  }
  if (allyBehavior === 'hold') {
    if (!isIncapacitated(ally.conditions)) {
      ally.conditions.push('dodging');
      ctx.addLog({ left: `${combatantDisplayName(ally, s.npcs)} Dodges — attackers have Disadvantage`, style: 'status' });
    } else {
      ctx.addLog({ left: `${combatantDisplayName(ally, s.npcs)} holds position`, style: 'status' });
    }
    ctx.publish({ type: 'turn_ended', combatantId: ally.id });
    return;
  }

  // Ally targets every NPC the faction matrix says is hostile (or, via
  // fallback, every disposition-enemy NPC). Opens the door to town-guard
  // allies engaging wandering monsters even when those monsters aren't
  // disposition-enemy to the player yet.
  const allyView = { factionId: ally.factionId, disposition: ally.disposition };
  const enemyTargets = s.npcs
    .filter((n) => n !== ally && n.hp > 0 && isHostileTo(s, allyView, { factionId: n.factionId, disposition: n.disposition }))
    .map((n) => {
      const ndef = ctx.resolveMonsterDef(n.defId);
      return { id: n.id, tileX: n.tileX, tileY: n.tileY, ac: ndef?.ac ?? 10 };
    });

  const occupied: [number, number][] = [
    [s.player.tileX, s.player.tileY],
    ...s.npcs.filter((n) => n !== ally && n.hp > 0).map((n): [number, number] => [n.tileX, n.tileY]),
  ];

  // Snapshot which enemies were adjacent at the START of the ally's movement —
  // they get the chance to OA if the ally then moves out of reach.
  const enemyOAProvokers = s.npcs.filter((enemy) =>
    enemy.disposition === 'enemy' && enemy.hp > 0
    && chebyshev(enemy.tileX, enemy.tileY, ally.tileX, ally.tileY) <= 1,
  );

  const result = runAllyTurn(ally, def, {
    displayName: combatantDisplayName(ally, s.npcs),
    enemyTargets,
    passable: s.map.passable,
    mapCols: s.map.cols,
    mapRows: s.map.rows,
    occupiedTiles: occupied,
  });

  ally.tileX = result.finalTileX;
  ally.tileY = result.finalTileY;
  events.push(...result.events);
  ctx.addLogs(result.logs);

  // ── Enemy OAs against this moving ally ─────────────────────────────────
  for (const enemy of enemyOAProvokers) {
    if (enemy.reactionUsed) continue;
    if (isIncapacitated(enemy.conditions)) continue;
    if (!isVisible(ally.conditions)) continue;
    if (chebyshev(enemy.tileX, enemy.tileY, ally.tileX, ally.tileY) <= 1) continue;
    doNpcOpportunityAttack(
      ctx, enemy, ally,
      combatantDisplayName(enemy, s.npcs),
      combatantDisplayName(ally, s.npcs),
    );
    if (ally.hp <= 0) return;
  }

  if (result.attacked && result.isHit && result.attackedTargetId) {
    const target = s.npcs.find((n) => n.id === result.attackedTargetId);
    if (target) {
      const targetDef = ctx.resolveMonsterDef(target.defId);
      if (targetDef) {
        applyNpcAttackHit({
          ctx, attacker: ally, target, attackerDef: def, targetDef, result,
          awardXp: true,
        });
      }
    }
  }
  ctx.publish({ type: 'turn_ended', combatantId: ally.id });
}
