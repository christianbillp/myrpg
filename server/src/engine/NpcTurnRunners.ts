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
import type { GameEvent, NpcState, MonsterDef, ExtraAttack } from './types.js';
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
import { applyDamageWithTempHp } from './CombatSystem.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { chooseNpcBehavior, fleeFromThreat, isMapEdge } from './NpcBrain.js';
import { Logger } from '../Logger.js';
import { endConcentration } from './ConcentrationSystem.js';
import { applyTurnStartPeriodicDamage, isAttacker } from './OngoingEffectsSystem.js';
import { tickZoneEnterSaves, spellSaveDC } from './SpellSystem.js';
import { d20, mod } from './Dice.js';

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
/**
 * Apply zone-step side effects after an NPC commits to a movement tile.
 * Returns the step's effective cost (1 for ordinary terrain, 2 for
 * Difficult Terrain). Rolls the enter-save for any zone whose condition
 * the NPC doesn't already carry (Web's DEX vs Restrained); on failure the
 * condition lands and `affectedNpcIds` is updated so the eventual
 * zone-end cleanup will find the creature. Side effects use the engine's
 * d20 + log path, not a pure function, so this lives in NpcTurnRunners
 * where `ctx` is available.
 */
function applyZoneStepEffects(ctx: GameContext, npc: NpcState, tx: number, ty: number): number {
  const s = ctx.state;
  if (!s.activeZones || s.activeZones.length === 0) return 1;
  let cost = 1;
  for (const z of s.activeZones) {
    const inside = z.tiles.some(([x, y]) => x === tx && y === ty);
    if (!inside) continue;
    if (z.difficultTerrain) cost = 2;
    if (!z.enterSave || !z.condition) continue;
    if (npc.conditions.includes(z.condition)) continue;
    const def = ctx.resolveMonsterDef(npc.defId);
    if (!def) continue;
    const ability = z.enterSave.ability;
    const dc = z.enterSave.dc;
    const saveMod = (def.savingThrows && def.savingThrows[ability] !== undefined)
      ? def.savingThrows[ability]
      : Math.floor((def[ability] - 10) / 2);
    const roll = Math.floor(Math.random() * 20) + 1;
    const total = roll + saveMod;
    const success = total >= dc;
    ctx.addLog({
      left: `${combatantDisplayName(npc, s.npcs)} ${success ? 'pushes through' : 'is caught by'} ${z.name}`,
      right: `${ability.toUpperCase()} d20(${roll})+${saveMod}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    if (!success) {
      npc.conditions.push(z.condition);
      if (!z.affectedNpcIds.includes(npc.id)) z.affectedNpcIds.push(npc.id);
      if (z.enterDamage) applyTrapZoneDamageToNpc(ctx, npc, z.enterDamage.amount, z.enterDamage.type);
    }
  }
  return cost;
}

/** Apply a deployed-gear zone's flat enter-damage (caltrops: 1 Piercing) to an
 *  NPC that failed its save, routing kills through the player-reward path since
 *  the player deployed the hazard. */
function applyTrapZoneDamageToNpc(ctx: GameContext, npc: NpcState, amount: number, damageType: string): void {
  if (amount <= 0 || npc.hp <= 0) return;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  const { finalDamage, log } = ctx.resistMod(amount, damageType, def, npc.name);
  if (log) ctx.addLog(log);
  const hpBefore = npc.hp;
  applyDamageWithTempHp(npc, finalDamage);
  publishNpcDamage(ctx, npc, hpBefore, npc.hp);
  if (npc.hp <= 0) ctx.killWithReward(npc, def, `☠ ${combatantDisplayName(npc, ctx.state.npcs)} is slain!`);
}

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
/**
 * SRD Sanctuary — a creature trying to target the warded creature first makes
 * a Wisdom save vs the caster's spell save DC; on a failure it can't target
 * them (must pick another target or lose the attack). Returns true when the
 * ward blocks this attacker. Rolled once per target-pick (once per enemy turn),
 * which approximates the SRD per-attempt save. The caster is always the player,
 * so the DC comes from the player's spellcasting.
 */
function sanctuaryWardBlocks(ctx: GameContext, attacker: NpcState, targetConditions: string[], targetName: string): boolean {
  if (!targetConditions.includes('sanctuary')) return false;
  const def = ctx.resolveMonsterDef(attacker.defId);
  if (!def) return false;
  const dc = spellSaveDC(ctx);
  const saveMod = (def.savingThrows && def.savingThrows.wis !== undefined) ? def.savingThrows.wis : mod(def.wis);
  const roll = d20();
  const total = roll + saveMod;
  const success = total >= dc;
  ctx.addLog({
    left: success
      ? `${combatantDisplayName(attacker, ctx.state.npcs)} pushes past ${targetName}'s Sanctuary`
      : `${combatantDisplayName(attacker, ctx.state.npcs)} is turned aside by ${targetName}'s Sanctuary`,
    right: `WIS d20(${roll})+${saveMod}=${total} vs DC ${dc}`,
    style: success ? 'status' : 'miss',
  });
  return !success;
}

export function pickEnemyAttackTarget(ctx: GameContext, attacker: NpcState): EnemyAttackTarget {
  const s = ctx.state;
  const attackerView = { factionId: attacker.factionId, disposition: attacker.disposition };
  const playerView = { factionId: PLAYER_FACTION_ID };
  const candidates: Array<{ target: EnemyAttackTarget; dist: number; isPlayer: boolean }> = [];

  // SRD Charmed condition: a Charmed creature can't attack the charmer or
  // target the charmer with harmful abilities. In this engine the player is
  // always the charmer (only the player casts Charm Person), so a Charmed
  // attacker simply omits the player from its target list — it may still
  // attack other hostiles in the encounter, or fall through to the "no
  // hostile target" synthesised snapshot below if none remain.
  // SRD Calm Emotions (Indifferent outcome): a becalmed creature is no longer
  // hostile, so it makes no attacks this turn — it targets no one and falls
  // through to the synthesised "no hostile target" snapshot below.
  const calmed = attacker.conditions.includes('calmed');
  if (calmed) {
    ctx.addLog({ left: `${combatantDisplayName(attacker, s.npcs)} is too becalmed to attack.`, style: 'status' });
  }

  // SRD Blink: while phased to the Ethereal Plane the caster can't be targeted
  // by attacks from material-plane creatures — omit the player entirely.
  const playerEthereal = s.player.conditions.includes('ethereal');

  const charmedByPlayer = attacker.conditions.includes('charmed');
  if (!calmed && !playerEthereal && isHostileTo(s, attackerView, playerView) && !charmedByPlayer
      && !sanctuaryWardBlocks(ctx, attacker, s.player.conditions, ctx.playerDef.name)) {
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
        conditions: s.player.conditions,
        passivePerception: 10 + (ctx.playerDef.skills['perception'] ?? 0),
      },
      dist: chebyshev(attacker.tileX, attacker.tileY, s.player.tileX, s.player.tileY),
      isPlayer: true,
    });
  }
  for (const other of s.npcs) {
    if (calmed) break;  // becalmed: no targets at all
    if (other === attacker || other.hp <= 0) continue;
    const otherView = { factionId: other.factionId, disposition: other.disposition };
    if (!isHostileTo(s, attackerView, otherView)) continue;
    if (sanctuaryWardBlocks(ctx, attacker, other.conditions, combatantDisplayName(other, s.npcs))) continue;
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
        conditions: other.conditions,
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
    Logger.log('ai.target_pick', {
      attacker: attacker.id, attackerDefId: attacker.defId,
      charmedByPlayer,
      candidates: [],
      chosen: 'player_fallback',
      reason: 'no_hostile_targets',
    });
    return {
      id: 'player',
      displayName: ctx.playerDef.name,
      tileX: s.player.tileX, tileY: s.player.tileY,
      ac: ctx.playerDef.ac, hp: s.player.hp,
      hidden: s.player.conditions.includes('hidden'),
      dodging: s.player.conditions.includes('dodging'),
      invisible: s.player.conditions.includes('invisible'),
      conditions: s.player.conditions,
      passivePerception: 10 + (ctx.playerDef.skills['perception'] ?? 0),
    };
  }
  candidates.sort((a, b) => (a.dist - b.dist) || (a.isPlayer ? -1 : b.isPlayer ? 1 : 0));
  Logger.log('ai.target_pick', {
    attacker: attacker.id, attackerDefId: attacker.defId,
    charmedByPlayer,
    candidates: candidates.map((c) => ({ id: c.target.id, dist: c.dist, hp: c.target.hp, isPlayer: c.isPlayer })),
    chosen: candidates[0].target.id,
  });
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
  if (!def) {
    Logger.warn('anomaly.missing_monster_def', { npcId: npc.id, defId: npc.defId });
    npc.isActive = false;
    return;
  }
  // Per SRD: a creature's Reaction refreshes at the start of its own turn,
  // and turn-scoped conditions (Dodge / Dash / Disengage / Slowed) expire
  // at the start of that creature's next turn — clear them here so they
  // actually protect the NPC against incoming attacks during the round.
  npc.reactionUsed = false;
  npc.conditions = npc.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  Logger.log('combat.turn_started', { combatantId: npc.id, defId: npc.defId, kind: 'enemy', hp: npc.hp });
  ctx.publish({ type: 'turn_started', combatantId: npc.id });

  // SRD Web (and any future enter-save zone): a creature standing in the
  // zone's tile set at the start of its turn re-rolls the enter save.
  tickZoneEnterSaves(ctx, npc.id);

  // Periodic damage authored by this NPC (e.g. stirge attach DoT) fires now.
  applyTurnStartPeriodicDamage(ctx, npc.id, events);
  if (s.player.hp <= 0) {
    // The DoT downed the player — let the normal flow handle the unconscious
    // state at the next turn boundary; for this NPC's turn we still finalise.
    finalizeNpcTurn(ctx, npc, events);
    ctx.publish({ type: 'turn_ended', combatantId: npc.id });
    return;
  }
  // If this NPC is currently attached to a target, it can't make its
  // Proboscis-style attack — skip the attack phase entirely. The DoT fired
  // above is the only thing it accomplishes this turn.
  if (isAttacker(npc, ctx)) {
    finalizeNpcTurn(ctx, npc, events);
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
    finalizeNpcTurn(ctx, npc, events);
    ctx.publish({ type: 'turn_ended', combatantId: npc.id });
    return;
  }
  if (behavior === 'flee') {
    const flee = fleeFromThreat(ctx, npc, def, s.player.tileX, s.player.tileY);
    for (const step of flee.pathTaken) events.push({ type: 'entity_move', entityId: npc.id, toX: step.x, toY: step.y });
    npc.tileX = flee.finalTileX;
    npc.tileY = flee.finalTileY;
    ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} breaks and flees!`, style: 'status' });
    finalizeNpcTurn(ctx, npc, events);
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
    blocksMovement: s.map.blocksMovement,
    mapCols: s.map.cols,
    mapRows: s.map.rows,
    occupiedTiles: occupied,
    traitAdvantage,
    traitDisadvantage,
    onStep: (tx, ty) => applyZoneStepEffects(ctx, npc, tx, ty),
  });

  // SRD Invisibility — "the spell ends early immediately after the target
  // makes an attack roll, deals damage, or casts a spell." This NPC just
  // attacked (or attempted to); if they are the Invisibility recipient,
  // end the caster's concentration which strips the `invisible` condition.
  if (result.attacked
      && s.player.concentratingOn === 'invisibility'
      && s.player.invisibilityTargetId === npc.id) {
    endConcentration(ctx, `${combatantDisplayName(npc, s.npcs)} broke Invisibility by attacking`);
  }

  // SRD Ray of Enfeeblement (fail branch): "subtracts 1d8 from all its
  // damage rolls". Roll the deduction once per landed attack and clamp
  // the result at 0 so a small hit reduced past zero just whiffs in
  // damage terms (still counts as a hit for on-hit triggers). Runs
  // before the Shield prompt so the player sees the reduced number.
  if (result.attacked && result.isHit && result.damage > 0 && npc.conditions.includes('enfeebled')) {
    const reduction = Math.floor(Math.random() * 8) + 1;
    const before = result.damage;
    result.damage = Math.max(0, result.damage - reduction);
    ctx.addLog({
      left: `↪ Ray of Enfeeblement — ${combatantDisplayName(npc, s.npcs)} bleeds off ${before - result.damage} damage (1d8=${reduction})`,
      style: 'status',
    });
  }

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
      finalizeNpcTurn(ctx, npc, events);
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
  // bypass the Shield prompt. SRD: Shield's +5 AC can't convert a crit
  // into a miss (crits bypass AC entirely), but the player may still want
  // to spend the reaction for the +5 / no-Magic-Missile buff that lasts
  // until the start of their next turn, so the prompt fires on crits too.
  const targetedPlayer = result.attackedTargetId === 'player';
  // A readied attack reserves the player's Reaction, so Shield isn't offered.
  if (targetedPlayer && result.attacked && result.isHit && !s.player.readiedAttack && shieldAvailable(ctx)) {
    s.pendingReaction = {
      kind: 'shield',
      attackerId: npc.id,
      attackerName: combatantDisplayName(npc, s.npcs),
      incomingDamage: result.damage,
      incomingDamageType: result.damageType,
      incomingBonusComponents: result.bonusComponents,
      extraAttacks: result.extraAttacks,
      attackTotal: result.attackTotal,
      shieldedAc: ctx.state.player.ac + 5,
      isCrit: result.isCrit,
    };
    const critNote = result.isCrit ? ' (CRIT — Shield won\'t block, but the +5 AC lasts)' : '';
    ctx.addLog({ left: `⚡ Shield: ${combatantDisplayName(npc, s.npcs)} hits for ${result.damage}${critNote} — react with Shield?`, style: 'header' });
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
  // SRD Multiattack (US-112): the primary didn't pause for a reaction here, so
  // apply the remaining attacks inline against the same target.
  if (result.attacked && result.attackedTargetId && result.extraAttacks?.length) {
    applyExtraAttacks(ctx, npc, result.attackedTargetId, result.extraAttacks, events);
  }
  // SRD Ready (US-057): an enemy that moved INTO the player's reach this turn
  // triggers the player's readied melee attack. Pause for the prompt; the
  // resume (`doResolveReaction`) makes the strike and finalizes this NPC's turn.
  if (!startedAdjacentToPlayer && endedAdjacentToPlayer && s.player.readiedAttack
      && playerCanReact(ctx) && isVisible(npc.conditions) && npc.hp > 0) {
    s.pendingReaction = { kind: 'readied_attack', npcId: npc.id, npcName: combatantDisplayName(npc, s.npcs) };
    ctx.addLog({ left: `⚡ Readied Attack: ${combatantDisplayName(npc, s.npcs)} closes into reach`, style: 'header' });
    return;
  }
  finalizeNpcTurn(ctx, npc, events);
  ctx.publish({ type: 'turn_ended', combatantId: npc.id });
}

/**
 * Apply a Multiattack's extra attacks (US-112) against the same target as the
 * primary. Each carries its own roll outcome; misses are skipped. Stops if the
 * target drops. Extra attacks do NOT raise their own Shield prompt — only the
 * primary does — but a Shield cast on the primary is already reflected in the
 * player's AC, which these were rolled against on the resume path.
 */
function applyExtraAttacks(
  ctx: GameContext,
  attacker: NpcState,
  attackedTargetId: string,
  extras: ExtraAttack[],
  events: GameEvent[],
): void {
  const s = ctx.state;
  for (const ex of extras) {
    if (!ex.isHit) continue;
    if (attackedTargetId === 'player') {
      if (s.player.hp <= 0) break;
      events.push({ type: 'play_sound', sound: 'physical_hit' });
      applyEnemyHitToPlayer(ctx, attacker, {
        damage: ex.damage, isCrit: ex.isCrit,
        finalTileX: attacker.tileX, finalTileY: attacker.tileY,
        bonusComponents: ex.bonusComponents, damageType: ex.damageType,
      }, events);
    } else {
      const t = s.npcs.find((n) => n.id === attackedTargetId);
      if (!t || t.hp <= 0) break;
      applyEnemyHitToNpc(ctx, attacker, attackedTargetId, {
        damage: ex.damage, isCrit: ex.isCrit, bonusComponents: ex.bonusComponents,
      });
    }
  }
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
  if (ally.combatPassive) {
    Logger.log('combat.ally_skipped', { combatantId: ally.id, reason: 'combat_passive' });
    return;
  }
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(ally.defId);
  if (!def) {
    Logger.warn('anomaly.missing_monster_def', { npcId: ally.id, defId: ally.defId });
    return;
  }
  ally.reactionUsed = false;
  ally.conditions = ally.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  Logger.log('combat.turn_started', { combatantId: ally.id, defId: ally.defId, kind: 'ally', hp: ally.hp });
  ctx.publish({ type: 'turn_started', combatantId: ally.id });

  tickZoneEnterSaves(ctx, ally.id);

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
  //
  // **Companion ATTACK override** — when the player has issued an explicit
  // `attack { targetId }` command via the COMPANION chip, force the target
  // list to just that NPC. The companion still uses the regular ally AI
  // (movement + attack roll); only the target picker is overridden. If the
  // forced target is dead / missing, fall through to autonomous selection
  // and clear the override so the panel resyncs.
  const allyView = { factionId: ally.factionId, disposition: ally.disposition };
  const override = ally.companion?.override;
  let forcedTarget: NpcState | null = null;
  if (override?.kind === 'attack') {
    const candidate = s.npcs.find((n) => n.id === override.targetId);
    if (candidate && candidate.hp > 0) forcedTarget = candidate;
    else if (ally.companion) ally.companion.override = undefined;
  }
  const enemyTargets = (forcedTarget
    ? [forcedTarget]
    : s.npcs.filter((n) => n !== ally && n.hp > 0 && isHostileTo(s, allyView, { factionId: n.factionId, disposition: n.disposition })))
    .map((n) => {
      const ndef = ctx.resolveMonsterDef(n.defId);
      return { id: n.id, tileX: n.tileX, tileY: n.tileY, ac: ndef?.ac ?? 10, conditions: n.conditions };
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
    blocksMovement: s.map.blocksMovement,
    mapCols: s.map.cols,
    mapRows: s.map.rows,
    occupiedTiles: occupied,
  });

  ally.tileX = result.finalTileX;
  ally.tileY = result.finalTileY;
  events.push(...result.events);
  ctx.addLogs(result.logs);

  // SRD Invisibility — same as the enemy path: if this ally is the
  // Invisibility recipient and they attacked, end the caster's
  // concentration (which strips the `invisible` condition).
  if (result.attacked
      && s.player.concentratingOn === 'invisibility'
      && s.player.invisibilityTargetId === ally.id) {
    endConcentration(ctx, `${combatantDisplayName(ally, s.npcs)} broke Invisibility by attacking`);
  }

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
  // SRD Help (US-057): the `helped` Advantage is single-use — consume it on the
  // attacked target whether the strike hit or missed.
  if (result.attacked && result.attackedTargetId) {
    const t = s.npcs.find((n) => n.id === result.attackedTargetId);
    if (t) t.conditions = t.conditions.filter((c) => c !== 'helped');
  }
  ctx.publish({ type: 'turn_ended', combatantId: ally.id });
}
