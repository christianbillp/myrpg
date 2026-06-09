import { GameEvent, NpcState, PlayerAttack, ItemDef, WeaponDef, MonsterDef, LogEntry, sizeRank } from './types.js';
import type { RolledBonusDamage, ResolvedPlayerAttack } from './CombatSystem.js';
import type { GameContext } from './GameContext.js';
import {
  playerMeleeAttack, playerThrowAttack, playerHide, playerSecondWind, enemyAttack,
} from './CombatSystem.js';
import {
  isIncapacitated, grantsAdvantageAgainst, grantsDisadvantageAgainst,
  hasAttackDisadvantage, hasAttackAdvantage, isAutoCrit, clearHide,
  speedAfterExhaustion,
} from './ConditionSystem.js';
import { chebyshev } from './EnemyAI.js';
import { makePlayerAttack } from './EquipmentSystem.js';
import {
  canSpendAction, canDash as guardCanDash, canDodge as guardCanDodge,
  canDisengage as guardCanDisengage, canHide as guardCanHide,
  canAttackTarget, playerAttackReachTiles, hasCunningAction,
  canDetach as guardCanDetach, playerArmorSpeedPenaltyFt, playerHasStealthDisadvantage,
} from './ActionGuards.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { applyGiantGiftOnHit } from './GiantGifts.js';
import { canSee as visCanSee } from './Vision.js';
import { endConcentration } from './ConcentrationSystem.js';
import type { PlayerDef } from '../../../shared/types.js';
import { d20, mod, rollDiceBonus } from './Dice.js';
import { combatantDisplayName } from './CombatFlow.js';
import { requestCombatStart } from './CombatStartPrompt.js';

/** Number of weapon attacks the player makes per Attack action. Driven by
 *  the class JSON's `extra-attacks` track (Fighter scales 1→4 at L1/5/11/20;
 *  Barbarian/Paladin/Ranger/Monk scale 1→2 at L5). Used by the Attack action
 *  resolver to decide how many times to loop the resolver. Defaults to 1
 *  when the track is missing (non-extra-attack classes). */
export function attacksPerAction(playerDef: PlayerDef): number {
  const v = playerDef.tracks?.['extra-attacks'];
  return typeof v === 'number' && v > 0 ? v : 1;
}

/** SRD Exhaustion penalty to the player's attack rolls (a D20 Test): −2 ×
 *  exhaustion level (US-113), mirroring the check/save penalty in
 *  `GameEngine.rollAbilityCheck` / `rollSavingThrow`. */
function exhaustionAttackMod(ctx: GameContext): number {
  return -((ctx.state.player.exhaustionLevel ?? 0) * 2);
}

/** Flat modifier added to a player attack roll from runtime state: the
 *  Exhaustion penalty plus a fresh Bless-style `attackDiceBonus` roll (SRD: a
 *  separate d4 per attack roll). */
function attackRollMod(ctx: GameContext): number {
  return exhaustionAttackMod(ctx) + rollDiceBonus(ctx.state.player.attackDiceBonus);
}

/**
 * SRD Rogue Sneak Attack eligibility (L1 feature).
 *
 *   "Once per turn, you can deal an extra 1d6 damage to one creature you hit
 *    with an attack roll if you have Advantage on the roll and the attack
 *    uses a Finesse or a Ranged weapon. You don't need Advantage if at
 *    least one of your allies is within 5 feet of the target, the ally
 *    doesn't have the Incapacitated condition, and you don't have
 *    Disadvantage on the attack roll."
 *
 * Returns true when this specific attack qualifies. Caller passes the flag
 * down to `playerMeleeAttack` / `playerThrowAttack`; the resolver adds the
 * Sneak dice when the attack actually hits and toggles
 * `state.player.sneakAttackUsedThisTurn` via the `sneakAttackFired` return
 * to enforce the once-per-turn rule.
 */
function sneakAttackEligible(
  ctx: GameContext,
  attack: PlayerAttack,
  target: NpcState,
  withAdvantage: boolean,
  withDisadvantage: boolean,
): boolean {
  const s = ctx.state;
  if (s.player.sneakAttackUsedThisTurn) return false;
  if ((ctx.playerDef.sneakAttackDice ?? 0) <= 0) return false;
  const isRanged = !!attack.rangeNormal && attack.rangeNormal > 0;
  if (!isRanged && !attack.finesse) return false;
  if (withAdvantage) return true;
  if (withDisadvantage) return false;
  // Alternative trigger: an unincapacitated ally within 5 ft of the target.
  return s.npcs.some((n) =>
    n.disposition === 'ally' && n.hp > 0
    && !n.conditions.includes('incapacitated')
    && !n.conditions.includes('unconscious')
    && !n.conditions.includes('paralyzed')
    && !n.conditions.includes('stunned')
    && chebyshev(n.tileX, n.tileY, target.tileX, target.tileY) <= 1,
  );
}

/**
 * Shove a target directly away from the player up to `tiles` tiles. Stops at
 * impassable terrain, other creatures, the map edge, or the player's own tile.
 * Returns the number of tiles actually moved. Shared by the Push mastery (10 ft)
 * and the Shove action (5 ft, US-050).
 */
function pushAway(ctx: GameContext, target: NpcState, tiles: number): number {
  const s = ctx.state;
  const dx = Math.sign(target.tileX - s.player.tileX);
  const dy = Math.sign(target.tileY - s.player.tileY);
  if (dx === 0 && dy === 0) return 0;
  let moved = 0;
  for (let step = 0; step < tiles; step++) {
    const nx = target.tileX + dx;
    const ny = target.tileY + dy;
    if (ny < 0 || ny >= s.map.rows || nx < 0 || nx >= s.map.cols) break;
    if (s.map.blocksMovement[ny][nx]) break;
    if (s.player.tileX === nx && s.player.tileY === ny) break;
    if (s.npcs.some((o) => o.id !== target.id && o.hp > 0 && o.tileX === nx && o.tileY === ny)) break;
    target.tileX = nx;
    target.tileY = ny;
    moved++;
  }
  return moved;
}

/**
 * SRD Push mastery — a hit can shove the target 10 ft directly away from
 * the attacker (Large or smaller). Stops at impassable terrain, other
 * creatures, or the attacker's own tile.
 */
function applyPushMastery(ctx: GameContext, target: NpcState): void {
  const moved = pushAway(ctx, target, 2);  // 10 ft = 2 tiles.
  if (moved > 0) {
    ctx.addLog({ left: `↪ Push mastery — ${combatantDisplayName(target, ctx.state.npcs)} pushed ${moved * 5} ft`, style: 'status' });
  }
}

/**
 * SRD Topple mastery — on hit, target makes a Con save (DC = 8 + STR mod +
 * PB) or falls Prone. Save uses the target's Con mod (with proficiency
 * when listed in `savingThrows`).
 */
function applyToppleMastery(ctx: GameContext, target: NpcState, def: MonsterDef): void {
  if (target.conditions.includes('prone')) return;
  const dc = 8 + mod(ctx.playerDef.str) + ctx.playerDef.proficiencyBonus;
  const saveMod = def.savingThrows?.['con'] ?? mod(def.con);
  const roll = d20();
  const total = roll + saveMod;
  const success = total >= dc;
  ctx.addLog({
    left: `↪ Topple mastery — ${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'stays standing' : 'falls Prone'}`,
    right: `CON d20(${roll})+${saveMod}=${total} vs DC ${dc}`,
    style: success ? 'normal' : 'status',
  });
  if (!success) target.conditions.push('prone');
}

/**
 * Push a `play_sound` GameEvent for a resolved physical attack. The client's
 * SoundLibrary plays a hit thump or a swing-whoosh accordingly. Called from
 * every physical-attack resolver — main attack, throw, OAs (player + NPC),
 * and the NPC-vs-player path in NpcTurnRunners. Silent no-op when there's
 * no outer eventSink in scope (e.g. AIGM-driven combat resolves).
 */
export function emitPhysicalAttackSound(ctx: GameContext, isHit: boolean): void {
  ctx.eventSink?.push({ type: 'play_sound', sound: isHit ? 'physical_hit' : 'physical_miss' });
}

/**
 * SRD Cover applied to a player attack against `target`. Returns the AC
 * bonus the target benefits from (0/2/5) or the sentinel `untargetable: true`
 * when Total Cover blocks the line — callers short-circuit on that to avoid
 * wasting Actions / spell slots.
 */
function coverBonusVsTarget(ctx: GameContext, target: NpcState): { bonus: number; untargetable: boolean } {
  const vision = visCanSee(
    ctx.state,
    { tileX: ctx.state.player.tileX, tileY: ctx.state.player.tileY, senses: ctx.playerDef.senses },
    { tileX: target.tileX, tileY: target.tileY, conditions: target.conditions, id: target.id },
  );
  switch (vision.cover) {
    case 'half':           return { bonus: 2, untargetable: false };
    case 'three-quarters': return { bonus: 5, untargetable: false };
    case 'total':          return { bonus: 0, untargetable: true };
    default:               return { bonus: 0, untargetable: false };
  }
}

/**
 * Cover bonus the player benefits from against `npc`'s attack — vision is
 * walked from the NPC's tile to the player's tile, and the worst cover the
 * line traverses is translated to an AC bonus (half +2, three-quarters +5,
 * total +∞ but the NPC AI wouldn't be attacking through total cover).
 */
function playerCoverAcVsNpc(ctx: GameContext, npc: NpcState): number {
  const def = ctx.resolveMonsterDef(npc.defId);
  const vision = visCanSee(
    ctx.state,
    { tileX: npc.tileX, tileY: npc.tileY, senses: def?.senses },
    { tileX: ctx.state.player.tileX, tileY: ctx.state.player.tileY, conditions: ctx.state.player.conditions, id: 'player' },
  );
  switch (vision.cover) {
    case 'half': return 2;
    case 'three-quarters': return 5;
    case 'total': return 99;
    default: return 0;
  }
}

export function doAttack(ctx: GameContext, targetId: string | undefined, events: GameEvent[]): void {
  const s = ctx.state;
  const atk = ctx.playerDef.mainAttack;
  const isRangedWeapon = !!atk.rangeNormal && atk.rangeNormal > 0;
  const reachTiles = playerAttackReachTiles(ctx);

  if (s.phase === 'exploring') {
    if (!canAttackTarget(ctx, targetId)) return;
    const target = s.npcs.find((n) => n.id === targetId && n.hp > 0 && n.disposition !== 'ally')!;
    // Attacking out of combat WOULD start it — pause for confirmation instead
    // of acting. On accept the engine rolls initiative; the player then attacks
    // normally on their turn (this action is NOT auto-performed).
    requestCombatStart(ctx, [target.id], `Attacking ${combatantDisplayName(target, s.npcs)} will start combat.`);
    return;
  }

  // SRD Extra Attack (US-119): allow a follow-up attack from the reserved pool
  // even though the Action is already committed.
  if (!canSpendAction(ctx) && (s.player.attacksRemaining ?? 0) <= 0) return;

  // Pick the target: prefer the explicit targetId; otherwise nearest hostile in reach.
  const inReach = (n: NpcState): boolean =>
    n.disposition === 'enemy' && n.hp > 0
    && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= reachTiles;

  let target = targetId ? (s.npcs.find((n) => n.id === targetId && inReach(n)) ?? null) : null;
  if (!target) target = s.npcs.find(inReach) ?? null;
  if (!target) return;

  const targetDef = ctx.resolveMonsterDef(target.defId);
  if (!targetDef) return;

  // SRD Sanctuary ends when the warded creature makes an attack roll. The
  // attack is now committed (target + def resolved), so drop the ward.
  if (s.player.conditions.includes('sanctuary')) {
    s.player.conditions = s.player.conditions.filter((c) => c !== 'sanctuary');
    ctx.addLog({ left: `${ctx.playerDef.name}'s Sanctuary fades — attacking breaks the ward.`, style: 'status' });
  }

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

  // SRD Steady Aim (Rogue L3): one-shot Advantage on the next attack;
  // consumed here so a follow-up miss-then-attack doesn't keep the buff.
  const steadyAimAdv = !!s.player.steadyAim;
  if (steadyAimAdv) s.player.steadyAim = false;
  const withAdvantage = playerHidden || hasAttackAdvantage(s.player.conditions) || grantsAdvantageAgainst(target.conditions, dist) || steadyAimAdv;
  // SRD Heavy on a melee weapon (US-111): STR < 13 imposes Disadvantage.
  const heavyMeleeDisadvantage = !isRangedWeapon && !!atk.heavy && ctx.playerDef.str < 13;
  const withDisadvantage = hasAttackDisadvantage(s.player.conditions) || grantsDisadvantageAgainst(target.conditions, dist, s.player.seeInvisible) || rangedDisadvantage || heavyMeleeDisadvantage;
  const autoCrit = isAutoCrit(target.conditions, dist);
  const { bonus: coverBonus, untargetable } = coverBonusVsTarget(ctx, target);
  if (untargetable) {
    ctx.addLog({ left: `${ctx.playerDef.name} has no line of sight — ${target.name} is behind total cover`, style: 'miss' });
    return;
  }
  const sneakAttackAllowed = sneakAttackEligible(ctx, atk, target, withAdvantage, withDisadvantage);
  const params = { withAdvantage, withDisadvantage, autoCrit, playerHidden, coverBonus, sneakAttackAllowed };
  const resolved = playerThrowAttack(
    ctx.playerDef, atk, targetDef, withAdvantage, withDisadvantage, ctx.playerDef.proficiencyBonus, autoCrit, playerHidden, coverBonus, sneakAttackAllowed, attackRollMod(ctx),
  );

  // US-109a — Heroic Inspiration: pause BEFORE any consequence and offer the
  // reroll. The roll is computed but nothing has been applied yet (no damage,
  // no hide clear, no action spend), so `doResolveReroll` can cleanly apply
  // this exact outcome (decline) or re-resolve a fresh roll (accept).
  if (s.player.heroicInspiration) {
    const outcomePreview = resolved.isHit
      ? `HIT — ${resolved.damage} ${atk.damageType}`
      : `MISS (${resolved.attackTotal} vs AC ${targetDef.ac})`;
    s.pendingReroll = {
      kind: 'attack',
      label: `Attack vs ${combatantDisplayName(target, s.npcs)}`,
      rolledNatural: resolved.naturalRoll,
      outcomePreview,
      targetId: target.id,
      params,
      resolved,
    };
    return;
  }

  applyAttackOutcome(ctx, target, targetDef, atk, resolved, events);
}

/**
 * Apply the consequences of a resolved player attack — defensive parry, damage
 * (with resistance), masteries, ammunition recovery, kill, action spend, and
 * Invisibility break. Extracted from `doAttack` so the Heroic Inspiration
 * reroll pause (US-109a) can defer it: `doAttack` runs the irreversible
 * pre-roll setup (ammo spend, advantage flags) and the roll, then either
 * applies this outcome immediately or stashes it on `pendingReroll` for
 * `doResolveReroll` to apply with the original or rerolled result.
 */
function applyAttackOutcome(
  ctx: GameContext,
  target: NpcState,
  targetDef: MonsterDef,
  atk: PlayerAttack,
  resolved: ResolvedPlayerAttack,
  events: GameEvent[],
): void {
  const s = ctx.state;
  const isRangedWeapon = !!atk.rangeNormal && atk.rangeNormal > 0;
  const dist = chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY);
  // SRD Help (US-057): the `helped` Advantage is single-use — consume it once
  // this attack against the target resolves.
  if (target.conditions.includes('helped')) target.conditions = target.conditions.filter((c) => c !== 'helped');
  clearHide(s.player);

  // Defensive reactions (e.g. Noble's Parry): trigger when the NPC was hit by
  // a melee attack roll. If the +AC bump turns the hit into a miss, suppress
  // the resolver's hit log and emit a clean parry-miss line. Crits ignore
  // defensive AC (nat 20 always hits) — match the Shield convention.
  const parry = tryNpcParry(target, targetDef, dist, resolved);
  const { damage, isHit, logs, vexApplied, slowApplied, bonusComponents, sneakAttackFired } = parry.applied
    ? { ...parry.replaced, sneakAttackFired: false }
    : resolved;
  // SRD Sneak Attack: once per turn. Flip the flag only when sneak dice
  // actually landed — a parried hit (turned into a miss by Noble's Parry)
  // means the rider didn't fire, so the rogue can still trigger it later.
  if (sneakAttackFired) s.player.sneakAttackUsedThisTurn = true;
  ctx.addLogs(logs);
  // Ordered attack beat — drives the attacker's lunge before the damage beat
  // the PresentationHooks bridge emits from `damage_dealt`.
  ctx.eventSink?.push({ type: 'attack', attackerId: 'player', targetId: target.id, kind: isRangedWeapon ? 'ranged' : 'melee', outcome: resolved.isCrit ? 'crit' : isHit ? 'hit' : 'miss' });
  emitPhysicalAttackSound(ctx, isHit);

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
    // Goliath Giant Ancestry on-hit boon (Fire's Burn / Frost's Chill /
    // Hill's Tumble) — folds its extra damage / condition in before the single
    // damage publish and the kill check below.
    applyGiantGiftOnHit(ctx, target, targetDef);
    publishNpcDamage(ctx, target, hpBeforeAtk, target.hp);
    ctx.applyMasteryConditions(target, vexApplied, slowApplied);
    // Push / Topple masteries — fire after the damage settles so a hit
    // that drops the target to 0 HP doesn't trigger the rider on a corpse.
    if (target.hp > 0 && atk.push) applyPushMastery(ctx, target);
    if (target.hp > 0 && atk.topple) applyToppleMastery(ctx, target, targetDef);
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

  if (target.hp <= 0) {
    // SRD Knocking Out (US-052): a melee blow that drops the target can spare
    // it — Unconscious + Stable instead of dead — when KNOCK OUT mode is on.
    if (s.player.nonLethal && !isRangedWeapon) ctx.knockOutNpc(target, targetDef);
    else ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
  }

  // SRD Extra Attack (US-119): the first attack of the action commits the
  // Action and reserves the remaining attacks; each follow-up draws the reserve
  // down without spending another Action. When the reserve hits 0 the Attack
  // action is fully spent. Throws (improvised/thrown items) are single attacks
  // and just spend the Action via the reserve-of-0 path.
  if ((s.player.attacksRemaining ?? 0) > 0) {
    s.player.attacksRemaining = (s.player.attacksRemaining ?? 0) - 1;
  } else {
    s.player.actionUsed = true;
    const reserve = Math.max(0, attacksPerAction(ctx.playerDef) - 1);
    s.player.attacksRemaining = reserve;
    if (reserve > 0 && s.phase === 'player_turn') {
      ctx.addLog({ left: `Extra Attack — ${reserve} more attack${reserve > 1 ? 's' : ''} this action`, style: 'status' });
    }
  }

  // SRD Invisibility — if the caster invisibilised themselves and then made
  // this attack roll, the spell ends. Concentration cleanup strips the
  // condition and clears `invisibilityTargetId`.
  if (s.player.concentratingOn === 'invisibility' && s.player.invisibilityTargetId === 'player') {
    endConcentration(ctx, `${ctx.playerDef.name} broke Invisibility by attacking`);
  }
  void events;
}

/**
 * Resolve a pending Heroic Inspiration reroll (US-109a). Decline applies the
 * exact outcome the player saw; accept spends the inspiration, re-resolves the
 * attack fresh (a new d20, honouring the same Advantage/Disadvantage state),
 * and applies that. The deferred attack consequences are applied here.
 */
export function doResolveReroll(ctx: GameContext, accept: boolean, events: GameEvent[]): void {
  const s = ctx.state;
  const p = s.pendingReroll;
  if (!p) return;
  s.pendingReroll = null;
  const target = s.npcs.find((n) => n.id === p.targetId);
  const targetDef = target ? ctx.resolveMonsterDef(target.defId) : null;
  if (!target || !targetDef) return;  // target gone — nothing to apply.
  const atk = ctx.playerDef.mainAttack;

  let resolved: ResolvedPlayerAttack = p.resolved;
  if (accept && s.player.heroicInspiration) {
    s.player.heroicInspiration = false;
    resolved = playerThrowAttack(
      ctx.playerDef, atk, targetDef,
      p.params.withAdvantage, p.params.withDisadvantage, ctx.playerDef.proficiencyBonus,
      p.params.autoCrit, p.params.playerHidden, p.params.coverBonus, p.params.sneakAttackAllowed, attackRollMod(ctx),
    );
    ctx.addLog({ left: `${ctx.playerDef.name} expends Heroic Inspiration to reroll`, right: `d20 ${p.rolledNatural} → ${resolved.naturalRoll}`, style: 'header' });
  }
  applyAttackOutcome(ctx, target, targetDef, atk, resolved, events);
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
    ctx.aggroOnAttack(target);
  }

  const targetDef = ctx.resolveMonsterDef(target.defId);
  if (!targetDef) return events;

  const attack: PlayerAttack = isProperThrown
    ? makePlayerAttack(ctx.playerDef, itemDef as WeaponDef)
    : { name: itemDef.name, statKey: 'str', damageDice: 1, damageSides: 4, damageType: 'bludgeoning', savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false, push: false, topple: false };
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
  // Steady Aim (Rogue L3) also rides a thrown attack — same one-shot
  // consume semantics as the main attack path.
  const steadyAimAdv = !!s.player.steadyAim;
  if (steadyAimAdv) s.player.steadyAim = false;
  const withAdvantage = playerHidden || grantsAdvantageAgainst(target.conditions, dist) || steadyAimAdv;
  const withDisadvantage = dist > normalRange || grantsDisadvantageAgainst(target.conditions, dist, s.player.seeInvisible)
    || hasAttackDisadvantage(s.player.conditions) || adjacentEnemy;
  const autoCrit = isAutoCrit(target.conditions, dist);
  ctx.addLog({ left: `${ctx.playerDef.name} throws ${itemDef.name}`, style: 'normal' });
  const { bonus: coverBonus, untargetable } = coverBonusVsTarget(ctx, target);
  if (untargetable) {
    ctx.addLog({ left: `${target.name} is behind total cover — the ${itemDef.name} can't reach`, style: 'miss' });
    return;
  }
  // SRD Sneak Attack also applies to thrown finesse / ranged weapons (a
  // dagger thrown counts as Ranged for this purpose). Same eligibility
  // gates as the melee path.
  const sneakAttackAllowed = sneakAttackEligible(ctx, attack, target, withAdvantage, withDisadvantage);
  const { damage, isHit, logs, vexApplied, slowApplied, bonusComponents, sneakAttackFired } = playerThrowAttack(
    ctx.playerDef, attack, targetDef, withAdvantage, withDisadvantage, profBonus, autoCrit, playerHidden, coverBonus, sneakAttackAllowed, attackRollMod(ctx),
  );
  if (sneakAttackFired) s.player.sneakAttackUsedThisTurn = true;
  clearHide(s.player);
  ctx.addLogs(logs);
  emitPhysicalAttackSound(ctx, isHit);

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
  if (isHit) applyGiantGiftOnHit(ctx, target, targetDef);
  publishNpcDamage(ctx, target, hpBeforeThr, target.hp);
  ctx.applyMasteryConditions(target, vexApplied, slowApplied);
  if (isHit && target.hp > 0 && attack.push)   applyPushMastery(ctx, target);
  if (isHit && target.hp > 0 && attack.topple) applyToppleMastery(ctx, target, targetDef);
  if (target.hp <= 0) ctx.killWithReward(target, targetDef, `☠ ${target.name} is slain!`);
}

export function doHide(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanHide(ctx)) return;
  // SRD Hide gate: the player must be Heavily Obscured OR behind
  // Three-Quarters / Total Cover against at least one observer, AND must be
  // outside every enemy's line of sight. Vision module checks both at once.
  if (!canTakeHideAction(ctx)) {
    ctx.addLog({ left: `${ctx.playerDef.name} has no cover or obscurance — cannot hide here`, style: 'miss' });
    return;
  }
  const { hidden, dc, logs } = playerHide(ctx.playerDef, playerHasStealthDisadvantage(ctx));
  if (hidden) {
    // SRD: on a successful Hide the creature gains the Invisible condition
    // (Adv on Initiative, Adv on attacks, attacks vs you have Disadv,
    // concealed from "must be seen" effects). The Stealth total becomes
    // the per-observer Perception DC. Both flags are tracked together so
    // `clearHide` can strip them as a unit on a break trigger.
    if (!s.player.conditions.includes('hidden')) s.player.conditions.push('hidden');
    if (!s.player.conditions.includes('invisible')) s.player.conditions.push('invisible');
    s.player.hideDC = dc;
  } else {
    clearHide(s.player);
  }
  ctx.addLogs(logs);
  // Action economy only applies in combat. During exploring, hiding is free —
  // it's the Sneak Attack opener that triggers combat with Advantage.
  if (s.phase === 'player_turn') spendCunningOrAction(ctx);
}

/**
 * Decide whether the player has somewhere to hide. SRD: Heavily Obscured tile
 * counts; Three-Quarters / Total cover relative to every potential observer
 * counts; out-of-sight for every observer counts. We accept the action when
 * NO observer currently sees the player AND (the player's tile is Heavily
 * Obscured OR every observer has ≥ Three-Quarters cover from them).
 */
function canTakeHideAction(ctx: GameContext): boolean {
  const s = ctx.state;
  const onTileObs = s.map.obscurance?.[s.player.tileY]?.[s.player.tileX] ?? null;
  if (onTileObs === 'heavily') return true;
  const observers = s.npcs.filter((n) =>
    n.disposition !== 'ally'
    && n.hp > 0
    && !n.conditions.includes('incapacitated')
    && !n.conditions.includes('unconscious'),
  );
  if (observers.length === 0) return true;  // no one to hide from
  for (const npc of observers) {
    const def = ctx.resolveMonsterDef(npc.defId);
    const vision = visCanSee(
      s,
      { tileX: npc.tileX, tileY: npc.tileY, senses: def?.senses },
      { tileX: s.player.tileX, tileY: s.player.tileY, conditions: s.player.conditions, id: 'player' },
    );
    if (vision.sees) {
      // The observer sees us — gating SRD: we need ≥ 3/4 cover to take Hide
      // even with LOS. `none` and `half` are insufficient.
      if (vision.cover !== 'three-quarters' && vision.cover !== 'total') return false;
    }
  }
  return true;
}

// ── Unarmed Strike options: Shove (US-050) & Grapple (US-110) ───────────────
// Both are SRD Unarmed Strike options costing the Action: the target makes a
// Strength OR Dexterity saving throw (its choice — we take the better mod)
// against DC 8 + the player's STR modifier + Proficiency Bonus, and may be no
// more than one size larger than the player (US-107 size gate).

/** SRD Unarmed Strike save DC for Grapple/Shove: 8 + STR mod + PB. */
function unarmedStrikeDC(ctx: GameContext): number {
  return 8 + mod(ctx.playerDef.str) + ctx.playerDef.proficiencyBonus;
}

/** The better of the target's STR / DEX save mod — the SRD lets it choose. */
function bestStrDexSaveMod(def: MonsterDef): number {
  const strMod = def.savingThrows?.['str'] ?? mod(def.str);
  const dexMod = def.savingThrows?.['dex'] ?? mod(def.dex);
  return Math.max(strMod, dexMod);
}

/** Target no more than one size larger than the player (US-107 gate). */
export function withinShoveGrappleSize(playerSize: string | undefined, targetSize: string | undefined): boolean {
  return sizeRank((targetSize ?? 'medium') as never) - sizeRank((playerSize ?? 'medium') as never) <= 1;
}

/** Adjacent, living, hostile, size-eligible Unarmed-Strike target (explicit id
 *  first, else the nearest qualifying enemy). */
function resolveUnarmedTarget(ctx: GameContext, targetId: string | undefined): NpcState | null {
  const s = ctx.state;
  const ok = (n: NpcState) => n.disposition === 'enemy' && n.hp > 0
    && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= 1
    && withinShoveGrappleSize(ctx.state.player.buffSize ?? ctx.playerDef.size, n.size);
  if (targetId) {
    const t = s.npcs.find((n) => n.id === targetId && ok(n));
    if (t) return t;
  }
  return s.npcs.find(ok) ?? null;
}

export function doShove(ctx: GameContext, targetId: string | undefined, effect: 'push' | 'prone' = 'push'): void {
  const s = ctx.state;
  if (!canSpendAction(ctx)) return;
  const target = resolveUnarmedTarget(ctx, targetId);
  if (!target) return;
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return;
  const dc = unarmedStrikeDC(ctx);
  const saveMod = bestStrDexSaveMod(def);
  const roll = d20();
  const total = roll + saveMod;
  const right = `save d20(${roll})+${saveMod}=${total} vs DC ${dc}`;
  const label = combatantDisplayName(target, s.npcs);
  if (total >= dc) {
    ctx.addLog({ left: `${ctx.playerDef.name} tries to shove ${label} — it holds firm`, right, style: 'normal' });
  } else if (effect === 'prone') {
    if (!target.conditions.includes('prone')) target.conditions.push('prone');
    ctx.addLog({ left: `${ctx.playerDef.name} shoves ${label} to the ground — Prone`, right, style: 'status' });
  } else {
    const moved = pushAway(ctx, target, 1);  // Shove = 5 ft = 1 tile.
    ctx.addLog({ left: `${ctx.playerDef.name} shoves ${label} ${moved * 5} ft back`, right, style: 'status' });
  }
  s.player.actionUsed = true;
}

export function doGrapple(ctx: GameContext, targetId: string | undefined): void {
  const s = ctx.state;
  if (!canSpendAction(ctx)) return;
  const target = resolveUnarmedTarget(ctx, targetId);
  if (!target || target.conditions.includes('grappled')) return;
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return;
  const dc = unarmedStrikeDC(ctx);
  const saveMod = bestStrDexSaveMod(def);
  const roll = d20();
  const total = roll + saveMod;
  const right = `save d20(${roll})+${saveMod}=${total} vs DC ${dc}`;
  const label = combatantDisplayName(target, s.npcs);
  if (total >= dc) {
    ctx.addLog({ left: `${ctx.playerDef.name} tries to grapple ${label} — it breaks free`, right, style: 'normal' });
  } else {
    target.conditions.push('grappled');  // Speed 0 via ConditionSystem.
    ctx.addLog({ left: `${ctx.playerDef.name} grapples ${label} — Speed 0`, right, style: 'status' });
  }
  s.player.actionUsed = true;
}

/**
 * SRD Help — Assist an Attack (US-057): spend the Action to distract an enemy
 * within 5 ft; the next attack against it (by the player or an ally) has
 * Advantage. Modelled as the `helped` marker (consumed by the benefiting
 * attack). Requires a living ally to benefit. Other Help modes (assist an
 * ability check / stabilize a dying creature) are separate follow-ups.
 */
export function doHelp(ctx: GameContext, targetId: string | undefined): void {
  const s = ctx.state;
  if (!canSpendAction(ctx)) return;
  const adj = (n: NpcState) => n.disposition === 'enemy' && n.hp > 0
    && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= 1;
  const target = (targetId ? s.npcs.find((n) => n.id === targetId && adj(n)) : null) ?? s.npcs.find(adj) ?? null;
  if (!target) return;
  const hasAlly = s.npcs.some((n) => n.disposition === 'ally' && n.hp > 0 && !isIncapacitated(n.conditions));
  if (!hasAlly) {
    ctx.addLog({ left: `${ctx.playerDef.name} has no ally to assist.`, style: 'miss' });
    return;
  }
  if (!target.conditions.includes('helped')) target.conditions.push('helped');
  ctx.addLog({ left: `${ctx.playerDef.name} distracts ${combatantDisplayName(target, s.npcs)} — an ally's next attack has Advantage`, style: 'status' });
  s.player.actionUsed = true;
}

/**
 * SRD Ready (US-057): reserve your Reaction for a melee attack against the
 * first enemy that moves into your reach this round. Spends the Action now; the
 * strike fires through the reaction prompt when an enemy enters reach (see
 * `runSingleEnemyTurn`). The reservation is cleared when it fires or at the
 * start of your next turn.
 */
export function doReady(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase !== 'player_turn' || !canSpendAction(ctx)) return;
  if (s.player.reactionUsed) { ctx.addLog({ left: `No Reaction available to ready an attack.`, style: 'miss' }); return; }
  s.player.readiedAttack = true;
  s.player.actionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} readies an attack — will strike the next enemy that closes in.`, style: 'status' });
}

export function doDash(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanDash(ctx)) return;
  // Dash grants extra movement equal to Speed — apply the same exhaustion and
  // armor-Strength (US-111) reductions as the turn-start speed.
  const dashFt = Math.max(0, speedAfterExhaustion(ctx.playerDef.speed, s.player.exhaustionLevel ?? 0) - playerArmorSpeedPenaltyFt(ctx));
  s.player.movesLeft += dashFt / 5;
  s.player.conditions.push('dashing');
  spendCunningOrAction(ctx);
  ctx.addLog({ left: `${ctx.playerDef.name} Dashes — +${dashFt / 5} tiles movement`, style: 'status' });
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
  spendCunningOrAction(ctx);
  ctx.addLog({ left: `${ctx.playerDef.name} Disengages — no Opportunity Attacks this turn`, style: 'status' });
}

/**
 * Helper for SRD Cunning Action: prefer spending the Bonus Action when the
 * character has Cunning Action (L2+ Rogue) and a Bonus Action is still free
 * — that's the strictly better economy. Otherwise fall back to the Action.
 */
function spendCunningOrAction(ctx: GameContext): void {
  const s = ctx.state;
  if (hasCunningAction(ctx) && !s.player.bonusActionUsed) {
    s.player.bonusActionUsed = true;
  } else {
    s.player.actionUsed = true;
  }
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
  // The OA inherits the same Advantage/Disadvantage sources as a normal
  // attack — Blinded, Poisoned, Frightened, etc. on the attacker impose
  // Disadvantage; player Dodging stacks on top.
  const withDisadvantage = s.player.conditions.includes('dodging') || hasAttackDisadvantage(npc.conditions);
  const withAdvantage = hasAttackAdvantage(npc.conditions);
  const playerCoverAc = playerCoverAcVsNpc(ctx, npc);
  const { damage, isHit, isCrit, logs, bonusComponents } = enemyAttack(meleeAtk, ctx.playerDef.ac, withAdvantage, withDisadvantage, playerCoverAc);
  ctx.addLogs([{ left: `⚡ ${npc.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
  emitPhysicalAttackSound(ctx, isHit);
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
  const { bonus: oaCoverBonus } = coverBonusVsTarget(ctx, npc);
  // Player OA picks up the same Adv/Disadv sources as a normal attack —
  // Blinded / Poisoned / Frightened impose Disadvantage on the attacker;
  // grants-Advantage target conditions (Prone-at-melee-range etc.) bring
  // Advantage.
  const oaWithAdvantage = hasAttackAdvantage(s.player.conditions);
  const oaWithDisadvantage = hasAttackDisadvantage(s.player.conditions);
  const { damage, isHit: oaIsHit, logs, vexApplied, slowApplied, bonusComponents } = playerMeleeAttack(ctx.playerDef, targetDef, oaWithAdvantage, oaWithDisadvantage, oaAutoCrit, false, oaCoverBonus, false, attackRollMod(ctx));
  ctx.addLogs([{ left: `⚡ ${ctx.playerDef.name} makes an Opportunity Attack!`, style: 'header' }, ...logs]);
  emitPhysicalAttackSound(ctx, oaIsHit);
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
  const withDisadvantage = targetDodging
    || (target.conditions.includes('prone') && dist > 1)
    || hasAttackDisadvantage(attacker.conditions);
  const withAdvantage = (target.conditions.includes('prone') && dist <= 1)
    || hasAttackAdvantage(attacker.conditions);
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
