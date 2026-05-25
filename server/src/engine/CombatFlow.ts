import { GameEvent, NpcState, LogEntry, CombatMode } from './types.js';
import type { GameContext } from './GameContext.js';
import { rollOneInitiative, rollDeathSave } from './CombatSystem.js';
import { runEnemyTurn, runAllyTurn, chebyshev } from './EnemyAI.js';
import { isIncapacitated, hasSpeedZero, proneStandCost, TURN_CONDITIONS } from './ConditionSystem.js';
import { mod, d20 as d20Local } from './Dice.js';
import { tryReactiveShield } from './SpellSystem.js';

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
    n.reactionUsed = false;
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
  }
}

/**
 * Player presses End Turn. Hand off to the next combatant in the initiative
 * order via advanceTurn.
 */
export function endPlayerTurn(ctx: GameContext, events: GameEvent[]): void {
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
function combatantDisplayName(npc: NpcState, allNpcs: NpcState[]): string {
  const base = npc.revealedName ?? npc.name;
  const duplicates = allNpcs.filter((n) => (n.revealedName ?? n.name) === base && n.disposition !== 'neutral').length;
  if (duplicates > 1 && npc.combatLabel) return `${base} (${npc.combatLabel})`;
  return base;
}

function runSingleEnemyTurn(ctx: GameContext, npc: NpcState, events: GameEvent[]): void {
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) { npc.isActive = false; return; }

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

  if (startedAdjacentToPlayer && !endedAdjacentToPlayer && !result.attacked) {
    ctx.doPlayerOpportunityAttack(npc, events);
  }

  ctx.addLogs(result.logs);

  // Shield reaction: if the hit lands by ≤5, the player can react with Shield
  // to convert it to a miss. Auto-cast when the spell is known and a slot is free.
  let shieldNegated = false;
  if (result.attacked && result.isHit && !result.isCrit) {
    if (tryReactiveShield(ctx, result.attackTotal, result.isCrit)) {
      shieldNegated = true;
      ctx.addLog({ left: `The attack glances off the magical barrier — miss`, style: 'miss' });
    }
  }

  if (result.attacked && result.isHit && !shieldNegated) {
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
  }
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

  if (result.attacked && result.isHit && result.attackedTargetId) {
    const target = s.npcs.find((n) => n.id === result.attackedTargetId);
    if (target) {
      const targetDef = ctx.resolveMonsterDef(target.defId);
      if (targetDef) {
        const meleeAtk = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
        const { finalDamage, log: resistLog } = ctx.resistMod(result.damage, meleeAtk?.damageType ?? '', targetDef, target.name);
        if (resistLog) ctx.addLog(resistLog);
        target.hp = Math.max(0, target.hp - finalDamage);
        if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
      }
    }
  }
}
