import { GameEvent, NpcState, PlayerAttack, ItemDef, WeaponDef } from './types.js';
import type { GameContext } from './GameContext.js';
import {
  playerMeleeAttack, playerThrowAttack, playerHide, playerSecondWind, enemyAttack,
} from './CombatSystem.js';
import {
  isIncapacitated, grantsAdvantageAgainst, grantsDisadvantageAgainst,
  hasAttackDisadvantage, hasAttackAdvantage, isAutoCrit,
} from './ConditionSystem.js';
import { chebyshev } from './EnemyAI.js';
import { makePlayerAttack } from './EquipmentSystem.js';

export function doAttack(ctx: GameContext, targetId: string | undefined, events: GameEvent[]): void {
  const s = ctx.state;

  if (s.phase === 'exploring') {
    if (!targetId) return;
    const target = s.npcs.find((n) => n.id === targetId && n.hp > 0 && n.disposition !== 'ally');
    if (!target) return;
    if (chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY) > 1) return;
    if (target.disposition === 'neutral') {
      target.disposition = 'enemy';
      if (!target.combatLabel) ctx.assignCombatLabel(target);
    }
    ctx.aggroFaction(target);
    ctx.doStartCombat(events);
  }

  if (s.phase !== 'player_turn' || s.player.actionUsed) return;
  if (isIncapacitated(s.player.conditions)) return;

  const isAdjacent = (n: NpcState) =>
    n.disposition === 'enemy' && n.hp > 0 && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= 1;

  let target = targetId ? (s.npcs.find((n) => n.id === targetId && isAdjacent(n)) ?? null) : null;
  if (!target) target = s.npcs.find(isAdjacent) ?? null;
  if (!target) return;

  const targetDef = ctx.resolveMonsterDef(target.defId);
  if (!targetDef) return;

  const dist = chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY);
  const playerHidden = s.player.conditions.includes('hidden');
  const withAdvantage = playerHidden || hasAttackAdvantage(s.player.conditions) || grantsAdvantageAgainst(target.conditions, dist);
  const withDisadvantage = hasAttackDisadvantage(s.player.conditions) || grantsDisadvantageAgainst(target.conditions, dist);
  const autoCrit = isAutoCrit(target.conditions, dist);
  const { damage, logs, vexApplied, slowApplied } = playerMeleeAttack(ctx.playerDef, targetDef, withAdvantage, withDisadvantage, autoCrit, playerHidden);
  s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');
  ctx.addLogs(logs);

  const { finalDamage, log: resistLog } = ctx.resistMod(damage, ctx.playerDef.mainAttack.damageType, targetDef, target.name);
  if (resistLog) ctx.addLog(resistLog);
  target.hp = Math.max(0, target.hp - finalDamage);
  ctx.addLog({ left: `${target.name} HP: ${target.hp}/${target.maxHp}`, style: 'status' });
  ctx.applyMasteryConditions(target, vexApplied, slowApplied);
  if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);

  s.player.actionUsed = true;
}

export function throwItem(ctx: GameContext, itemId: string, targetId?: string): GameEvent[] {
  const s = ctx.state;
  const events: GameEvent[] = [];

  if (s.phase === 'player_turn' && (s.player.actionUsed || isIncapacitated(s.player.conditions))) return events;

  const inventoryIdx = s.player.inventoryIds.indexOf(itemId);
  const mapItemIdx = inventoryIdx === -1
    ? s.mapItems.findIndex((mi) => mi.id === itemId || mi.defId === itemId)
    : -1;
  if (inventoryIdx === -1 && mapItemIdx === -1) return events;

  const defId = inventoryIdx !== -1 ? itemId : s.mapItems[mapItemIdx].defId;
  const itemDef = ctx.defs.equipment.find((i) => i.id === defId);
  if (!itemDef) return events;

  const fromMap = mapItemIdx !== -1;
  const isProperThrown = !fromMap && itemDef.type === 'weapon' && (itemDef as WeaponDef).thrown;
  const normalRange = isProperThrown ? Math.floor((itemDef as WeaponDef).throwNormal / 5) : 4;
  const longRange = isProperThrown ? Math.floor((itemDef as WeaponDef).throwLong / 5) : 12;

  const inRange = (n: NpcState) =>
    n.hp > 0 && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= longRange;

  let target: NpcState | null = null;
  if (targetId) {
    if (targetId.startsWith('enemy_')) {
      target = s.npcs.find((n) => n.combatLabel === targetId.slice(6) && n.hp > 0) ?? null;
    } else if (targetId.startsWith('npc_')) {
      const stripped = targetId.slice(4);
      target = s.npcs.find((n) => (n.id === stripped || n.id === targetId) && n.hp > 0) ?? null;
    } else {
      target = s.npcs.find((n) => (n.id === targetId || n.combatLabel === targetId) && n.hp > 0) ?? null;
    }
    if (target && !inRange(target)) return events;
  }
  if (!target) target = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0).find(inRange) ?? null;
  if (!target) return events;

  if (target.disposition === 'neutral') {
    target.disposition = 'enemy';
    if (!target.combatLabel) ctx.assignCombatLabel(target);
    ctx.aggroFaction(target);
  }

  const targetDef = ctx.resolveMonsterDef(target.defId);
  if (!targetDef) return events;

  const attack: PlayerAttack = isProperThrown
    ? makePlayerAttack(ctx.playerDef, itemDef as WeaponDef)
    : { name: itemDef.name, statKey: 'str', damageDice: 1, damageSides: 4, damageType: 'bludgeoning', savageAttacker: false, graze: false, vex: false, sap: false, slow: false };
  const profBonus = isProperThrown ? ctx.playerDef.proficiencyBonus : 0;

  if (fromMap) s.mapItems.splice(mapItemIdx, 1);
  else s.player.inventoryIds.splice(inventoryIdx, 1);
  executeThrowOnTarget(ctx, attack, profBonus, normalRange, itemDef, target, targetDef);

  if (s.phase === 'exploring') ctx.doStartCombat(events);
  if (s.phase === 'player_turn') s.player.actionUsed = true;

  return events;
}

function executeThrowOnTarget(
  ctx: GameContext,
  attack: PlayerAttack,
  profBonus: number,
  normalRange: number,
  itemDef: ItemDef,
  target: NpcState,
  targetDef: import('./types.js').MonsterDef,
): void {
  const s = ctx.state;
  const dist = chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY);
  const adjacentEnemy = s.npcs.some((n) =>
    n.disposition === 'enemy' && n.hp > 0 &&
    chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= 1);
  const playerHidden = s.player.conditions.includes('hidden');
  const withAdvantage = playerHidden || grantsAdvantageAgainst(target.conditions, dist);
  const withDisadvantage = dist > normalRange || grantsDisadvantageAgainst(target.conditions, dist)
    || hasAttackDisadvantage(s.player.conditions) || adjacentEnemy;
  const autoCrit = isAutoCrit(target.conditions, dist);
  ctx.addLog({ left: `${ctx.playerDef.name} throws ${itemDef.name}`, style: 'normal' });
  const { damage, isHit, logs, vexApplied, slowApplied } = playerThrowAttack(
    ctx.playerDef, attack, targetDef, withAdvantage, withDisadvantage, profBonus, autoCrit, playerHidden,
  );
  s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');
  ctx.addLogs(logs);

  if (isHit) {
    target.inventoryIds.push(itemDef.id);
  } else {
    s.mapItems.push({ id: ctx.uid(), defId: itemDef.id, tileX: target.tileX, tileY: target.tileY });
  }

  const { finalDamage, log: resistLog } = ctx.resistMod(damage, attack.damageType, targetDef, target.name);
  if (resistLog) ctx.addLog(resistLog);
  target.hp = Math.max(0, target.hp - finalDamage);
  ctx.addLog({ left: `${target.name} HP: ${target.hp}/${target.maxHp}`, style: 'status' });
  ctx.applyMasteryConditions(target, vexApplied, slowApplied);
  if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
}

export function doHide(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase !== 'player_turn' || s.player.bonusActionUsed) return;
  if (isIncapacitated(s.player.conditions)) return;
  const living = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
  if (!living.length) return;
  const maxPP = Math.max(...living.map((n) => ctx.resolveMonsterDef(n.defId)?.passivePerception ?? 10));
  const { hidden, logs } = playerHide(ctx.playerDef, maxPP);
  if (hidden) {
    if (!s.player.conditions.includes('hidden')) s.player.conditions.push('hidden');
  } else {
    s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');
  }
  ctx.addLogs(logs);
  s.player.bonusActionUsed = true;
}

export function doDash(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase !== 'player_turn' || s.player.actionUsed) return;
  if (isIncapacitated(s.player.conditions)) return;
  s.player.movesLeft += ctx.playerDef.speed / 5;
  s.player.conditions.push('dashing');
  s.player.actionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} Dashes — +${ctx.playerDef.speed / 5} tiles movement`, style: 'status' });
}

export function doDodge(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase !== 'player_turn' || s.player.actionUsed) return;
  if (isIncapacitated(s.player.conditions)) return;
  s.player.conditions.push('dodging');
  s.player.actionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} Dodges — enemies attack with Disadvantage`, style: 'status' });
}

export function doDisengage(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase !== 'player_turn' || s.player.actionUsed) return;
  if (isIncapacitated(s.player.conditions)) return;
  s.player.conditions.push('disengaged');
  s.player.actionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} Disengages — no Opportunity Attacks this turn`, style: 'status' });
}

export function doSecondWind(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase !== 'player_turn' || s.player.bonusActionUsed || s.player.secondWindUses <= 0 || s.player.hp >= ctx.playerDef.maxHp) return;
  if (isIncapacitated(s.player.conditions)) return;
  const { healed, logs } = playerSecondWind(ctx.playerDef.level);
  const before = s.player.hp;
  s.player.hp = Math.min(ctx.playerDef.maxHp, s.player.hp + healed);
  s.player.secondWindUses--;
  ctx.addLogs([...logs, { left: `HP: ${before} → ${s.player.hp}/${ctx.playerDef.maxHp} (${s.player.secondWindUses} uses left)`, style: 'status' }]);
  s.player.bonusActionUsed = true;
}

export function doEnemyOpportunityAttack(ctx: GameContext, npc: NpcState, events: GameEvent[]): void {
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  const meleeAtk = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  if (!meleeAtk) return;
  npc.reactionUsed = true;
  const withDisadvantage = s.player.conditions.includes('dodging');
  const { damage, isHit, isCrit, logs } = enemyAttack(meleeAtk, ctx.playerDef.ac, false, withDisadvantage);
  ctx.addLogs([{ left: `⚡ ${npc.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
  if (isHit) ctx.applyDamageToPlayer(damage, events);
  void isCrit;
}

export function doPlayerOpportunityAttack(ctx: GameContext, npc: NpcState): void {
  const s = ctx.state;
  if (s.player.reactionUsed || s.player.hp <= 0) return;
  if (isIncapacitated(s.player.conditions)) return;
  const targetDef = ctx.resolveMonsterDef(npc.defId);
  if (!targetDef) return;
  s.player.reactionUsed = true;
  const dist = chebyshev(s.player.tileX, s.player.tileY, npc.tileX, npc.tileY);
  const oaAutoCrit = isAutoCrit(npc.conditions, dist);
  const { damage, logs, vexApplied, slowApplied } = playerMeleeAttack(ctx.playerDef, targetDef, false, false, oaAutoCrit);
  ctx.addLogs([{ left: `⚡ ${ctx.playerDef.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
  const { finalDamage, log: oaResistLog } = ctx.resistMod(damage, ctx.playerDef.mainAttack.damageType, targetDef, npc.name);
  if (oaResistLog) ctx.addLog(oaResistLog);
  npc.hp = Math.max(0, npc.hp - finalDamage);
  ctx.addLog({ left: `${npc.name} HP: ${npc.hp}/${npc.maxHp}`, style: 'status' });
  ctx.applyMasteryConditions(npc, vexApplied, slowApplied);
  if (npc.hp <= 0) ctx.killWithReward(npc, targetDef, `☠ ${npc.name} slain by Opportunity Attack!`, false);
}
