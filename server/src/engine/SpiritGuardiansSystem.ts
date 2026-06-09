/**
 * SpiritGuardiansSystem — the caster-anchored damaging aura of Spirit
 * Guardians (SRD 5.2.1).
 *
 * The aura is modelled as an `ActiveZone` (so it renders on the map and is
 * torn down generically when concentration ends — `ConcentrationSystem`
 * strips the zone and its `slowed` condition from every creature in
 * `affectedNpcIds`). On top of that rendering shell this module adds the two
 * behaviours the generic zone primitive doesn't cover:
 *
 *   • it re-centres on the caster every time they move and at the end of the
 *     caster's turn (the emanation follows the cleric, unlike a static Fog
 *     Cloud), keeping the slowed-membership in sync; and
 *   • a creature the caster didn't designate (any enemy) that ends its turn
 *     in the aura makes a Wisdom save, taking 3d8 Radiant (+1d8 per slot
 *     level above 3) on a fail or half as much on a success — the same
 *     save-for-half shape Flaming Sphere uses, but Wis-keyed and centred on
 *     the caster rather than a summon.
 *
 * Engine simplification (mirrors the rest of the recurring-effect spells):
 * the damage save resolves at cast time for enemies already inside and again
 * when an enemy ends its turn inside; the SRD "first time each turn it enters"
 * edge (the aura sweeping over a stationary creature as the caster walks past)
 * is not separately rolled.
 */
import type { GameContext } from './GameContext.js';
import type { NpcState } from './types.js';
import { chebyshev } from './EnemyAI.js';
import { d, d20, mod } from './Dice.js';
import { combatantDisplayName } from './CombatFlow.js';
import { startConcentration } from './ConcentrationSystem.js';

const SPELL_ID = 'spirit-guardians';
/** 15-foot emanation → 3 tiles at 5 ft per tile. */
const RADIUS_TILES = 3;
const SLOWED = 'slowed';
/** Radiant gold tint for the aura. */
const TINT = '#ffe08a';

/** The caster's spell save DC (8 + PB + spellcasting ability mod). */
function casterSaveDC(ctx: GameContext): number {
  const ability = ctx.playerDef.spellcastingAbility;
  return 8 + ctx.playerDef.proficiencyBonus + (ability ? mod(ctx.playerDef[ability]) : 0);
}

/** Tiles within the emanation around the caster's current position, clamped
 *  to the map bounds. The emanation passes through walls (it's centred on the
 *  cleric, not a thrown point), so no blocks-movement filtering. */
function auraTiles(ctx: GameContext): Array<[number, number]> {
  const s = ctx.state;
  const { cols, rows } = s.map;
  const out: Array<[number, number]> = [];
  for (let dy = -RADIUS_TILES; dy <= RADIUS_TILES; dy++) {
    for (let dx = -RADIUS_TILES; dx <= RADIUS_TILES; dx++) {
      const x = s.player.tileX + dx;
      const y = s.player.tileY + dy;
      if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
      out.push([x, y]);
    }
  }
  return out;
}

/** True for a creature the caster did NOT designate as safe — i.e. a live,
 *  non-summon enemy. Allies, neutrals, the caster's own summons, and the dead
 *  are spared. */
function isGuardedTarget(npc: NpcState): boolean {
  return npc.hp > 0 && npc.disposition === 'enemy' && !npc.summonSpellId;
}

/** The single Spirit Guardians zone the player is sustaining, if any. */
function findAura(ctx: GameContext) {
  return (ctx.state.activeZones ?? []).find((z) => z.spellId === SPELL_ID && z.casterId === 'player');
}

/** Roll one creature's Wisdom save vs the aura and apply 3d8 (+upcast) radiant,
 *  half on a success. Routed through `resistMod` so radiant resistance /
 *  immunity applies. */
function rollGuardianSaveAgainst(ctx: GameContext, npc: NpcState, slotLevel: number): void {
  const s = ctx.state;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  const dice = 3 + Math.max(0, slotLevel - 3);  // 3d8 base, +1d8 per slot above 3
  const rolls: number[] = [];
  for (let i = 0; i < dice; i++) rolls.push(d(8));
  const raw = rolls.reduce((a, b) => a + b, 0);

  const dc = casterSaveDC(ctx);
  const saveMod = (def.savingThrows && def.savingThrows.wis !== undefined) ? def.savingThrows.wis : mod(def.wis);
  const roll = d20();
  const total = roll + saveMod;
  const success = total >= dc;
  const dealt = success ? Math.floor(raw / 2) : raw;

  const { finalDamage, log: resistLog } = ctx.resistMod(dealt, 'radiant', def, npc.name);
  if (resistLog) ctx.addLog(resistLog);
  ctx.addLog({
    left: `${combatantDisplayName(npc, s.npcs)} ${success ? 'saves' : 'fails'} vs Spirit Guardians — ${finalDamage} radiant`,
    right: `WIS d20(${roll})+${saveMod}=${total} vs DC ${dc} · ${dice}d8[${rolls.join(',')}]=${raw}`,
    style: success ? 'normal' : 'hit',
  });
  if (finalDamage > 0 && npc.hp > 0) {
    npc.hp = Math.max(0, npc.hp - finalDamage);
    if (npc.hp <= 0) ctx.killWithReward(npc, def, `☠ ${combatantDisplayName(npc, s.npcs)} is unmade by the spirits!`);
  }
}

/** Recompute the aura tiles around the caster and reconcile the slowed
 *  membership: enemies now inside gain `slowed` (tracked in `affectedNpcIds`);
 *  enemies the aura had slowed but who are now outside lose it. Only `slowed`
 *  this aura applied is touched, so a creature slowed by another source keeps
 *  it. Safe to call when no aura exists. */
export function recenterSpiritGuardians(ctx: GameContext): void {
  const zone = findAura(ctx);
  if (!zone) return;
  const s = ctx.state;
  zone.originX = s.player.tileX;
  zone.originY = s.player.tileY;
  zone.tiles = auraTiles(ctx);
  const inside = new Set(zone.tiles.map(([x, y]) => `${x},${y}`));

  for (const npc of s.npcs) {
    const within = npc.hp > 0 && inside.has(`${npc.tileX},${npc.tileY}`);
    const tracked = zone.affectedNpcIds.includes(npc.id);
    if (within && isGuardedTarget(npc)) {
      if (!npc.conditions.includes(SLOWED)) npc.conditions.push(SLOWED);
      if (!tracked) zone.affectedNpcIds.push(npc.id);
    } else if (tracked) {
      npc.conditions = npc.conditions.filter((c) => c !== SLOWED);
      zone.affectedNpcIds = zone.affectedNpcIds.filter((id) => id !== npc.id);
    }
  }
}

/** Cast Spirit Guardians: raise (or refresh) the aura on the caster, start
 *  concentration, slow the enemies already inside, and resolve the cast-time
 *  Wisdom save against each of them. Casting resources/slot are consumed by
 *  the dispatcher before this runs. */
export function castSpiritGuardians(ctx: GameContext, slotLevel: number): void {
  const s = ctx.state;
  const spell = ctx.defs.spells.find((sp) => sp.id === SPELL_ID);
  if (!spell) return;

  // Concentration spell: only one aura at a time — drop any prior instance
  // (and its slowed tags) before raising the new one.
  const prior = findAura(ctx);
  if (prior) {
    for (const id of prior.affectedNpcIds) {
      const npc = s.npcs.find((n) => n.id === id);
      if (npc) npc.conditions = npc.conditions.filter((c) => c !== SLOWED);
    }
    s.activeZones = (s.activeZones ?? []).filter((z) => z !== prior);
  }

  s.activeZones = s.activeZones ?? [];
  s.activeZones.push({
    id: ctx.uid(),
    spellId: SPELL_ID,
    name: spell.name,
    shape: 'sphere',
    sizeFeet: 15,
    originX: s.player.tileX,
    originY: s.player.tileY,
    tiles: auraTiles(ctx),
    condition: SLOWED,
    affectedNpcIds: [],
    affectedPlayer: false,
    roundsRemaining: Math.max(1, spell.durationRounds ?? 100),
    casterId: 'player',
    tintHex: TINT,
    castSlotLevel: slotLevel,
  });

  startConcentration(ctx, SPELL_ID);
  ctx.addLog({ left: `${ctx.playerDef.name} casts Spirit Guardians — spectral guardians wheel into being.`, style: 'header' });

  recenterSpiritGuardians(ctx);

  // SRD: creatures in the emanation when it appears make the save immediately.
  const zone = findAura(ctx);
  const inside = new Set((zone?.tiles ?? []).map(([x, y]) => `${x},${y}`));
  for (const npc of [...s.npcs]) {
    if (isGuardedTarget(npc) && inside.has(`${npc.tileX},${npc.tileY}`)) {
      rollGuardianSaveAgainst(ctx, npc, slotLevel);
    }
  }
}

/** End-of-turn save handler: when enemy `npcId` ends its turn inside the aura,
 *  it makes the Wisdom save for 3d8 (+upcast) radiant, half on a success.
 *  Called from the NPC turn-end seam (beside Flaming Sphere). */
export function runSpiritGuardiansEndOfTurnSaves(ctx: GameContext, npcId: string): void {
  const zone = findAura(ctx);
  if (!zone) return;
  const npc = ctx.state.npcs.find((n) => n.id === npcId);
  if (!npc || !isGuardedTarget(npc)) return;
  if (chebyshev(npc.tileX, npc.tileY, ctx.state.player.tileX, ctx.state.player.tileY) > RADIUS_TILES) return;
  rollGuardianSaveAgainst(ctx, npc, zone.castSlotLevel ?? 3);
}
