/**
 * NpcSpellcasting — stat-block spellcasting for monsters (US-117,
 * mage-monster-plan.md slices 4–5).
 *
 * A focused executor for the spell shapes SRD stat blocks need — NOT a
 * caster-agnostic refactor of the player `SpellSystem` (see plan Decision A).
 * Reads the same `server/data/spells/*.json` defs the player path does, so
 * dice / areas / save types have one source of truth, and reuses the
 * origin-agnostic geometry primitives from `SpellGeometry`.
 *
 * Shapes supported:
 *   • AoE damage   — Fireball (placed sphere), Cone of Cold (self-origin cone):
 *     one damage roll, per-creature saves (NPCs via `npcSaveMod`, the player
 *     via `playerSaveVsDc` below — including the SRD Cover bonus to DEX
 *     saves, closing the US-113 deferral).
 *   • Teleport     — Misty Step: bonus-action reposition away from adjacency.
 *   • Self-buff    — Invisibility (concentration, breaks on attack),
 *     Fly (simplified: +30 ft speed — the engine has no elevation model).
 *
 * Limited uses live on `NpcState.spellUses` (seeded at spawn, per-spawn pools,
 * persisted on the world save). Concentration lives on
 * `NpcState.concentratingOn`; `breakNpcConcentrationOnDamage` rolls the SRD
 * CON save when the caster takes damage and strips the buff on a failure.
 */
import type { GameContext } from './GameContext.js';
import type { NpcState, MonsterDef, SpellDef, GameEvent } from './types.js';
import { coneTileSet, placedSphereTiles, sphereRadiusTiles } from './SpellGeometry.js';
import { npcSaveMod } from './CombatSystem.js';
import { canSee as visCanSee } from './Vision.js';
import { isHostileTo } from './FactionRelations.js';
import { chebyshev } from './EnemyAI.js';
import { d20, d, mod, rollAdvantage } from './Dice.js';
import { hasAdvantageOn } from './Modifiers.js';
import { isIncapacitated } from './ConditionSystem.js';

import { Logger } from '../Logger.js';
import { combatantDisplayName } from './DisplayNames.js';
import { dropNpcConcentration } from './NpcConcentration.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { PLAYER_FACTION_ID, PLAYER_ID } from '../../../shared/types.js';

/** The player counts double when scoring an AoE template — the stat-block
 *  caster prioritises the real threat over CR-0 chaff (plan Decision D). */
const PLAYER_THREAT_WEIGHT = 2;
/** Minimum template score before a per-day slot is worth spending: the
 *  player alone qualifies; two chaff qualify; one chaff doesn't. */
const MIN_AOE_SCORE = 2;

interface AoeTemplate {
  spellId: string;
  spell: SpellDef;
  castLevel: number;
  tiles: Set<string>;
  /** Origin used for VFX and for the player's save-cover line. */
  originX: number;
  originY: number;
  score: number;
  hitsPlayer: boolean;
  npcTargets: NpcState[];
}

/** Remaining uses for one of the caster's limited spells. */
function usesLeft(npc: NpcState, spellId: string): number {
  return npc.spellUses?.[spellId] ?? 0;
}

function spendUse(npc: NpcState, spellId: string): void {
  npc.spellUses = { ...npc.spellUses, [spellId]: Math.max(0, usesLeft(npc, spellId) - 1) };
}

/**
 * SRD Cover bonus to a Dexterity saving throw (US-113 closeout): +2 behind
 * half cover, +5 behind three-quarters cover, measured from the effect's
 * point of origin to the player.
 */
function playerSaveCoverBonus(
  ctx: GameContext,
  saveAbility: string,
  originX: number,
  originY: number,
): number {
  if (saveAbility !== 'dex') return 0;
  const vision = visCanSee(
    ctx.state,
    { tileX: originX, tileY: originY, senses: {} },
    { tileX: ctx.state.player.tileX, tileY: ctx.state.player.tileY, conditions: ctx.state.player.conditions, id: PLAYER_ID },
  );
  return vision.cover === 'three-quarters' ? 5 : vision.cover === 'half' ? 2 : 0;
}

/**
 * Roll the player's saving throw against an NPC-cast effect and apply the
 * damage. Mirrors the player-cast `rollPlayerSaveAndDamage`, with the DC
 * supplied by the monster's stat block and the Cover bonus added on DEX.
 */
export function playerSaveVsDc(
  ctx: GameContext,
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
  dc: number,
  rawDamage: number,
  damageType: string,
  halfOnSuccess: boolean,
  events: GameEvent[],
  coverBonus = 0,
): void {
  const abMod = mod(ctx.playerDef[saveAbility]);
  const profBonus = ctx.playerDef.savingThrowProficiencies.includes(saveAbility)
    ? ctx.playerDef.proficiencyBonus
    : 0;
  const saveBonus = abMod + profBonus + coverBonus;
  const adv = hasAdvantageOn(ctx.playerDef, 'save', saveAbility);
  const rolled = adv ? rollAdvantage() : null;
  const roll = rolled ? rolled.result : d20();
  const rollLabel = rolled ? `${rolled.rolls[0]},${rolled.rolls[1]}→${roll} [ADV]` : `${roll}`;
  const total = roll + saveBonus;
  const success = total >= dc;
  const dmg = success ? (halfOnSuccess ? Math.floor(rawDamage / 2) : 0) : rawDamage;
  const coverNote = coverBonus > 0 ? ` (+${coverBonus} cover)` : '';
  ctx.addLog({
    left: `${ctx.playerDef.name} ${success ? 'saves' : 'fails'} — ${dmg} ${damageType}`,
    right: `${saveAbility.toUpperCase()} d20(${rollLabel})+${saveBonus}=${total}${coverNote} vs DC ${dc}`,
    style: success ? 'normal' : 'hit',
  });
  if (dmg > 0) ctx.applyDamageToPlayer(dmg, events, damageType);
}

/** Roll an NPC's save vs the caster's DC and apply area damage (resistances
 *  honoured; kills route through `ctx.killNpc` — no player kill reward for a
 *  monster's own carnage). */
function npcSaveVsAreaDamage(
  ctx: GameContext,
  target: NpcState,
  saveAbility: string,
  dc: number,
  rawDamage: number,
  damageType: string,
  halfOnSuccess: boolean,
): void {
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return;
  const saveBonus = npcSaveMod(target, def, saveAbility);
  const roll = d20();
  const total = roll + saveBonus;
  const success = total >= dc;
  const dmg = success ? (halfOnSuccess ? Math.floor(rawDamage / 2) : 0) : rawDamage;
  const { finalDamage, log: resistLog } = ctx.resistMod(dmg, damageType, def, target.name);
  ctx.addLog({
    left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'saves' : 'fails'} — ${finalDamage} ${damageType}`,
    right: `${saveAbility.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
    style: success ? 'normal' : 'hit',
  });
  if (resistLog) ctx.addLog(resistLog);
  if (finalDamage <= 0) return;
  const hpBefore = target.hp;
  const tempAbsorb = Math.min(target.tempHp ?? 0, finalDamage);
  if (tempAbsorb > 0) target.tempHp = (target.tempHp ?? 0) - tempAbsorb;
  target.hp = Math.max(0, target.hp - (finalDamage - tempAbsorb));
  publishNpcDamage(ctx, target, hpBefore, target.hp);
  ctx.eventSink?.push({ type: 'damage', entityId: target.id, amount: finalDamage, newHp: target.hp });
  if (target.hp <= 0) {
    ctx.addLog({ left: `☠ ${combatantDisplayName(target, ctx.state.npcs)} is slain!`, style: 'kill' });
    ctx.eventSink?.push({ type: 'death', entityId: target.id });
    ctx.killNpc(target.id);
  }
}

/** Every living creature this caster considers hostile, as scoring views. */
function hostileViewsFor(ctx: GameContext, caster: NpcState): { npcs: NpcState[]; playerHostile: boolean } {
  const s = ctx.state;
  const casterView = { id: caster.id, factionId: caster.factionId };
  const playerHostile = isHostileTo(s, casterView, { id: PLAYER_ID, factionId: PLAYER_FACTION_ID });
  const npcs = s.npcs.filter((n) =>
    n !== caster && n.hp > 0
    && !n.conditions.includes('hidden')
    && isHostileTo(s, casterView, { id: n.id, factionId: n.factionId }));
  return { npcs, playerHostile };
}

/** Friendlies (incl. self) the AoE must not touch. */
function friendlyTilesFor(ctx: GameContext, caster: NpcState, hostiles: NpcState[]): Set<string> {
  const hostileIds = new Set(hostiles.map((n) => n.id));
  const out = new Set<string>([`${caster.tileX},${caster.tileY}`]);
  for (const n of ctx.state.npcs) {
    if (n.hp <= 0 || n === caster || hostileIds.has(n.id)) continue;
    out.add(`${n.tileX},${n.tileY}`);
  }
  return out;
}

/** SRD: a creature behind TOTAL cover from the effect's point of origin is
 *  not affected by the AoE at all. */
function originReaches(ctx: GameContext, ox: number, oy: number, tx: number, ty: number): boolean {
  const vision = visCanSee(
    ctx.state,
    { tileX: ox, tileY: oy, senses: {} },
    { tileX: tx, tileY: ty, conditions: [], id: `aoe:${tx},${ty}` },
  );
  return vision.cover !== 'total';
}

function scoreTemplate(
  ctx: GameContext,
  origin: { x: number; y: number },
  tiles: Set<string>,
  hostiles: NpcState[],
  playerHostile: boolean,
  friendlyTiles: Set<string>,
): { score: number; hitsPlayer: boolean; npcTargets: NpcState[] } | null {
  for (const t of tiles) if (friendlyTiles.has(t)) return null; // friendly fire — discard
  const npcTargets = hostiles.filter((n) =>
    tiles.has(`${n.tileX},${n.tileY}`) && originReaches(ctx, origin.x, origin.y, n.tileX, n.tileY));
  const p = ctx.state.player;
  const hitsPlayer = playerHostile
    && tiles.has(`${p.tileX},${p.tileY}`)
    && originReaches(ctx, origin.x, origin.y, p.tileX, p.tileY);
  const score = npcTargets.length + (hitsPlayer ? PLAYER_THREAT_WEIGHT : 0);
  return { score, hitsPlayer, npcTargets };
}

/** Find the best AoE cast available to this NPC right now, or null. */
function bestAoeTemplate(ctx: GameContext, caster: NpcState, def: MonsterDef): AoeTemplate | null {
  const sc = def.spellcasting;
  if (!sc?.perDay) return null;
  const { npcs: hostiles, playerHostile } = hostileViewsFor(ctx, caster);
  if (hostiles.length === 0 && !playerHostile) return null;
  const friendlyTiles = friendlyTilesFor(ctx, caster, hostiles);
  const anchors: Array<{ x: number; y: number }> = [
    ...(playerHostile ? [{ x: ctx.state.player.tileX, y: ctx.state.player.tileY }] : []),
    ...hostiles.map((n) => ({ x: n.tileX, y: n.tileY })),
  ];

  let best: AoeTemplate | null = null;
  for (const entry of sc.perDay) {
    if (usesLeft(caster, entry.spellId) <= 0) continue;
    const spell = ctx.defs.spells.find((sp) => sp.id === entry.spellId);
    if (!spell?.damage || !spell.save || !spell.area) continue; // offensive AoE only

    if (spell.area.shape === 'sphere') {
      const r = sphereRadiusTiles(spell);
      const rangeTiles = Math.max(1, Math.floor((spell.rangeFeet ?? 0) / 5));
      for (const a of anchors) {
        if (chebyshev(caster.tileX, caster.tileY, a.x, a.y) > rangeTiles) continue;
        // SRD: the caster must SEE the point of origin.
        if (!originReaches(ctx, caster.tileX, caster.tileY, a.x, a.y)) continue;
        const tiles = placedSphereTiles(a.x, a.y, r);
        const scored = scoreTemplate(ctx, a, tiles, hostiles, playerHostile, friendlyTiles);
        if (!scored || scored.score < MIN_AOE_SCORE) continue;
        if (!best || scored.score > best.score) {
          best = { spellId: entry.spellId, spell, castLevel: entry.castLevel ?? spell.level, tiles, originX: a.x, originY: a.y, ...scored };
        }
      }
    } else if (spell.area.shape === 'cone') {
      const radiusTiles = Math.max(1, Math.ceil(spell.area.sizeFeet / 5));
      const origin = { x: caster.tileX, y: caster.tileY };
      for (const a of anchors) {
        const tiles = coneTileSet(caster.tileX, caster.tileY, a.x, a.y, radiusTiles);
        const scored = scoreTemplate(ctx, origin, tiles, hostiles, playerHostile, friendlyTiles);
        if (!scored || scored.score < MIN_AOE_SCORE) continue;
        if (!best || scored.score > best.score) {
          best = { spellId: entry.spellId, spell, castLevel: entry.castLevel ?? spell.level, tiles, originX: caster.tileX, originY: caster.tileY, ...scored };
        }
      }
    }
  }
  return best;
}

/**
 * Try to spend this NPC's Action on its best offensive AoE. Returns true when
 * a spell was cast (the turn runner then skips the weapon attack).
 */
export function tryNpcOffensiveSpell(
  ctx: GameContext,
  caster: NpcState,
  def: MonsterDef,
  events: GameEvent[],
): boolean {
  const sc = def.spellcasting;
  if (!sc) return false;
  const pick = bestAoeTemplate(ctx, caster, def);
  if (!pick) return false;

  spendUse(caster, pick.spellId);
  Logger.log('ai.spell_pick', {
    casterId: caster.id, defId: caster.defId, spellId: pick.spellId,
    castLevel: pick.castLevel, score: pick.score, hitsPlayer: pick.hitsPlayer,
    npcTargets: pick.npcTargets.map((n) => n.id), usesLeft: usesLeft(caster, pick.spellId),
  });

  const name = combatantDisplayName(caster, ctx.state.npcs);
  const levelNote = pick.castLevel > pick.spell.level ? ` (level ${pick.castLevel})` : '';
  ctx.addLog({ left: `${name} casts ${pick.spell.name}${levelNote}!`, style: 'header' });
  events.push({
    type: 'spell_vfx', style: 'area-burst', palette: pick.spell.vfx?.palette ?? 'arcane',
    fromId: caster.id, toX: pick.originX, toY: pick.originY,
    shape: pick.spell.area!.shape as 'sphere' | 'cone',
    radiusFeet: pick.spell.area!.sizeFeet,
  });
  events.push({ type: 'sound_ring', x: pick.originX, y: pick.originY, intensity: 8 });

  // One damage roll for every creature in the area (SRD), upcast scaling at
  // +1 die per slot level above the spell's base (Fireball, Cone of Cold).
  const dmg = pick.spell.damage!;
  const dice = dmg.dice + Math.max(0, pick.castLevel - pick.spell.level);
  let raw = 0;
  for (let i = 0; i < dice; i++) raw += d(dmg.sides);
  ctx.addLog({ left: `${dice}d${dmg.sides} ${dmg.type}`, right: `${raw} damage`, style: 'status' });

  const save = pick.spell.save!;
  for (const target of pick.npcTargets) {
    npcSaveVsAreaDamage(ctx, target, save.ability, sc.saveDC, raw, dmg.type, save.halfOnSuccess);
  }
  if (pick.hitsPlayer) {
    const cover = playerSaveCoverBonus(ctx, save.ability, pick.originX, pick.originY);
    playerSaveVsDc(ctx, save.ability as 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
      sc.saveDC, raw, dmg.type, save.halfOnSuccess, events, cover);
  }
  return true;
}

/**
 * Bonus-action Misty Step (slice 5): when bloodied with a hostile adjacent,
 * teleport up to the spell's range to the free tile that maximises distance
 * from the nearest hostile. Returns true when the teleport happened — the
 * turn runner continues with the Action (cast-then-blast, like the SRD mage).
 */
export function tryNpcBonusTeleport(
  ctx: GameContext,
  caster: NpcState,
  def: MonsterDef,
  events: GameEvent[],
): boolean {
  const sc = def.spellcasting;
  const entry = sc?.bonusAction?.find((e) => {
    const sp = ctx.defs.spells.find((d2) => d2.id === e.spellId);
    return sp?.selfTeleport && usesLeft(caster, e.spellId) > 0;
  });
  if (!sc || !entry) return false;
  const spell = ctx.defs.spells.find((sp) => sp.id === entry.spellId)!;

  const { npcs: hostiles, playerHostile } = hostileViewsFor(ctx, caster);
  const threats = [
    ...(playerHostile ? [{ tileX: ctx.state.player.tileX, tileY: ctx.state.player.tileY }] : []),
    ...hostiles,
  ];
  if (threats.length === 0) return false;
  const nearestDist = Math.min(...threats.map((t) => chebyshev(caster.tileX, caster.tileY, t.tileX, t.tileY)));
  const bloodied = caster.hp <= caster.maxHp / 2;
  if (!(bloodied && nearestDist <= 1)) return false; // only as an escape valve

  const rangeTiles = Math.max(1, Math.floor((spell.selfTeleport!.rangeFeet) / 5));
  const s = ctx.state;
  const occupied = (x: number, y: number) =>
    (s.player.tileX === x && s.player.tileY === y)
    || s.npcs.some((n) => n !== caster && n.hp > 0 && n.tileX === x && n.tileY === y);
  let best: { x: number; y: number; dist: number } | null = null;
  for (let dy = -rangeTiles; dy <= rangeTiles; dy++) {
    for (let dx = -rangeTiles; dx <= rangeTiles; dx++) {
      const x = caster.tileX + dx, y = caster.tileY + dy;
      if (x < 0 || y < 0 || x >= s.map.cols || y >= s.map.rows) continue;
      if (s.map.blocksMovement[y][x] || occupied(x, y)) continue;
      const dist = Math.min(...threats.map((t) => chebyshev(x, y, t.tileX, t.tileY)));
      if (!best || dist > best.dist) best = { x, y, dist };
    }
  }
  if (!best || best.dist <= nearestDist) return false;

  spendUse(caster, entry.spellId);
  const name = combatantDisplayName(caster, s.npcs);
  ctx.addLog({ left: `${name} casts ${spell.name} — silvery mist, and they are elsewhere (${usesLeft(caster, entry.spellId)} left)`, style: 'status' });
  events.push({ type: 'spell_vfx', style: 'vanish', palette: spell.vfx?.palette ?? 'arcane', fromId: caster.id });
  caster.tileX = best.x;
  caster.tileY = best.y;
  events.push({ type: 'entity_move', entityId: caster.id, toX: best.x, toY: best.y });
  Logger.log('ai.spell_pick', { casterId: caster.id, defId: caster.defId, spellId: entry.spellId, kind: 'teleport', to: `${best.x},${best.y}` });
  return true;
}

/**
 * Self-buff casting (slice 5): Invisibility when surrounded, Fly as a speed
 * boost when the nearest hostile is far. One concentration at a time —
 * casting a new concentration spell drops the old one. Returns true when a
 * buff was cast (consumes the Action).
 */
export function tryNpcSelfBuff(
  ctx: GameContext,
  caster: NpcState,
  def: MonsterDef,
  events: GameEvent[],
): boolean {
  const sc = def.spellcasting;
  if (!sc?.perDay) return false;
  const { npcs: hostiles, playerHostile } = hostileViewsFor(ctx, caster);
  const threats = [
    ...(playerHostile ? [{ tileX: ctx.state.player.tileX, tileY: ctx.state.player.tileY }] : []),
    ...hostiles,
  ];
  if (threats.length === 0) return false;
  const adjacentThreats = threats.filter((t) => chebyshev(caster.tileX, caster.tileY, t.tileX, t.tileY) <= 1).length;
  const name = combatantDisplayName(caster, ctx.state.npcs);

  // Invisibility — surrounded (≥3 adjacent) and bloodied: vanish.
  const invis = sc.perDay.find((e) => e.spellId === 'invisibility');
  if (invis && usesLeft(caster, 'invisibility') > 0
      && !caster.conditions.includes('invisible')
      && adjacentThreats >= 3 && caster.hp <= caster.maxHp / 2) {
    dropNpcConcentration(ctx, caster);
    spendUse(caster, 'invisibility');
    caster.concentratingOn = 'invisibility';
    caster.conditions.push('invisible');
    ctx.addLog({ left: `${name} casts Invisibility — and is gone from sight`, style: 'header' });
    events.push({ type: 'spell_vfx', style: 'vanish', palette: 'illusion', fromId: caster.id });
    Logger.log('ai.spell_pick', { casterId: caster.id, defId: caster.defId, spellId: 'invisibility', kind: 'self-buff' });
    return true;
  }

  // Fly — simplified to +30 ft of speed (no elevation model): cast when the
  // nearest threat is far and worth closing on (or escaping from) fast.
  const fly = sc.perDay.find((e) => e.spellId === 'fly');
  const nearestDist = Math.min(...threats.map((t) => chebyshev(caster.tileX, caster.tileY, t.tileX, t.tileY)));
  if (fly && usesLeft(caster, 'fly') > 0 && !caster.flying && nearestDist >= 10) {
    dropNpcConcentration(ctx, caster);
    spendUse(caster, 'fly');
    caster.concentratingOn = 'fly';
    caster.flying = true;
    ctx.addLog({ left: `${name} casts Fly — rising on conjured wind`, style: 'header' });
    events.push({ type: 'spell_vfx', style: 'self-glow', palette: 'arcane', fromId: caster.id });
    Logger.log('ai.spell_pick', { casterId: caster.id, defId: caster.defId, spellId: 'fly', kind: 'self-buff' });
    return true;
  }
  return false;
}

/** An attack made by an invisible self-cast NPC ends its own Invisibility
 *  (SRD: the spell ends when the subject attacks or casts). */
export function breakNpcSelfInvisibilityOnAttack(ctx: GameContext, npc: NpcState): void {
  if (npc.concentratingOn === 'invisibility') dropNpcConcentration(ctx, npc);
}

// ── Protective Magic (US-117, slice 6) ──────────────────────────────────────

/** True when this NPC can spend a Protective Magic reaction right now. */
function canSpendProtectiveMagic(npc: NpcState, def: MonsterDef): boolean {
  if (npc.hp <= 0 || npc.reactionUsed) return false;
  if (isIncapacitated(npc.conditions)) return false;
  if (!(def.reactions ?? []).some((r) => r.kind === 'protective-magic')) return false;
  return (npc.reactionUses?.['protective-magic'] ?? 0) > 0;
}

function spendProtectiveMagic(npc: NpcState): number {
  const left = (npc.reactionUses?.['protective-magic'] ?? 0) - 1;
  npc.reactionUsed = true;
  npc.reactionUses = { ...npc.reactionUses, 'protective-magic': Math.max(0, left) };
  return Math.max(0, left);
}

/**
 * Shield cast in reaction to a SPELL attack roll that would hit (the weapon
 * path runs through `CombatActions.tryNpcParry`). Applies the persistent
 * `shielded` condition and reports whether the +5 turns this hit into a miss.
 */
export function tryNpcShieldVsSpellAttack(
  ctx: GameContext,
  target: NpcState,
  def: MonsterDef,
  attackTotal: number,
  effectiveAc: number,
  isCrit: boolean,
): { deflected: boolean } {
  if (isCrit || !canSpendProtectiveMagic(target, def)) return { deflected: false };
  const left = spendProtectiveMagic(target);
  if (!target.conditions.includes('shielded')) target.conditions.push('shielded');
  const newAc = effectiveAc + 5;
  const deflected = attackTotal < newAc;
  const name = combatantDisplayName(target, ctx.state.npcs);
  ctx.addLog(deflected
    ? { left: `${name} casts Shield — +5 AC turns the spell aside (Protective Magic ${left} left)`, right: `vs AC ${newAc}`, style: 'miss' }
    : { left: `${name} casts Shield — +5 AC, but the spell strikes home (Protective Magic ${left} left)`, style: 'status' });
  return { deflected };
}

/**
 * SRD 5.2.1 Counterspell, NPC side: when the player casts a spell with V/S/M
 * components within 60 ft of a hostile caster that can see them and has a
 * Protective Magic use left, the caster reacts. The PLAYER makes a CON save
 * vs the monster's spell save DC; on a failure the spell dissipates — the
 * caller wastes the action but must NOT expend the slot. Returns true when
 * the cast was countered.
 */
export function tryNpcCounterspell(ctx: GameContext, spell: SpellDef, _events: GameEvent[]): boolean {
  const comp = spell.components;
  if (!comp?.verbal && !comp?.somatic && !comp?.material) return false;
  const s = ctx.state;
  const playerView = { id: PLAYER_ID, factionId: PLAYER_FACTION_ID };
  for (const npc of s.npcs) {
    const def = ctx.resolveMonsterDef(npc.defId);
    if (!def?.spellcasting || !canSpendProtectiveMagic(npc, def)) continue;
    if (!isHostileTo(s, { id: npc.id, factionId: npc.factionId }, playerView)) continue;
    if (chebyshev(npc.tileX, npc.tileY, s.player.tileX, s.player.tileY) > 12) continue; // 60 ft
    const vision = visCanSee(
      s,
      { tileX: npc.tileX, tileY: npc.tileY, senses: def.senses ?? {} },
      { tileX: s.player.tileX, tileY: s.player.tileY, conditions: s.player.conditions, id: PLAYER_ID },
    );
    if (!vision.sees) continue;

    const left = spendProtectiveMagic(npc);
    const name = combatantDisplayName(npc, s.npcs);
    ctx.addLog({ left: `${name} casts Counterspell! (Protective Magic ${left} left)`, style: 'header' });

    const dc = def.spellcasting.saveDC;
    const conMod = mod(ctx.playerDef.con);
    const profBonus = ctx.playerDef.savingThrowProficiencies.includes('con') ? ctx.playerDef.proficiencyBonus : 0;
    const saveBonus = conMod + profBonus;
    const adv = hasAdvantageOn(ctx.playerDef, 'save', 'con');
    const rolled = adv ? rollAdvantage() : null;
    const roll = rolled ? rolled.result : d20();
    const rollLabel = rolled ? `${rolled.rolls[0]},${rolled.rolls[1]}→${roll} [ADV]` : `${roll}`;
    const total = roll + saveBonus;
    const held = total >= dc;
    ctx.addLog({
      left: held
        ? `${ctx.playerDef.name} pushes the casting through!`
        : `${spell.name} dissipates — the magic unravels mid-word (no slot expended)`,
      right: `CON d20(${rollLabel})+${saveBonus}=${total} vs DC ${dc}`,
      style: held ? 'normal' : 'miss',
    });
    Logger.log('ai.counterspell', { casterId: npc.id, spellId: spell.id, dc, total, countered: !held });
    return !held;
  }
  return false;
}
