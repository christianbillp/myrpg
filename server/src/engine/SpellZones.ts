/**
 * Active-zone subsystem — placed area spells (Web, Grease, Gust of Wind,
 * deployed gear): zone registration, enter/end-of-turn saves, expiry ticks.
 * Extracted from the SpellSystem god-file.
 */
import type { GameContext } from './GameContext.js';
import { combatantDisplayName } from './DisplayNames.js';
import type { GameEvent, NpcState, SpellDef, LogEntry, MonsterDef } from './types.js';
import { d, d20, mod, rollAdvantage, applyHalflingLuck, rollDiceBonus } from './Dice.js';
import { chebyshev } from './EnemyAI.js';
import { canCastSpell } from './ActionGuards.js';
import { computeEquippedSlotLabels } from './EquipmentSystem.js';
import { isMagicInitiateSpell, magicInitiateResourceId } from './MagicInitiate.js';
import { startConcentration, endConcentration } from './ConcentrationSystem.js';
import { castSpiritGuardians } from './SpiritGuardiansSystem.js';
import { resolveSpiritualWeaponAttack } from './SummonSystem.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { applyDamageWithTempHp, npcBanePenalty } from './CombatSystem.js';

import { requestCombatStart } from './CombatStartPrompt.js';
import { emitNoise, NOISE_SPELL_VERBAL } from './Sound.js';
import { Logger } from '../Logger.js';
import { canSee as visCanSee } from './Vision.js';
import { hasModifierFlag, hasAdvantageOn } from './Modifiers.js';
import { applySelfBuff, applyBuffTo, removeSpellBuffsFrom } from './Buffs.js';
import { applyInvisibilityConcealment, logInvisibilityFind } from './InvisibilitySystem.js';
import { SPEED_ZERO_CONDITIONS, isIncapacitated, shieldAcBonus, npcConditionImmune } from './ConditionSystem.js';
import {
  tilesInArea, playerInArea, creaturesInArea,
  sphereRadiusTiles, chebyshevDiscTiles,
} from './SpellGeometry.js';

import { applyDamageToNpc, pushNpcAway, rollPlayerSaveAndDamage, spellSaveDC } from './SpellPrimitives.js';
import { npcSaveMod } from './CombatSystem.js';

/**
 * Persistent-zone helper: tag every creature standing in the spell's AOE at
 * cast time with `condition`, and push a long-lived `ActiveZone` record onto
 * `state.activeZones` so the cloud stays visible on the map until its
 * duration expires.
 *
 * Lifetime is decoupled from concentration — the visible zone is driven by
 * `spell.durationRounds`, ticked down at end of round in `GameEngine`. The
 * caster losing concentration is no longer enough to strip the cloud; that
 * matches what players expect when they look at a Fog Cloud on the map and
 * is the right primitive for the upcoming Spirit Guardians / Cloudkill /
 * Wall spells, none of which want their geometry to vanish on a downstream
 * status change.
 */
export function applyZoneCondition(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
  condition: string,
  effectLabel: string,
  tintHex?: string,
): void {
  const s = ctx.state;
  if (!tile) {
    ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' });
    return;
  }
  const inArea = creaturesInArea(ctx, spell, tile);
  for (const t of inArea) {
    const def = ctx.resolveMonsterDef(t.defId);
    if (def && npcConditionImmune(def, condition)) continue;
    if (!t.conditions.includes(condition)) t.conditions.push(condition);
  }
  const casterIn = playerInArea(ctx, spell, tile);
  if (casterIn && !s.player.conditions.includes(condition)) {
    s.player.conditions.push(condition);
  }
  registerActiveZone(ctx, spell, tile, condition, tintHex);
  // Mark the zone with every creature it just tagged, so the end-of-zone
  // cleanup can strip the condition even from creatures that have since
  // been pushed / teleported outside the original tile set.
  const z = s.activeZones?.[s.activeZones.length - 1];
  if (z) {
    for (const t of inArea) if (!z.affectedNpcIds.includes(t.id)) z.affectedNpcIds.push(t.id);
    if (casterIn) z.affectedPlayer = true;
  }
  const total = inArea.length + (casterIn ? 1 : 0);
  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} — ${total} creature(s) ${effectLabel}`,
    style: 'status',
  });
}

/**
 * Persistent-zone helper with a save (Web). Each creature in the area rolls
 * `saveAbility` vs the spell save DC; on failure, `condition` is applied
 * AND the zone is registered on `state.activeZones` so the visual stays up
 * until the duration expires. See `applyZoneCondition` for the lifetime
 * model. SRD "first time entering on a turn" re-tagging is still TBD;
 * creatures present at cast time get the save today.
 */
export function applyZoneSave(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
  saveAbility: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha',
  condition: string,
  effectLabel: string,
): void {
  const s = ctx.state;
  if (!tile) {
    ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' });
    return;
  }
  const inArea = creaturesInArea(ctx, spell, tile);
  const dc = spellSaveDC(ctx);
  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} (${saveAbility.toUpperCase()} save DC ${dc})`,
    style: 'header',
  });
  let affected = 0;
  for (const t of inArea) {
    const def = ctx.resolveMonsterDef(t.defId);
    if (!def) continue;
    if (npcConditionImmune(def, condition)) {
      ctx.addLog({ left: `${combatantDisplayName(t, ctx.state.npcs)} is immune to ${condition}`, style: 'normal' });
      continue;
    }
    const saveBonus = npcSaveMod(t, def, saveAbility);
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    if (!success && !t.conditions.includes(condition)) {
      t.conditions.push(condition);
      affected++;
    }
    ctx.addLog({
      left: `${combatantDisplayName(t, ctx.state.npcs)} ${success ? 'breaks free' : effectLabel}`,
      right: `${saveAbility.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
  }
  // Player in area too — roll the save inline (no damage, so we don't
  // route through rollPlayerSaveAndDamage which requires a damage type).
  if (playerInArea(ctx, spell, tile)) {
    const dc = spellSaveDC(ctx);
    const abMod = mod(ctx.playerDef[saveAbility]);
    const profBonus = ctx.playerDef.savingThrowProficiencies.includes(saveAbility)
      ? ctx.playerDef.proficiencyBonus
      : 0;
    const saveBonus = abMod + profBonus;
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    if (!success && !s.player.conditions.includes(condition)) {
      s.player.conditions.push(condition);
      affected++;
    }
    ctx.addLog({
      left: `${ctx.playerDef.name} ${success ? 'breaks free' : effectLabel}`,
      right: `${saveAbility.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
  }
  registerActiveZone(ctx, spell, tile, condition);
  // Same affected-id tracking as `applyZoneCondition` — see comment there.
  const zoneAdded = s.activeZones?.[s.activeZones.length - 1];
  if (zoneAdded) {
    for (const t of inArea) {
      if (t.conditions.includes(condition) && !zoneAdded.affectedNpcIds.includes(t.id)) {
        zoneAdded.affectedNpcIds.push(t.id);
      }
    }
    if (s.player.conditions.includes(condition) && playerInArea(ctx, spell, tile)) {
      zoneAdded.affectedPlayer = true;
    }
  }
  void affected;
}

/**
 * Push an `ActiveZone` record onto the session state. Idempotent on
 * (`spellId`, `casterId`) — recasting the same spell replaces the prior
 * entry. The zone outlives the caster's concentration (per the user's
 * explicit ruling); lifetime is whatever the spell's `durationRounds`
 * dictates, and the engine's end-of-round tick decrements it.
 */
export function registerActiveZone(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number },
  condition: string | undefined,
  tintHex?: string,
  enterSave?: { ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'; dc: number },
): void {
  if (!spell.area) return;
  const s = ctx.state;
  s.activeZones = s.activeZones ?? [];
  const tilesSet = tilesInArea(ctx, spell, tile);
  const tiles: Array<[number, number]> = Array.from(tilesSet).map((k) => {
    const [x, y] = k.split(',').map(Number);
    return [x, y] as [number, number];
  });
  const isSelfAnchored = spell.range === 'self';
  const origin = isSelfAnchored
    ? { x: s.player.tileX, y: s.player.tileY }
    : { x: tile.x, y: tile.y };
  const target = (spell.area.shape === 'cone' || spell.area.shape === 'line') && !isSelfAnchored
    ? { x: tile.x, y: tile.y }
    : isSelfAnchored
      ? { x: tile.x, y: tile.y }
      : undefined;
  const zone = {
    id: ctx.uid(),
    spellId: spell.id,
    name: spell.name,
    shape: spell.area.shape,
    sizeFeet: spell.area.sizeFeet,
    originX: origin.x,
    originY: origin.y,
    targetX: target?.x,
    targetY: target?.y,
    tiles,
    condition,
    enterSave,
    difficultTerrain: spell.zone?.difficultTerrain ?? false,
    affectedNpcIds: [] as string[],
    affectedPlayer: false,
    roundsRemaining: Math.max(1, spell.durationRounds ?? 10),
    casterId: 'player',
    tintHex,
  };
  // Concentration spells (Fog Cloud, Web, Darkness, Silent Image) sustain
  // only one instance at a time — recasting drops the prior. Non-
  // concentration ground zones (Grease, Minor Illusion) stack: each cast
  // pushes a new zone with its own duration timer and tile-set, so the
  // player can lay multiple patches of Grease across the map.
  if (spell.concentration) {
    s.activeZones = s.activeZones.filter((z) => !(z.spellId === spell.id && z.casterId === 'player'));
  }
  s.activeZones.push(zone);
}

/**
 * SRD Web-style enter-save: roll the zone's `enterSave` against a creature
 * that is standing in a zone tile and doesn't already carry the zone's
 * condition. Fires at the start of an NPC's turn (so "starts its turn there"
 * is covered) and after the player moves into a new tile. Caller is
 * responsible for skipping creatures that have already been checked this
 * turn (we lean on the "doesn't already carry" gate as a cheap idempotency
 * check — once Restrained you stay Restrained until you break free).
 */
export function tickZoneEnterSaves(ctx: GameContext, subjectId: 'player' | string): void {
  const s = ctx.state;
  if (!s.activeZones || s.activeZones.length === 0) return;
  const subject = subjectId === 'player'
    ? { tileX: s.player.tileX, tileY: s.player.tileY, conditions: s.player.conditions, displayName: ctx.playerDef.name, def: null as null, isPlayer: true as const }
    : (() => {
        const npc = s.npcs.find((n) => n.id === subjectId && n.hp > 0);
        if (!npc) return null;
        const def = ctx.resolveMonsterDef(npc.defId);
        return { tileX: npc.tileX, tileY: npc.tileY, conditions: npc.conditions, displayName: combatantDisplayName(npc, s.npcs), def, isPlayer: false as const, npc };
      })();
  if (!subject) return;
  for (const z of s.activeZones) {
    if (!z.enterSave || !z.condition) continue;
    const inside = new Set(z.tiles.map(([x, y]) => `${x},${y}`));
    if (!inside.has(`${subject.tileX},${subject.tileY}`)) continue;
    if (subject.conditions.includes(z.condition)) continue;
    if (!subject.isPlayer && subject.def && npcConditionImmune(subject.def, z.condition)) continue;
    const ability = z.enterSave.ability;
    const dc = z.enterSave.dc;
    let saveBonus: number;
    if (subject.isPlayer) {
      const abMod = mod(ctx.playerDef[ability]);
      const profBonus = ctx.playerDef.savingThrowProficiencies.includes(ability) ? ctx.playerDef.proficiencyBonus : 0;
      saveBonus = abMod + profBonus;
    } else {
      const def = subject.def;
      if (!def) continue;
      saveBonus = (def.savingThrows && def.savingThrows[ability] !== undefined) ? def.savingThrows[ability] : mod(def[ability]);
    }
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    ctx.addLog({
      left: `${subject.displayName} ${success ? 'avoids' : 'is caught by'} ${z.name}`,
      right: `${ability.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    if (!success) {
      if (subject.isPlayer) {
        if (!s.player.conditions.includes(z.condition)) s.player.conditions.push(z.condition);
        z.affectedPlayer = true;
        // Caltrops-style Speed 0: halt the rest of this turn's movement so the
        // player can't keep walking through the hazard once snared.
        if (SPEED_ZERO_CONDITIONS.includes(z.condition)) s.player.movesLeft = 0;
        if (z.enterDamage) ctx.applyDamageToPlayer(z.enterDamage.amount, ctx.eventSink ?? []);
      } else {
        if (!subject.npc.conditions.includes(z.condition)) subject.npc.conditions.push(z.condition);
        if (!z.affectedNpcIds.includes(subject.npc.id)) z.affectedNpcIds.push(subject.npc.id);
        if (z.enterDamage) applyDamageToNpc(ctx, subject.npc, z.enterDamage.amount, z.enterDamage.type);
      }
    }
  }
}

/** Pure helper: strip every condition this zone applied from the creatures
 *  it touched (regardless of where they're now standing). Used by the zone-
 *  expiry, concentration-end, and Gust-of-Wind dispersal paths so a creature
 *  that was Restrained by Web doesn't carry the condition forever just
 *  because the engine couldn't observe a current overlap. */
export function stripZoneAffectedConditions(ctx: GameContext, zone: { condition?: string; affectedNpcIds: string[]; affectedPlayer: boolean }): void {
  if (!zone.condition) return;
  const s = ctx.state;
  for (const id of zone.affectedNpcIds) {
    const npc = s.npcs.find((n) => n.id === id);
    if (!npc) continue;
    npc.conditions = npc.conditions.filter((c) => c !== zone.condition);
  }
  if (zone.affectedPlayer) {
    s.player.conditions = s.player.conditions.filter((c) => c !== zone.condition);
  }
}

/**
 * SRD Gust of Wind end-of-turn save. Walk every Gust zone the player is
 * sustaining; any creature ending its turn on a zone tile rolls a fresh
 * STR save against the original DC and is pushed 15 ft away from the
 * caster on a failure. The caster's `spellSaveDC` at cast time is the
 * authoritative DC; we recompute here to keep the function self-contained.
 *
 * Caller passes the subject id (`'player'` or an NPC id). Idempotent — a
 * creature pushed clear of the zone in this tick won't keep re-rolling.
 */
export function runGustOfWindEndOfTurnSaves(ctx: GameContext, subjectId: 'player' | string, events?: GameEvent[]): void {
  const s = ctx.state;
  if (!s.activeZones || s.activeZones.length === 0) return;
  const gustZones = s.activeZones.filter((z) => z.spellId === 'gust-of-wind');
  if (gustZones.length === 0) return;
  const dc = spellSaveDC(ctx);
  if (subjectId === 'player') {
    for (const z of gustZones) {
      const inside = new Set(z.tiles.map(([x, y]) => `${x},${y}`));
      if (!inside.has(`${s.player.tileX},${s.player.tileY}`)) continue;
      const abMod = mod(ctx.playerDef.str);
      const profBonus = ctx.playerDef.savingThrowProficiencies.includes('str') ? ctx.playerDef.proficiencyBonus : 0;
      const saveBonus = abMod + profBonus;
      const roll = d20();
      const total = roll + saveBonus;
      const success = total >= dc;
      ctx.addLog({
        left: `${ctx.playerDef.name} ${success ? 'braces against' : 'is shoved by'} the Gust of Wind`,
        right: `STR d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
        style: success ? 'normal' : 'status',
      });
      // No engine pushPlayerAway helper today — the SRD direction is "away
      // from caster", but the caster IS the player here, so any push is a
      // no-op. Log only.
    }
    return;
  }
  const npc = s.npcs.find((n) => n.id === subjectId && n.hp > 0);
  if (!npc) return;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  for (const z of gustZones) {
    const inside = new Set(z.tiles.map(([x, y]) => `${x},${y}`));
    if (!inside.has(`${npc.tileX},${npc.tileY}`)) continue;
    const saveBonus = (def.savingThrows && def.savingThrows['str'] !== undefined)
      ? def.savingThrows['str']
      : mod(def.str);
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    ctx.addLog({
      left: `${combatantDisplayName(npc, s.npcs)} ${success ? 'braces against' : 'is shoved by'} the Gust of Wind`,
      right: `STR d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    if (!success) pushNpcAway(ctx, npc, 15, events);
  }
}

/**
 * End-of-round tick. Decrement `roundsRemaining` on every active zone and
 * remove expired ones. When a zone expires, strip its `condition` from any
 * creature still standing inside its tile set — that's the only condition
 * source the zone owns, so creatures outside the cloud are unaffected.
 *
 * Called from `enterPlayerTurn` (one tick per combat round) and from
 * `WorldTick.runOffCameraTick` (one tick per 6-second real-time interval
 * during exploration). Both paths are idempotent under no-zones.
 */
export function tickActiveZones(ctx: GameContext): void {
  const s = ctx.state;
  if (!s.activeZones || s.activeZones.length === 0) return;
  const expired: typeof s.activeZones = [];
  const survived: typeof s.activeZones = [];
  for (const z of s.activeZones) {
    z.roundsRemaining -= 1;
    if (z.roundsRemaining <= 0) expired.push(z);
    else survived.push(z);
  }
  if (expired.length === 0) return;
  s.activeZones = survived;
  for (const z of expired) {
    stripZoneAffectedConditions(ctx, z);
    ctx.addLog({ left: `${z.name} fades`, style: 'status' });
  }
}
