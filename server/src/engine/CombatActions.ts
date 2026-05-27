import { GameEvent, NpcState, PlayerAttack, ItemDef, WeaponDef, MonsterDef, LogEntry } from './types.js';
import type { RolledBonusDamage } from './CombatSystem.js';
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
import {
  canSpendAction, canDash as guardCanDash, canDodge as guardCanDodge,
  canDisengage as guardCanDisengage, canHide as guardCanHide,
  canAttackTarget, playerAttackReachTiles, hasCunningAction,
  canDetach as guardCanDetach,
} from './ActionGuards.js';
import { publishNpcDamage } from './ThresholdPublisher.js';

export function doAttack(ctx: GameContext, targetId: string | undefined, events: GameEvent[]): void {
  const s = ctx.state;
  const atk = ctx.playerDef.mainAttack;
  const isRangedWeapon = !!atk.rangeNormal && atk.rangeNormal > 0;
  const reachTiles = playerAttackReachTiles(ctx);

  if (s.phase === 'exploring') {
    if (!canAttackTarget(ctx, targetId)) return;
    const target = s.npcs.find((n) => n.id === targetId && n.hp > 0 && n.disposition !== 'ally')!;
    if (target.disposition === 'neutral') {
      target.disposition = 'enemy';
      if (!target.combatLabel) ctx.assignCombatLabel(target);
    }
    ctx.aggroFaction(target);
    ctx.doStartCombat(events);
  }

  if (!canSpendAction(ctx)) return;

  // Pick the target: prefer the explicit targetId; otherwise nearest hostile in reach.
  const inReach = (n: NpcState): boolean =>
    n.disposition === 'enemy' && n.hp > 0
    && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= reachTiles;

  let target = targetId ? (s.npcs.find((n) => n.id === targetId && inReach(n)) ?? null) : null;
  if (!target) target = s.npcs.find(inReach) ?? null;
  if (!target) return;

  const targetDef = ctx.resolveMonsterDef(target.defId);
  if (!targetDef) return;

  const dist = chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY);
  const playerHidden = s.player.conditions.includes('hidden');

  // Ranged-specific Disadvantage sources, layered onto the existing ones.
  let rangedDisadvantage = false;
  if (isRangedWeapon) {
    // Ammo gate.
    const ammoIdx = atk.ammunitionType ? s.player.inventoryIds.indexOf(atk.ammunitionType) : -1;
    if (atk.ammunitionType && ammoIdx === -1) {
      ctx.addLog({ left: `${ctx.playerDef.name} has no ${atk.ammunitionType}s — cannot fire`, style: 'miss' });
      return;
    }
    // Beyond normal range = Disadvantage (already gated against long range by canAttackTarget).
    const normalTiles = Math.floor((atk.rangeNormal ?? 0) / 5);
    if (dist > normalTiles) rangedDisadvantage = true;
    // Heavy ranged weapon with DEX < 13 = Disadvantage (SRD).
    if (atk.heavy && ctx.playerDef.dex < 13) rangedDisadvantage = true;
    // Adjacent enemy (other than the target) imposes Disadvantage on ranged attacks.
    const adjacentEnemy = s.npcs.some((n) =>
      n.disposition === 'enemy' && n.hp > 0 && n !== target
      && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= 1
      && !n.conditions.includes('incapacitated'),
    );
    if (adjacentEnemy) rangedDisadvantage = true;
    // Consume one ammunition; remember the tile we'd potentially recover from.
    if (ammoIdx !== -1) s.player.inventoryIds.splice(ammoIdx, 1);
  }

  const withAdvantage = playerHidden || hasAttackAdvantage(s.player.conditions) || grantsAdvantageAgainst(target.conditions, dist);
  const withDisadvantage = hasAttackDisadvantage(s.player.conditions) || grantsDisadvantageAgainst(target.conditions, dist) || rangedDisadvantage;
  const autoCrit = isAutoCrit(target.conditions, dist);
  const resolved = playerThrowAttack(
    ctx.playerDef, atk, targetDef, withAdvantage, withDisadvantage, ctx.playerDef.proficiencyBonus, autoCrit, playerHidden,
  );
  s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');

  // Defensive reactions (e.g. Noble's Parry): trigger when the NPC was hit by
  // a melee attack roll. If the +AC bump turns the hit into a miss, suppress
  // the resolver's hit log and emit a clean parry-miss line. Crits ignore
  // defensive AC (nat 20 always hits) — match the Shield convention.
  const parry = tryNpcParry(target, targetDef, dist, resolved);
  const { damage, isHit, logs, vexApplied, slowApplied, bonusComponents } = parry.applied
    ? parry.replaced
    : resolved;
  ctx.addLogs(logs);

  if (!isHit) {
    void bonusComponents; void vexApplied; void slowApplied; void damage;
  } else {
    const { finalDamage, log: resistLog } = ctx.resistMod(damage, atk.damageType, targetDef, target.name);
    if (resistLog) ctx.addLog(resistLog);
    const hpBeforeAtk = target.hp;
    target.hp = Math.max(0, target.hp - finalDamage);
    for (const bd of bonusComponents) {
      const { finalDamage: bdFinal, log: bdResistLog } = ctx.resistMod(bd.damage, bd.damageType, targetDef, target.name);
      ctx.addLog({ left: `+ ${bdFinal} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
      if (bdResistLog) ctx.addLog(bdResistLog);
      target.hp = Math.max(0, target.hp - bdFinal);
    }
    publishNpcDamage(ctx, target, hpBeforeAtk, target.hp);
    ctx.applyMasteryConditions(target, vexApplied, slowApplied);
  }

  // SRD ammunition recovery: per-shot 50% chance the ammo lands recoverable on
  // the target's tile (or where the target was before it died). Hits embed the
  // arrow in the target; misses skip into the dirt nearby — same odds for our
  // model. Only applies to ranged attacks that consumed ammo.
  if (isHit && isRangedWeapon && atk.ammunitionType && Math.random() < 0.5) {
    s.mapItems.push({
      id: ctx.uid(),
      defId: atk.ammunitionType,
      tileX: target.tileX,
      tileY: target.tileY,
    });
  }

  if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);

  s.player.actionUsed = true;
}

export function throwItem(ctx: GameContext, itemId: string, targetId?: string): GameEvent[] {
  const s = ctx.state;
  const events: GameEvent[] = [];

  if (s.phase === 'player_turn' && !canSpendAction(ctx)) return events;

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
  const { damage, isHit, logs, vexApplied, slowApplied, bonusComponents } = playerThrowAttack(
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
  const hpBeforeThr = target.hp;
  target.hp = Math.max(0, target.hp - finalDamage);
  for (const bd of bonusComponents) {
    const { finalDamage: bdFinal, log: bdResistLog } = ctx.resistMod(bd.damage, bd.damageType, targetDef, target.name);
    ctx.addLog({ left: `+ ${bdFinal} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
    if (bdResistLog) ctx.addLog(bdResistLog);
    target.hp = Math.max(0, target.hp - bdFinal);
  }
  publishNpcDamage(ctx, target, hpBeforeThr, target.hp);
  ctx.applyMasteryConditions(target, vexApplied, slowApplied);
  if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
}

export function doHide(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanHide(ctx)) return;
  // Stealth check is opposed by the highest Passive Perception that could spot
  // the player: any non-ally, non-dead, non-incapacitated NPC. Neutral NPCs
  // count (you can hide from a bandit who hasn't decided to fight yet).
  // Empty-list fallback uses the SRD default Passive Perception of 10.
  const observers = s.npcs.filter((n) =>
    n.disposition !== 'ally'
    && n.hp > 0
    && !n.conditions.includes('incapacitated')
    && !n.conditions.includes('unconscious'),
  );
  const passivePerceptions = observers.map((n) => ctx.resolveMonsterDef(n.defId)?.passivePerception ?? 10);
  const maxPP = passivePerceptions.length > 0 ? Math.max(...passivePerceptions) : 10;
  const { hidden, logs } = playerHide(ctx.playerDef, maxPP);
  if (hidden) {
    if (!s.player.conditions.includes('hidden')) s.player.conditions.push('hidden');
  } else {
    s.player.conditions = s.player.conditions.filter((c) => c !== 'hidden');
  }
  ctx.addLogs(logs);
  // Action economy only applies in combat. During exploring, hiding is free —
  // it's the Sneak Attack opener that triggers combat with Advantage.
  if (s.phase === 'player_turn') {
    if (hasCunningAction(ctx)) s.player.bonusActionUsed = true;
    else s.player.actionUsed = true;
  }
}

export function doDash(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanDash(ctx)) return;
  s.player.movesLeft += ctx.playerDef.speed / 5;
  s.player.conditions.push('dashing');
  s.player.actionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} Dashes — +${ctx.playerDef.speed / 5} tiles movement`, style: 'status' });
}

export function doDodge(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanDodge(ctx)) return;
  s.player.conditions.push('dodging');
  s.player.actionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} Dodges — enemies attack with Disadvantage`, style: 'status' });
}

export function doDisengage(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanDisengage(ctx)) return;
  s.player.conditions.push('disengaged');
  s.player.actionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} Disengages — no Opportunity Attacks this turn`, style: 'status' });
}

/**
 * Detach all currently-attached creatures from the player. Per SRD: "The
 * target or a creature within 5 feet of it can detach the stirge as an
 * action." We model this as one action that removes every attach effect
 * currently on the player — the player can re-engage the freed sources
 * normally on their next move.
 */
export function doDetach(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanDetach(ctx)) return;
  const attached = s.player.ongoingEffects.filter((oe) => oe.kind === 'attach');
  s.player.ongoingEffects = s.player.ongoingEffects.filter((oe) => oe.kind !== 'attach');
  s.player.actionUsed = true;
  const names = attached
    .map((oe) => s.npcs.find((n) => n.id === oe.sourceNpcId)?.name)
    .filter((n): n is string => !!n);
  const what = names.length ? names.join(', ') : 'attached creature';
  ctx.addLog({ left: `${ctx.playerDef.name} pries off ${what}`, style: 'status' });
}

export function doEnemyOpportunityAttack(ctx: GameContext, npc: NpcState, events: GameEvent[]): void {
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  const meleeAtk = def.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  if (!meleeAtk) return;
  npc.reactionUsed = true;
  const withDisadvantage = s.player.conditions.includes('dodging');
  const { damage, isHit, isCrit, logs, bonusComponents } = enemyAttack(meleeAtk, ctx.playerDef.ac, false, withDisadvantage);
  ctx.addLogs([{ left: `⚡ ${npc.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
  if (isHit) {
    ctx.applyDamageToPlayer(damage, events);
    for (const bd of bonusComponents) {
      ctx.addLog({ left: `+ ${bd.damage} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
      ctx.applyDamageToPlayer(bd.damage, events);
    }
  }
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
  const { damage, logs, vexApplied, slowApplied, bonusComponents } = playerMeleeAttack(ctx.playerDef, targetDef, false, false, oaAutoCrit);
  ctx.addLogs([{ left: `⚡ ${ctx.playerDef.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
  const { finalDamage, log: oaResistLog } = ctx.resistMod(damage, ctx.playerDef.mainAttack.damageType, targetDef, npc.name);
  if (oaResistLog) ctx.addLog(oaResistLog);
  const hpBeforeOa = npc.hp;
  npc.hp = Math.max(0, npc.hp - finalDamage);
  for (const bd of bonusComponents) {
    const { finalDamage: bdFinal, log: bdResistLog } = ctx.resistMod(bd.damage, bd.damageType, targetDef, npc.name);
    ctx.addLog({ left: `+ ${bdFinal} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
    if (bdResistLog) ctx.addLog(bdResistLog);
    npc.hp = Math.max(0, npc.hp - bdFinal);
  }
  publishNpcDamage(ctx, npc, hpBeforeOa, npc.hp);
  ctx.applyMasteryConditions(npc, vexApplied, slowApplied);
  if (npc.hp <= 0) ctx.killWithReward(npc, targetDef, `☠ ${npc.name} slain by Opportunity Attack!`, false);
}

/**
 * Generic NPC-vs-NPC Opportunity Attack. Used for both directions:
 *   • Ally OAs an enemy that moves out of the ally's reach
 *   • Enemy OAs an ally that moves out of the enemy's reach
 *
 * Caller is responsible for eligibility gating (reaction available, visibility,
 * incapacitation, reach transition). This helper just resolves the attack and
 * marks the reaction consumed.
 */
export function doNpcOpportunityAttack(
  ctx: GameContext,
  attacker: NpcState,
  target: NpcState,
  attackerDisplayName: string,
  targetDisplayName: string,
): void {
  const attackerDef = ctx.resolveMonsterDef(attacker.defId);
  const targetDef = ctx.resolveMonsterDef(target.defId);
  if (!attackerDef || !targetDef) return;
  const meleeAtk = attackerDef.attacks.find((a) => a.attackType === 'melee' || a.attackType === 'both');
  if (!meleeAtk) return;
  attacker.reactionUsed = true;

  const dist = chebyshev(attacker.tileX, attacker.tileY, target.tileX, target.tileY);
  const targetDodging = target.conditions.includes('dodging');
  const withDisadvantage = targetDodging || (target.conditions.includes('prone') && dist > 1);
  const withAdvantage = target.conditions.includes('prone') && dist <= 1;
  const { damage, isHit, isCrit, logs, bonusComponents } = enemyAttack(meleeAtk, targetDef.ac, withAdvantage, withDisadvantage);
  ctx.addLogs([{ left: `⚡ ${attackerDisplayName} makes an Opportunity Attack on ${targetDisplayName}!`, style: 'header' }, ...logs]);
  if (isHit) {
    const { finalDamage, log: resistLog } = ctx.resistMod(damage, meleeAtk.damageType, targetDef, target.name);
    if (resistLog) ctx.addLog(resistLog);
    const hpBeforeNpcOa = target.hp;
    target.hp = Math.max(0, target.hp - finalDamage);
    for (const bd of bonusComponents) {
      const { finalDamage: bdFinal, log: bdResistLog } = ctx.resistMod(bd.damage, bd.damageType, targetDef, target.name);
      ctx.addLog({ left: `+ ${bdFinal} ${bd.damageType}`, right: bd.rollStr, style: 'hit' });
      if (bdResistLog) ctx.addLog(bdResistLog);
      target.hp = Math.max(0, target.hp - bdFinal);
    }
    publishNpcDamage(ctx, target, hpBeforeNpcOa, target.hp);
    if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} slain by Opportunity Attack!`, false);
  }
  void isCrit;
}

interface ResolvedAttack {
  damage: number;
  isHit: boolean;
  isCrit: boolean;
  attackTotal: number;
  naturalRoll: number;
  logs: LogEntry[];
  vexApplied: boolean;
  slowApplied: boolean;
  bonusComponents: RolledBonusDamage[];
}

/**
 * SRD Parry: when an NPC is hit by a melee attack roll while holding a weapon,
 * they may use their reaction to add `acBonus` to their AC against that attack.
 * The reaction is only consumed when the trigger fires — i.e. the attack must
 * have landed at base AC. Crits ignore Parry's AC bonus (nat 20 hits regardless,
 * matching the engine's Shield convention). If the bumped AC turns the hit into
 * a miss, the caller substitutes a clean parry-miss log; otherwise it logs that
 * the parry was attempted but the strike still landed.
 */
function tryNpcParry(
  target: NpcState,
  targetDef: MonsterDef,
  dist: number,
  resolved: ResolvedAttack,
): { applied: false } | { applied: true; replaced: ResolvedAttack } {
  if (dist > 1) return { applied: false };
  if (!resolved.isHit || resolved.isCrit) return { applied: false };
  if (target.reactionUsed) return { applied: false };
  if (isIncapacitated(target.conditions)) return { applied: false };
  const parry = (targetDef.reactions ?? []).find((r) => r.kind === 'parry');
  if (!parry) return { applied: false };

  target.reactionUsed = true;
  const newAc = targetDef.ac + parry.acBonus;
  const stillHits = resolved.naturalRoll === 20 || resolved.attackTotal >= newAc;

  if (stillHits) {
    return {
      applied: true,
      replaced: {
        ...resolved,
        logs: [
          ...resolved.logs,
          { left: `${target.name} parries — +${parry.acBonus} AC, but the strike lands anyway`, style: 'status' },
        ],
      },
    };
  }

  return {
    applied: true,
    replaced: {
      ...resolved,
      damage: 0,
      isHit: false,
      vexApplied: false,
      slowApplied: false,
      bonusComponents: [],
      logs: [
        { left: `${target.name} parries — +${parry.acBonus} AC turns the strike aside`, right: `vs AC ${newAc}`, style: 'miss' },
      ],
    },
  };
}
