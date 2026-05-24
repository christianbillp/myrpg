import { GameEvent, NpcState, LogEntry, CombatMode } from './types.js';
import type { GameContext } from './GameContext.js';
import { rollInitiative, rollDeathSave } from './CombatSystem.js';
import { runEnemyTurn, runAllyTurn, chebyshev } from './EnemyAI.js';
import { isIncapacitated, hasSpeedZero, proneStandCost, TURN_CONDITIONS } from './ConditionSystem.js';

export function endCombat(ctx: GameContext): GameEvent[] {
  const s = ctx.state;
  s.phase = 'exploring';
  s.npcs = s.npcs.filter((n) => n.disposition !== 'enemy' || n.hp === 0);
  s.npcs.filter((n) => n.disposition === 'ally' && n.hp > 0).forEach((n) => { n.disposition = 'neutral'; });
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

export function doStartCombat(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  const enemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
  const firstEnemyDef = enemies[0] ? ctx.resolveMonsterDef(enemies[0].defId) : undefined;
  if (!firstEnemyDef) return;

  s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');
  s.player.deathSaveSuccesses = 0;
  s.player.deathSaveFailures = 0;
  s.activeNpcIndex = 0;
  const combatNpcs = s.npcs.filter((n) => n.disposition !== 'neutral' && n.hp > 0);
  for (const npc of combatNpcs.filter((n) => !n.combatLabel)) ctx.assignCombatLabel(npc);
  s.turnOrderIds = ['player', ...combatNpcs.map((n) => n.id)];

  const { playerFirst, logs } = rollInitiative(ctx.playerDef, firstEnemyDef, enemies[0].name);
  ctx.addLogs(logs);

  if (playerFirst) {
    enterPlayerTurn(ctx);
  } else {
    enterEnemyPhase(ctx, events);
  }
}

export function enterPlayerTurn(ctx: GameContext): void {
  const s = ctx.state;
  s.phase = 'player_turn';
  s.activeNpcIndex = 0;
  s.npcs.filter((n) => n.disposition !== 'neutral' && n.hp > 0).forEach((n) => {
    n.isActive = false;
    n.reactionUsed = false;
    n.conditions = n.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  });
  s.player.actionUsed = false;
  s.player.bonusActionUsed = false;
  s.player.reactionUsed = false;
  s.player.conditions = s.player.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  if (hasSpeedZero(s.player.conditions)) {
    s.player.movesLeft = 0;
  } else {
    const tileSpeed = ctx.playerDef.speed / 5;
    const standCost = proneStandCost(s.player.conditions, tileSpeed);
    s.player.movesLeft = Math.max(0, tileSpeed - standCost);
    if (standCost > 0) s.player.conditions = s.player.conditions.filter((c) => c !== 'prone');
  }
}

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
    s.player.movesLeft = ctx.playerDef.speed / 5;
    s.phase = 'player_turn';
  } else if (nextPhase === 'enemy_turn') {
    enterEnemyPhase(ctx, events);
  } else {
    s.phase = nextPhase;
  }
}

export function enterEnemyPhase(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  s.phase = 'enemy_turn';
  s.activeNpcIndex = 0;
  runAllNpcCombatTurns(ctx, events);
}

function runAllNpcCombatTurns(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;

  for (const npc of s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0)) {
    if (s.phase === 'defeat') break;
    npc.isActive = true;
    runSingleEnemyTurn(ctx, npc, events);
  }

  if (s.phase !== 'defeat' && s.phase !== 'death_saves') {
    for (const ally of s.npcs.filter((n) => n.disposition === 'ally' && n.hp > 0)) {
      ally.isActive = true;
      runSingleAllyTurn(ctx, ally, events);
    }
  }

  if (s.phase !== 'defeat' && s.phase !== 'death_saves') {
    if (s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0).length === 0) {
      s.phase = 'exploring';
    } else {
      enterPlayerTurn(ctx);
    }
  }
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

  if (result.attacked && result.isHit) {
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
  npc.isActive = false;
}

function runSingleAllyTurn(ctx: GameContext, ally: NpcState, events: GameEvent[]): void {
  if (ally.combatPassive) { ally.isActive = false; return; }
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(ally.defId);
  if (!def) { ally.isActive = false; return; }

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
        ctx.addLog({ left: `${target.name} HP: ${target.hp}/${target.maxHp}`, style: 'status' });
        if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
      }
    }
  }

  ally.isActive = false;
}
