import { GameEvent, NpcState, LogEntry, CombatMode } from './types.js';
import type { GameContext } from './GameContext.js';
import { rollOneInitiative, rollDeathSave } from './CombatSystem.js';
import { runEnemyTurn, runAllyTurn, chebyshev } from './EnemyAI.js';
import { isIncapacitated, isVisible, hasSpeedZero, proneStandCost, TURN_CONDITIONS } from './ConditionSystem.js';
import { mod, d20 as d20Local } from './Dice.js';
import { doNpcOpportunityAttack } from './CombatActions.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { chooseNpcBehavior, fleeFromThreat, isMapEdge } from './NpcBrain.js';

// ── Combat lifecycle ────────────────────────────────────────────────────────

export function endCombat(ctx: GameContext): GameEvent[] {
  const s = ctx.state;
  s.phase = 'exploring';
  s.npcs = s.npcs.filter((n) => n.disposition !== 'enemy' || n.hp === 0);
  s.npcs.filter((n) => n.disposition === 'ally' && n.hp > 0).forEach((n) => { n.disposition = 'neutral'; });
  s.npcs.forEach((n) => { n.initiativeRoll = undefined; n.isActive = false; });
  s.player.initiativeRoll = 0;
  s.activeNpcIndex = 0;
  s.turnOrderIds = [];
  s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');
  ctx.publish({ type: 'combat_ended' });
  return [];
}

export function autoEndCombatIfNoEnemies(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase === 'exploring' || s.phase === 'defeat') return;
  if (s.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0)) return;
  endCombat(ctx);
}

export function triggerCombat(ctx: GameContext): GameEvent[] {
  const s = ctx.state;
  if (s.phase !== 'exploring' || !s.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0)) return [];
  const events: GameEvent[] = [];
  doStartCombat(ctx, events);
  return events;
}

/**
 * Start combat: detect surprised combatants, roll Initiative for everyone,
 * sort turnOrderIds by descending Initiative, and dispatch the first turn.
 *
 * Surprise (SRD): any enemy who didn't know combat was starting has
 * Disadvantage on Initiative. Heuristically we say: an enemy is Surprised iff
 * the player was Hidden at the moment combat triggered (i.e. attacked from
 * stealth or hidden movement that crossed the trigger range). Allies and the
 * player are never Surprised in player-initiated combat.
 */
export function doStartCombat(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  const enemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
  if (enemies.length === 0) return;

  // Read playerWasHidden BUT keep the condition active. A hidden opener should
  // grant Advantage on the very first attack (which is what triggered combat
  // in many cases). The attack resolver clears `hidden` as part of normal
  // post-attack cleanup, so we don't strip it here.
  const playerWasHidden = s.player.conditions.includes('hidden');
  s.player.deathSaveSuccesses = 0;
  s.player.deathSaveFailures = 0;

  const combatNpcs = s.npcs.filter((n) => n.disposition !== 'neutral' && n.hp > 0);
  for (const npc of combatNpcs.filter((n) => !n.combatLabel)) ctx.assignCombatLabel(npc);

  // ── Roll Initiative for every combatant ─────────────────────────────────
  const logs: LogEntry[] = [{ left: '⚔ Combat begins', style: 'header' }];

  const playerInit = rollOneInitiative(mod(ctx.playerDef.dex), /*surprised*/false, /*invisible*/false);
  s.player.initiativeRoll = playerInit.total;
  logs.push({
    left: `${ctx.playerDef.name} rolls Initiative`,
    right: `${playerInit.rollStr}=${playerInit.total}`,
    style: 'normal',
  });

  for (const npc of combatNpcs) {
    const def = ctx.resolveMonsterDef(npc.defId);
    if (!def) continue;
    const isEnemy = npc.disposition === 'enemy';
    const surprised = isEnemy && playerWasHidden;
    const invisible = npc.conditions.includes('invisible');
    const init = rollOneInitiative(def.initiativeBonus, surprised, invisible);
    npc.initiativeRoll = init.total;
    const note = surprised ? ' [SURPRISED]' : invisible ? ' [INVISIBLE]' : '';
    logs.push({
      left: `${combatantDisplayName(npc, s.npcs)} rolls Initiative${note}`,
      right: `${init.rollStr}=${init.total}`,
      style: surprised ? 'miss' : 'normal',
    });
  }

  // ── Build sorted turn order ─────────────────────────────────────────────
  type Slot = { id: string; total: number; tiebreak: number };
  const slots: Slot[] = [];
  slots.push({ id: 'player', total: s.player.initiativeRoll, tiebreak: mod(ctx.playerDef.dex) });
  for (const npc of combatNpcs) {
    const def = ctx.resolveMonsterDef(npc.defId);
    slots.push({ id: npc.id, total: npc.initiativeRoll ?? 0, tiebreak: def?.initiativeBonus ?? 0 });
  }
  slots.sort((a, b) => (b.total - a.total) || (b.tiebreak - a.tiebreak));
  s.turnOrderIds = slots.map((s) => s.id);
  ctx.addLogs(logs);

  ctx.addLog({
    left: `Turn order: ${slots.map((sl) => {
      if (sl.id === 'player') return ctx.playerDef.name;
      const n = s.npcs.find((nn) => nn.id === sl.id);
      return n ? combatantDisplayName(n, s.npcs) : sl.id;
    }).join(' → ')}`,
    style: 'normal',
  });

  ctx.publish({ type: 'combat_started' });

  // ── Start the first combatant's turn ────────────────────────────────────
  s.activeNpcIndex = -1;
  advanceTurn(ctx, events);
}

/**
 * Advance to the next combatant in turnOrderIds and resolve their turn.
 * If the next combatant is the player, sets phase='player_turn' and returns
 * (waits for player input). If it's an NPC, runs their AI and then recurses
 * to the next combatant. Skips dead combatants entirely.
 */
export function advanceTurn(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  // Paused on a reaction prompt — the next player action must be `resolveReaction`.
  // Once resolved, doResolveReaction will call back into advanceTurn to continue.
  if (s.pendingReaction) return;
  if (s.phase === 'defeat' || s.phase === 'death_saves') return;
  if (s.turnOrderIds.length === 0) return;

  // Auto-end if all enemies are down before we tick further.
  if (!s.npcs.some((n) => n.disposition === 'enemy' && n.hp > 0)) {
    endCombat(ctx);
    return;
  }

  // Find the next live combatant.
  for (let step = 0; step < s.turnOrderIds.length + 1; step++) {
    s.activeNpcIndex = (s.activeNpcIndex + 1) % s.turnOrderIds.length;
    const id = s.turnOrderIds[s.activeNpcIndex];
    if (id === 'player') {
      // The player always gets a turn (even at 0 HP — that's the death save).
      enterPlayerTurn(ctx);
      return;
    }
    const npc = s.npcs.find((n) => n.id === id);
    if (!npc || npc.hp <= 0) continue;
    // Mark this NPC as active and run their turn.
    s.npcs.forEach((n) => { n.isActive = false; });
    npc.isActive = true;
    s.phase = 'enemy_turn';
    if (npc.disposition === 'enemy') {
      runSingleEnemyTurn(ctx, npc, events);
    } else if (npc.disposition === 'ally') {
      runSingleAllyTurn(ctx, npc, events);
    }
    npc.isActive = false;
    // Recurse to the next combatant unless something during the NPC's turn
    // changed phase (defeat / death_saves / exploring after auto-end).
    // Read through `as string` to defeat TS narrowing from the earlier
    // s.phase = 'enemy_turn' assignment — the NPC turn can mutate phase.
    const newPhase = s.phase as string;
    if (newPhase === 'defeat' || newPhase === 'death_saves' || newPhase === 'exploring') return;
    return advanceTurn(ctx, events);
  }
}

export function enterPlayerTurn(ctx: GameContext): void {
  const s = ctx.state;
  const wasPlayerTurn = s.phase === 'player_turn';
  // If the player is unconscious, their "turn" is rolling a death save.
  s.phase = s.player.hp <= 0 ? 'death_saves' : 'player_turn';
  s.npcs.filter((n) => n.disposition !== 'neutral' && n.hp > 0).forEach((n) => {
    n.isActive = false;
    // NOTE: NPC reactions reset at the START of THAT NPC's own turn — see
    // runSingleEnemyTurn / runSingleAllyTurn. Resetting here would let an NPC
    // that already burned its reaction (e.g. an Opportunity Attack against an
    // ally during its own turn) get it back as soon as the player's turn
    // begins, regardless of whether the NPC has acted again.
    n.conditions = n.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  });
  s.player.actionUsed = false;
  s.player.bonusActionUsed = false;
  s.player.reactionUsed = false;
  s.player.freeObjectInteractionUsed = false;
  s.player.conditions = s.player.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  if (hasSpeedZero(s.player.conditions) || s.player.hp <= 0) {
    s.player.movesLeft = 0;
  } else {
    const tileSpeed = ctx.playerDef.speed / 5;
    const standCost = proneStandCost(s.player.conditions, tileSpeed);
    s.player.movesLeft = Math.max(0, tileSpeed - standCost);
    if (standCost > 0) s.player.conditions = s.player.conditions.filter((c) => c !== 'prone');
  }
  if (!wasPlayerTurn && s.phase === 'player_turn') {
    ctx.addLog({ left: `── ${ctx.playerDef.name}'s turn — Action & Bonus refreshed ──`, style: 'header' });
    ctx.publish({ type: 'turn_started', combatantId: 'player' });
  }
}

/**
 * Player presses End Turn. Hand off to the next combatant in the initiative
 * order via advanceTurn.
 */
export function endPlayerTurn(ctx: GameContext, events: GameEvent[]): void {
  ctx.publish({ type: 'turn_ended', combatantId: 'player' });
  advanceTurn(ctx, events);
}

/**
 * Backwards-compat wrapper used in a few code paths (e.g. death-save resolution
 * legacy fallback). Now just advances to the next combatant.
 */
export function enterEnemyPhase(ctx: GameContext, events: GameEvent[]): void {
  advanceTurn(ctx, events);
}

// ── Death saves ─────────────────────────────────────────────────────────────

export function doRollDeathSave(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'death_saves') return;

  const { roll, outcome } = rollDeathSave();
  const logs: LogEntry[] = [{ left: `${ctx.playerDef.name} death save: d20 = ${roll}`, style: 'normal' }];
  let nextPhase: CombatMode = 'death_saves';

  switch (outcome) {
    case 'nat20':
      s.player.hp = 1;
      logs.push({ left: `Natural 20! ${ctx.playerDef.name} regains 1 HP!`, style: 'heal' });
      nextPhase = 'player_turn';
      break;
    case 'nat1':
      s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + 2);
      logs.push({ left: `Natural 1 — two failures (${s.player.deathSaveFailures}/3)`, style: 'miss' });
      nextPhase = s.player.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
      if (nextPhase === 'defeat') logs.push({ left: `${ctx.playerDef.name} has died.`, style: 'kill' });
      break;
    case 'success':
      s.player.deathSaveSuccesses++;
      logs.push({ left: `Success (${s.player.deathSaveSuccesses}/3)`, style: 'hit' });
      if (s.player.deathSaveSuccesses >= 3) {
        s.player.hp = 1;
        s.player.deathSaveSuccesses = 0;
        s.player.deathSaveFailures = 0;
        logs.push({ left: `${ctx.playerDef.name} stabilizes and regains consciousness with 1 HP!`, style: 'heal' });
        nextPhase = 'player_turn';
      } else {
        nextPhase = 'enemy_turn';
      }
      break;
    case 'failure':
      s.player.deathSaveFailures++;
      logs.push({ left: `Failure (${s.player.deathSaveFailures}/3)`, style: 'miss' });
      nextPhase = s.player.deathSaveFailures >= 3 ? 'defeat' : 'enemy_turn';
      if (nextPhase === 'defeat') logs.push({ left: `${ctx.playerDef.name} has died.`, style: 'kill' });
      break;
  }

  ctx.addLogs(logs);

  if (nextPhase === 'player_turn') {
    // nat20 or stabilize-on-3rd-success: wake up and take what remains of this turn.
    s.player.movesLeft = ctx.playerDef.speed / 5;
    s.phase = 'player_turn';
  } else if (nextPhase === 'enemy_turn') {
    // Advance to the next combatant in initiative order.
    advanceTurn(ctx, events);
  } else {
    s.phase = nextPhase;
  }
}

// ── Per-NPC turn execution ────────────────────────────────────────────────

/**
 * Returns the display name to use in turn-bar / combat-log lines for the given
 * NPC: bare name when unique, "Name (Label)" when more than one NPC in the
 * current encounter shares the same base name and the NPC has a combat label.
 */
export function combatantDisplayName(npc: NpcState, allNpcs: NpcState[]): string {
  const base = npc.revealedName ?? npc.name;
  const duplicates = allNpcs.filter((n) => (n.revealedName ?? n.name) === base && n.disposition !== 'neutral').length;
  if (duplicates > 1 && npc.combatLabel) return `${base} (${npc.combatLabel})`;
  return base;
}

function runSingleEnemyTurn(ctx: GameContext, npc: NpcState, events: GameEvent[]): void {
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) { npc.isActive = false; return; }
  // Per SRD: a creature's Reaction refreshes at the start of its own turn.
  npc.reactionUsed = false;
  ctx.publish({ type: 'turn_started', combatantId: npc.id });

  // ── NpcBrain — decide behavior ─────────────────────────────────────────
  const behavior = chooseNpcBehavior(ctx, npc, def);
  if (behavior === 'hold') {
    ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} holds its ground`, style: 'status' });
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

  const result = runEnemyTurn(npc, def, {
    displayName: combatantDisplayName(npc, s.npcs),
    playerTileX: s.player.tileX,
    playerTileY: s.player.tileY,
    playerAc: ctx.playerDef.ac,
    playerHp: s.player.hp,
    playerHidden: s.player.conditions.includes('hidden'),
    playerDodging: s.player.conditions.includes('dodging'),
    playerInvisible: s.player.conditions.includes('invisible'),
    passivePerception: 10 + (ctx.playerDef.skills['perception'] ?? 0),
    passable: s.map.passable,
    mapCols: s.map.cols,
    mapRows: s.map.rows,
    occupiedTiles: occupied,
  });

  const endedAdjacentToPlayer = chebyshev(result.finalTileX, result.finalTileY, s.player.tileX, s.player.tileY) <= 1;

  // Snapshot which allies were adjacent at the START of this enemy's movement.
  // We resolve their OAs after the move using start-vs-end positions, mirroring
  // how the player's OA against this enemy is detected.
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
  // Per SRD: a reaction triggers when a creature you can see moves out of your
  // reach. Allies auto-take their OA (no prompt) — NPCs don't get the player
  // UI gate.
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
  // Player can take an OA when an enemy moves out of their reach without
  // attacking. If the player has a reaction available AND the enemy is
  // visible to them, defer to the prompt and suspend the turn loop until
  // they decide.
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
  // Per SRD: Shield's trigger is "you are hit by an attack roll". Prompt on
  // any non-critical hit when the player can cast Shield — the player decides
  // whether the +5 AC (until start of their next turn) is worth the slot.
  // It's never strictly wasted: even if it doesn't negate this attack, it
  // still raises AC against later attacks this round from other enemies.
  // Crits ignore Shield's AC bonus per SRD (nat 20 hits regardless).
  if (result.attacked && result.isHit && !result.isCrit && shieldAvailable(ctx)) {
    s.pendingReaction = {
      kind: 'shield',
      attackerId: npc.id,
      attackerName: combatantDisplayName(npc, s.npcs),
      incomingDamage: result.damage,
      attackTotal: result.attackTotal,
      shieldedAc: ctx.state.player.ac + 5,
    };
    ctx.addLog({ left: `⚡ Shield: ${combatantDisplayName(npc, s.npcs)} hits for ${result.damage} — react with Shield?`, style: 'header' });
    return;
  }

  if (result.attacked && result.isHit) {
    applyEnemyHitToPlayer(ctx, npc, result, events);
  }
  finalizeNpcTurn(ctx, npc);
  ctx.publish({ type: 'turn_ended', combatantId: npc.id });
}

/** Does the player meet basic reaction eligibility (not used, conscious, not incapacitated)? */
function playerCanReact(ctx: GameContext): boolean {
  const p = ctx.state.player;
  return !p.reactionUsed && p.hp > 0 && !isIncapacitated(p.conditions);
}

/** Can the player cast Shield right now (reaction + L1 slot + knows the spell)? Whether it would actually help is the player's call, not ours. */
function shieldAvailable(ctx: GameContext): boolean {
  if (!playerCanReact(ctx)) return false;
  if ((ctx.state.player.spellSlots[0] ?? 0) <= 0) return false;
  return ctx.state.player.preparedSpellIds.includes('shield')
    || (ctx.playerDef.defaultSpellbookIds?.includes('shield') ?? false);
}

/**
 * Apply an enemy hit's damage to the player, including death-save accrual when
 * the player is already at 0 HP. Factored out so it can be re-run from the
 * Shield resolver after a "decline" decision.
 */
function applyEnemyHitToPlayer(
  ctx: GameContext,
  npc: NpcState,
  result: { damage: number; isCrit: boolean; finalTileX: number; finalTileY: number },
  events: GameEvent[],
): void {
  const s = ctx.state;
  if (s.player.hp <= 0) {
    const adjacentToPlayer = chebyshev(result.finalTileX, result.finalTileY, s.player.tileX, s.player.tileY) <= 1;
    const effectivelyCrit = result.isCrit || adjacentToPlayer;
    const failures = effectivelyCrit ? 2 : 1;
    s.player.deathSaveFailures = Math.min(3, s.player.deathSaveFailures + failures);
    ctx.addLogs([
      { left: `Strikes unconscious ${ctx.playerDef.name}!${effectivelyCrit ? ' CRITICAL — 2 failures!' : ' 1 failure.'}`, style: 'status' },
      { left: `Death saves: ${s.player.deathSaveSuccesses} ✓  ${s.player.deathSaveFailures} ✗`, style: 'status' },
    ]);
    if (s.player.deathSaveFailures >= 3) {
      ctx.addLog({ left: `${ctx.playerDef.name} has died.`, style: 'kill' });
      s.phase = 'defeat';
    } else {
      s.phase = 'death_saves';
    }
  } else {
    ctx.applyDamageToPlayer(result.damage, events);
  }
  void npc;
}

/**
 * Cleanup at the end of an NPC's turn — runs after the reaction-deferral
 * points have all resolved. Currently:
 *   - clears the player's `hidden` condition (they're revealed by being struck
 *     at / observed during the enemy turn).
 *   - per-NPC Sleep re-save (SRD: target re-saves at end of its next turn).
 */
function finalizeNpcTurn(ctx: GameContext, npc: NpcState): void {
  const s = ctx.state;
  s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');

  // Sleep re-save: per SRD, the Incapacitated condition from Sleep ends at the
  // end of the target's next turn, at which point they re-save vs the original
  // DC. Success ends the spell on this target; failure replaces Incapacitated
  // with Unconscious for the spell's duration.
  if (s.player.concentratingOn === 'sleep' && (npc.conditions.includes('incapacitated') || npc.conditions.includes('unconscious'))) {
    const def = ctx.resolveMonsterDef(npc.defId);
    if (def) {
      const dc = 8 + ctx.playerDef.proficiencyBonus + (
        ctx.playerDef.spellcastingAbility ? mod(ctx.playerDef[ctx.playerDef.spellcastingAbility]) : 0
      );
      const saveMod = (def.savingThrows && def.savingThrows['wis'] !== undefined)
        ? def.savingThrows['wis']
        : mod(def.wis);
      const roll = d20Local();
      const total = roll + saveMod;
      const success = total >= dc;
      ctx.addLog({
        left: `${npc.name} ${success ? 'shakes off Sleep' : 'sinks deeper into Sleep'}`,
        right: `WIS d20(${roll})+${saveMod}=${total} vs DC ${dc}`,
        style: success ? 'status' : 'miss',
      });
      if (success) {
        npc.conditions = npc.conditions.filter((c) => c !== 'incapacitated' && c !== 'unconscious');
      } else if (npc.conditions.includes('incapacitated') && !npc.conditions.includes('unconscious')) {
        npc.conditions = npc.conditions.filter((c) => c !== 'incapacitated');
        npc.conditions.push('unconscious');
      }
    }
  }
}

function runSingleAllyTurn(ctx: GameContext, ally: NpcState, events: GameEvent[]): void {
  if (ally.combatPassive) return;
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(ally.defId);
  if (!def) return;
  // Per SRD: a creature's Reaction refreshes at the start of its own turn.
  ally.reactionUsed = false;
  ctx.publish({ type: 'turn_started', combatantId: ally.id });

  // Allies use the same NpcBrain — they break and flee under the same
  // morale model as enemies. Hold and attack share the existing logic.
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
    ctx.addLog({ left: `${combatantDisplayName(ally, s.npcs)} holds position`, style: 'status' });
    ctx.publish({ type: 'turn_ended', combatantId: ally.id });
    return;
  }

  const enemyTargets = s.npcs
    .filter((n) => n.disposition === 'enemy' && n.hp > 0)
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
        const meleeAtk = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
        const { finalDamage, log: resistLog } = ctx.resistMod(result.damage, meleeAtk?.damageType ?? '', targetDef, target.name);
        if (resistLog) ctx.addLog(resistLog);
        const hpBeforeAlly = target.hp;
        target.hp = Math.max(0, target.hp - finalDamage);
        publishNpcDamage(ctx, target, hpBeforeAlly, target.hp);
        if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
      }
    }
  }
  ctx.publish({ type: 'turn_ended', combatantId: ally.id });
}

/**
 * Resolve a pending player reaction. Applies the deferred outcome (fires the
 * Opportunity Attack or negates the incoming damage with Shield) when the
 * player accepts; otherwise skips the reaction entirely. Either way the NPC's
 * turn cleanup runs and the turn loop resumes via `advanceTurn`.
 */
export function doResolveReaction(ctx: GameContext, accept: boolean, events: GameEvent[]): void {
  const s = ctx.state;
  const pending = s.pendingReaction;
  if (!pending) return;
  s.pendingReaction = null;

  if (pending.kind === 'opportunity_attack') {
    const npc = s.npcs.find((n) => n.id === pending.npcId);
    if (npc) {
      if (accept) {
        ctx.doPlayerOpportunityAttack(npc, events);
      } else {
        ctx.addLog({ left: `${ctx.playerDef.name} holds — no Opportunity Attack`, style: 'status' });
      }
      finalizeNpcTurn(ctx, npc);
    }
  } else if (pending.kind === 'shield') {
    const attacker = s.npcs.find((n) => n.id === pending.attackerId);
    if (accept) {
      // Consume slot + reaction; the attack misses.
      if ((s.player.spellSlots[0] ?? 0) > 0) s.player.spellSlots[0] -= 1;
      s.player.reactionUsed = true;
      ctx.addLog({ left: `⚡ ${ctx.playerDef.name} casts Shield (reaction) — +5 AC until next turn`, style: 'status' });
      ctx.addLog({ left: `The attack glances off the magical barrier — miss`, style: 'miss' });
    } else if (attacker) {
      // Decline → apply the damage we saved when deferring.
      const synthResult = {
        damage: pending.incomingDamage,
        isCrit: false,
        finalTileX: attacker.tileX,
        finalTileY: attacker.tileY,
      };
      applyEnemyHitToPlayer(ctx, attacker, synthResult, events);
    }
    if (attacker) finalizeNpcTurn(ctx, attacker);
  }

  // Resume the turn loop.
  advanceTurn(ctx, events);
}
