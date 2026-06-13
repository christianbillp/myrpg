/**
 * Utility-spell dispatcher — the big per-spell-shape switch for self-buffs,
 * cure / restore / dispel, summons, light, teleports, and Enlarge/Reduce.
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
import { SPEED_ZERO_CONDITIONS, isIncapacitated, shieldAcBonus } from './ConditionSystem.js';
import {
  tilesInArea, playerInArea, creaturesInArea,
  sphereRadiusTiles, chebyshevDiscTiles,
} from './SpellGeometry.js';

import { rollDamage, spellSaveDC, spellMod, applyDamageToNpc, normaliseConditionList, conditionLogText, damageAfterSave, pushNpcAway, rollPlayerSaveAndDamage, visCanSeeTargetCover, cantripDiceMultiplier, spellAttackBonus, onHitConditionNote } from './SpellPrimitives.js';
import { applyZoneCondition, applyZoneSave, registerActiveZone } from './SpellZones.js';
import { npcSaveMod } from './CombatSystem.js';

/** SRD Enhance Ability — per-ability flavour names for the log line. */
const ENHANCE_ABILITY_VARIANTS: Record<string, string> = {
  str: "Bull's Strength",
  dex: "Cat's Grace",
  con: "Bear's Endurance",
  int: "Fox's Cunning",
  wis: "Owl's Wisdom",
  cha: "Eagle's Splendor",
};

export function resolveUtilitySpell(ctx: GameContext, spell: SpellDef, slotLevel: number, tile?: { x: number; y: number }, targetIds?: string[], abilityChoice?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', damageTypeChoice?: string): void {
  // No roll; just narrate. Specific lasting effects (Mage Armor, Shield as
  // reaction) handled by spell-id switch — kept here, not as separate files,
  // since each is one-line semantic flag flips.
  const s = ctx.state;
  // Cast-time persistent zones (Fog Cloud, Darkness, Web) — data-driven from
  // `spell.zone`. Each tags creatures in the area (with or without a save) and
  // registers the visible zone for its duration. Ground-placeable zones
  // (Grease, Silent Image, …) are registered by the trailing block in
  // `doCastSpell` instead, so they fall through to the switch's narration.
  if (spell.zone?.castSave) {
    const cs = spell.zone.castSave;
    applyZoneSave(ctx, spell, tile, cs.ability, cs.condition, cs.label ?? cs.condition);
    if (spell.zone.enterSave) {
      const z = s.activeZones?.[s.activeZones.length - 1];
      if (z && z.spellId === spell.id) z.enterSave = { ability: spell.zone.enterSave.ability, dc: spellSaveDC(ctx) };
    }
    return;
  }
  if (spell.zone?.castCondition) {
    applyZoneCondition(ctx, spell, tile, spell.zone.castCondition, spell.zone.castLabel ?? spell.zone.castCondition, spell.zone.tintHex);
    return;
  }
  switch (spell.id) {
    // ── Self-buff primitives (US-065 buff layer) ──────────────────────────────
    // Bless: +1d4 to the caster's attack rolls and saving throws.
    case 'bless':
      applySelfBuff(ctx, { spellId: 'bless', modifiers: [{ type: 'dice-bonus', on: 'attack', count: 1, sides: 4 }, { type: 'dice-bonus', on: 'save', count: 1, sides: 4 }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is blessed — +1d4 to attack rolls and saves`, style: 'status' });
      return;
    // Light (US-127): the caster's gear sheds Bright Light in a 20-ft radius
    // and lifts Darkness to Dim for another 20 ft — modelled as a carried
    // light source `Vision.effectiveLightAt` reads. The 1-hour duration is
    // hour-scale: it survives the scene and clears on a Long Rest or recast.
    case 'light':
      ctx.state.player.lightSource = { brightFt: 20, dimFt: 20, source: 'light' };
      ctx.addLog({ left: `${ctx.playerDef.name}'s ${spell.name} flares — bright light to 20 ft.`, style: 'status' });
      return;
    // Guidance: +1d4 to the caster's ability checks.
    case 'guidance':
      applySelfBuff(ctx, { spellId: 'guidance', modifiers: [{ type: 'dice-bonus', on: 'check', count: 1, sides: 4 }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} channels Guidance — +1d4 to ability checks`, style: 'status' });
      return;
    // Shield of Faith: +2 AC.
    case 'shield-of-faith':
      applySelfBuff(ctx, { spellId: 'shield-of-faith', modifiers: [{ type: 'ac-bonus', value: 2 }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is warded — +2 AC (now ${ctx.state.player.ac})`, style: 'status' });
      return;
    // Haste: +2 AC, Advantage on DEX saves, doubled Speed (the extra action is
    // descriptive). Speed doubling is modelled as a +base-speed bonus.
    case 'haste':
      applySelfBuff(ctx, { spellId: 'haste', modifiers: [{ type: 'ac-bonus', value: 2 }, { type: 'advantage', on: 'save', key: 'dex' }, { type: 'speed-bonus', value: ctx.playerDef.speed }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is hasted — +2 AC, doubled Speed, Advantage on DEX saves`, style: 'status' });
      return;
    // Beacon of Hope: Advantage on WIS saves (the death-save advantage + max
    // healing riders are descriptive until those paths consume buffs).
    case 'beacon-of-hope':
      applySelfBuff(ctx, { spellId: 'beacon-of-hope', modifiers: [{ type: 'advantage', on: 'save', key: 'wis' }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} radiates hope — Advantage on Wisdom saves`, style: 'status' });
      return;
    // Aid: raise the caster's HP maximum and current HP by 5 (+5 per slot level
    // above 2) for the duration. Implemented by directly raising the session
    // `playerDef.maxHp` (which every HP read site consumes) and current HP; the
    // bonus is recorded on the buff so a Long Rest reverses it exactly.
    case 'aid': {
      const amt = 5 + 5 * Math.max(0, slotLevel - 2);
      ctx.playerDef.maxHp += amt;
      s.player.hp += amt;
      applySelfBuff(ctx, { spellId: 'aid', modifiers: [{ type: 'max-hp', value: amt }] });
      ctx.addLog({ left: `${ctx.playerDef.name} is bolstered by Aid — +${amt} HP maximum (now ${s.player.hp}/${ctx.playerDef.maxHp})`, style: 'heal' });
      return;
    }
    // Resistance (cantrip): reduce damage of one chosen type by 1d4.
    case 'resistance': {
      const dt = (spell.damageTypeChoices?.includes(damageTypeChoice ?? '') ? damageTypeChoice : spell.damageTypeChoices?.[0]) ?? 'fire';
      applySelfBuff(ctx, { spellId: 'resistance', modifiers: [{ type: 'damage-reduction', damageType: dt, count: 1, sides: 4 }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is warded against ${dt} — reduce that damage by 1d4`, style: 'status' });
      return;
    }
    // Protection from Energy: Resistance to one chosen damage type for the
    // duration. The damage-type picker rides on `damageTypeChoice`.
    case 'protection-from-energy': {
      const dt = (spell.damageTypeChoices?.includes(damageTypeChoice ?? '') ? damageTypeChoice : spell.damageTypeChoices?.[0]) ?? 'fire';
      applySelfBuff(ctx, { spellId: 'protection-from-energy', modifiers: [{ type: 'resistance', damageType: dt }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} is warded against ${dt} — Resistance for the duration`, style: 'status' });
      return;
    }
    case 'mage-armor':
      // Self/touch: target self (the only valid target without an ally system).
      if (s.player.equippedSlots.armorId) {
        ctx.addLog({ left: `Mage Armor fizzles — already wearing armor`, style: 'miss' });
        return;
      }
      // Recorded as a self-buff (`mage-armor` flag) → `recomputeBuffs` derives
      // `mageArmor` and rebuilds AC (base 13 + DEX). Donning armor or losing the
      // buff resets it. Persisted across resume by re-seeding the buff.
      applySelfBuff(ctx, { spellId: 'mage-armor', modifiers: [{ type: 'flag', name: 'mage-armor' }] });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Mage Armor — AC ${ctx.playerDef.ac} for 8 hours`, style: 'status' });
      break;
    case 'detect-magic': {
      // Sense magical auras: flag magic items held or lying within 30 ft (6
      // tiles). Surfaces an aura in the inventory + on the map even while the
      // item is unidentified — knowing a thing is magical isn't knowing what it
      // does (that's Identify).
      const p = ctx.state.player;
      const detected = new Set(p.magicDetectedItemIds ?? []);
      const present = new Set<string>();
      const consider = (id: string): void => {
        const it = ctx.defs.equipment.find((i) => i.id === id) as { magic?: boolean } | undefined;
        if (it?.magic) { present.add(id); detected.add(id); }
      };
      for (const id of new Set(p.inventoryIds ?? [])) consider(id);
      for (const mi of ctx.state.mapItems ?? []) {
        if (chebyshev(p.tileX, p.tileY, mi.tileX, mi.tileY) <= 6) consider(mi.defId);
      }
      p.magicDetectedItemIds = [...detected];
      ctx.addLog({
        left: `${ctx.playerDef.name} casts Detect Magic — ${present.size ? `senses magic on ${present.size} item${present.size > 1 ? 's' : ''} nearby` : 'senses no magic nearby'}`,
        style: 'status',
      });
      break;
    }
    case 'identify': {
      // Identify the held unidentified items, revealing their true name and
      // properties. (SRD targets one item; we resolve all held unidentified
      // items per cast for simplicity — no per-item target picker.)
      const p = ctx.state.player;
      p.identifiedItemIds = p.identifiedItemIds ?? [];
      const named: string[] = [];
      for (const id of new Set(p.inventoryIds ?? [])) {
        const it = ctx.defs.equipment.find((i) => i.id === id) as { id: string; name: string; startsUnidentified?: boolean } | undefined;
        if (it?.startsUnidentified && !p.identifiedItemIds.includes(id)) {
          p.identifiedItemIds.push(id);
          named.push(it.name);
        }
      }
      if (named.length) {
        p.equippedSlotLabels = computeEquippedSlotLabels(ctx.playerDef, p.equippedSlots, ctx.defs.equipment);
        ctx.addLog({ left: `${ctx.playerDef.name} casts Identify — learns the properties of ${named.join(', ')}.`, style: 'status' });
      } else {
        ctx.addLog({ left: `${ctx.playerDef.name} casts Identify — nothing carried is unidentified.`, style: 'status' });
      }
      break;
    }
    // ── Cure / restore / dispel (US — Bucket 4 utility resolvers) ─────────────
    // Lesser Restoration: end one condition (Blinded, Deafened, Paralyzed, or
    // Poisoned) on the caster or a touched creature. The SRD lets the caster
    // pick; with no condition-picker plumbed we end the most debilitating one
    // present, in priority order. `targetIds[0] === 'player'` is the self-cast.
    case 'lesser-restoration': {
      const LESSER_RESTORE_ORDER = ['paralyzed', 'poisoned', 'blinded', 'deafened'];
      const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
      const onSelf = targetId === 'player';
      const conds = onSelf ? s.player.conditions : (s.npcs.find((n) => n.id === targetId)?.conditions);
      if (!conds) { ctx.addLog({ left: `Lesser Restoration: no valid target.`, style: 'miss' }); break; }
      const who = onSelf ? ctx.playerDef.name : combatantDisplayName(s.npcs.find((n) => n.id === targetId)!, s.npcs);
      const removed = LESSER_RESTORE_ORDER.find((c) => conds.includes(c));
      if (removed) {
        if (onSelf) s.player.conditions = conds.filter((c) => c !== removed);
        else s.npcs.find((n) => n.id === targetId)!.conditions = conds.filter((c) => c !== removed);
        ctx.addLog({ left: `${ctx.playerDef.name} casts Lesser Restoration — ${who}'s ${removed} condition ends.`, style: 'heal' });
      } else {
        ctx.addLog({ left: `Lesser Restoration finds no Blinded/Deafened/Paralyzed/Poisoned condition on ${who} to end.`, style: 'miss' });
      }
      break;
    }
    // Spare the Dying: stabilise a creature at 0 HP (cast on a downed ally, not
    // the unconscious caster — the player can't act at 0 HP). Adds Stable so
    // the creature stops sliding toward death.
    case 'spare-the-dying': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId;
      const npc = targetId && targetId !== 'player' ? s.npcs.find((n) => n.id === targetId) : undefined;
      if (!npc) { ctx.addLog({ left: `Spare the Dying: choose a creature at 0 HP within range.`, style: 'miss' }); break; }
      if (npc.hp > 0) { ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} isn't dying.`, style: 'miss' }); break; }
      if (!npc.conditions.includes('stable')) npc.conditions.push('stable');
      ctx.addLog({ left: `${ctx.playerDef.name} casts Spare the Dying — ${combatantDisplayName(npc, s.npcs)} is stabilised.`, style: 'heal' });
      break;
    }
    // Dispel Magic: end the spell effects on a creature. Strips the spell-layer
    // magic the engine tracks — active buffs (Bless, Haste, …), and the
    // duration-bound conditions recorded as `spell-condition` ongoing effects
    // (Color Spray's Blinded, …). Level-gating (DC 10 + spell level for spells
    // above 3rd) is descriptive — every on-board effect here is ≤ the slot
    // level it's worth dispelling.
    case 'dispel-magic': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId;
      const npc = targetId && targetId !== 'player' ? s.npcs.find((n) => n.id === targetId) : undefined;
      if (!npc) { ctx.addLog({ left: `Dispel Magic: choose a creature carrying a spell effect.`, style: 'miss' }); break; }
      let dispelled = 0;
      for (const sid of new Set((npc.activeBuffs ?? []).map((b) => b.spellId))) {
        if (removeSpellBuffsFrom(npc, sid)) dispelled++;
      }
      const ongoing = (npc.ongoingEffects ?? []).filter((oe) => oe.kind === 'spell-condition');
      for (const oe of ongoing) {
        npc.conditions = npc.conditions.filter((c) => c !== oe.condition);
        dispelled++;
      }
      npc.ongoingEffects = (npc.ongoingEffects ?? []).filter((oe) => oe.kind !== 'spell-condition');
      ctx.addLog({
        left: dispelled > 0
          ? `${ctx.playerDef.name} casts Dispel Magic — ${dispelled} effect${dispelled > 1 ? 's' : ''} on ${combatantDisplayName(npc, s.npcs)} ${dispelled > 1 ? 'end' : 'ends'}.`
          : `${ctx.playerDef.name} casts Dispel Magic — no dispellable magic on ${combatantDisplayName(npc, s.npcs)}.`,
        style: dispelled > 0 ? 'status' : 'miss',
      });
      break;
    }
    // Protection from Poison: end Poisoned on the target and (for the caster)
    // grant Resistance to Poison damage for the duration. Routed through the
    // self-buff layer like Protection from Energy; an ally target gets the
    // Poisoned cure (the buff layer is caster-centred, so ally resistance is
    // descriptive).
    case 'protection-from-poison': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
      const onSelf = targetId === 'player';
      if (onSelf) {
        s.player.conditions = s.player.conditions.filter((c) => c !== 'poisoned');
        applySelfBuff(ctx, { spellId: 'protection-from-poison', modifiers: [{ type: 'resistance', damageType: 'poison' }] });
        ctx.addLog({ left: `${ctx.playerDef.name} casts Protection from Poison — Poisoned ends, Resistance to poison for the duration.`, style: 'status' });
      } else {
        const npc = s.npcs.find((n) => n.id === targetId);
        if (!npc) { ctx.addLog({ left: `Protection from Poison: no valid target.`, style: 'miss' }); break; }
        npc.conditions = npc.conditions.filter((c) => c !== 'poisoned');
        ctx.addLog({ left: `${ctx.playerDef.name} casts Protection from Poison on ${combatantDisplayName(npc, s.npcs)} — Poisoned ends.`, style: 'status' });
      }
      break;
    }
    // Sanctuary: ward a creature (self or ally). Recorded as a `sanctuary`
    // condition the enemy target-picker reads — an attacker must make a Wis
    // save to target the warded creature. The ward ends when the warded
    // creature attacks or casts at a foe (stripped in `doAttack` / the
    // aggressive-cast path); the 1-minute duration expiry is descriptive.
    case 'sanctuary': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
      if (targetId === 'player') {
        if (!s.player.conditions.includes('sanctuary')) s.player.conditions.push('sanctuary');
        ctx.addLog({ left: `${ctx.playerDef.name} casts Sanctuary — warded until they strike or cast at a foe.`, style: 'status' });
      } else {
        const npc = s.npcs.find((n) => n.id === targetId);
        if (!npc) { ctx.addLog({ left: `Sanctuary: no valid target.`, style: 'miss' }); break; }
        if (!npc.conditions.includes('sanctuary')) npc.conditions.push('sanctuary');
        ctx.addLog({ left: `${ctx.playerDef.name} casts Sanctuary on ${combatantDisplayName(npc, s.npcs)} — warded against attacks.`, style: 'status' });
      }
      break;
    }
    // Remove Curse: end the Cursed condition (Bestow Curse, cursed items) on
    // the caster or a touched creature.
    case 'remove-curse': {
      const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
      const onSelf = targetId === 'player';
      const conds = onSelf ? s.player.conditions : s.npcs.find((n) => n.id === targetId)?.conditions;
      if (!conds) { ctx.addLog({ left: `Remove Curse: no valid target.`, style: 'miss' }); break; }
      const who = onSelf ? ctx.playerDef.name : combatantDisplayName(s.npcs.find((n) => n.id === targetId)!, s.npcs);
      if (conds.includes('cursed')) {
        if (onSelf) s.player.conditions = conds.filter((c) => c !== 'cursed');
        else s.npcs.find((n) => n.id === targetId)!.conditions = conds.filter((c) => c !== 'cursed');
        ctx.addLog({ left: `${ctx.playerDef.name} casts Remove Curse — the curse on ${who} lifts.`, style: 'status' });
      } else {
        ctx.addLog({ left: `Remove Curse finds no curse on ${who} to lift.`, style: 'miss' });
      }
      break;
    }
    // Blink: self-buff flag. At the end of each of the caster's turns
    // (`endPlayerTurn`) a 1d6 roll of 4-6 phases them to the Ethereal Plane
    // (`ethereal` condition → untargetable) until the start of their next turn.
    case 'blink':
      applySelfBuff(ctx, { spellId: 'blink', modifiers: [{ type: 'flag', name: 'blink' }] });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Blink — flickering half-here, half-away.`, style: 'status' });
      break;
    case 'feather-fall':
      ctx.addLog({ left: `${ctx.playerDef.name} casts Feather Fall`, style: 'status' });
      break;
    case 'shield':
      // Shield is a reaction interrupt — handled in ReactionSystem; if the
      // player triggers it through the CAST button outside that flow, log a no-op.
      ctx.addLog({ left: `Shield can only be cast as a Reaction to an incoming attack`, style: 'miss' });
      break;
    case 'false-life': {
      // Temporary HP grant. SRD: gain `1d4 + 4` temp HP for the duration.
      // `awardTempHp` already implements the higher-of-two rule, so casters
      // re-rolling within the window simply keep whichever roll was better.
      if (!spell.tempHpRoll) break;
      const { dice, sides, bonus = 0 } = spell.tempHpRoll;
      const roll = rollDamage(dice, sides, bonus);
      s.player.tempHp = Math.max(s.player.tempHp, roll.total);
      ctx.addLog({
        left: `${ctx.playerDef.name} casts ${spell.name} — +${roll.total} Temp HP (now ${s.player.tempHp})`,
        right: `${dice}d${sides}+${bonus}[${roll.rolls.join(',')}]=${roll.total}`,
        style: 'status',
      });
      break;
    }
    case 'longstrider': {
      // SRD: +10 ft speed for the duration. Recorded as a self-buff
      // (`speed-bonus` modifier) → `recomputeBuffs` derives `speedBonus`. When
      // cast mid-turn, also bump `movesLeft` by the new ft difference so the
      // player can spend the extra tiles this turn.
      const prevBonus = s.player.speedBonus;
      applySelfBuff(ctx, { spellId: 'longstrider', modifiers: [{ type: 'speed-bonus', value: 10 }] });
      if (s.phase === 'player_turn') {
        const deltaTiles = Math.floor((s.player.speedBonus - prevBonus) / 5);
        if (deltaTiles > 0) s.player.movesLeft += deltaTiles;
      }
      ctx.addLog({ left: `${ctx.playerDef.name} casts Longstrider — Speed +10 ft for 1 hour`, style: 'status' });
      break;
    }
    case 'expeditious-retreat': {
      // SRD: cast as bonus action; you Dash this turn and may Dash as a bonus
      // action on each subsequent turn. The `expeditious-retreat` flag (which
      // CombatFlow reads to grant the per-turn Dash) is derived from the active
      // buff by `recomputeBuffs`, so concentration-end cleanup is generic. We
      // still grant the upfront Dash immediately (adds `speed/5` extra tiles).
      applySelfBuff(ctx, { spellId: spell.id, modifiers: [{ type: 'flag', name: 'expeditious-retreat' }], concentration: true });
      if (s.phase === 'player_turn') {
        s.player.movesLeft += Math.floor((ctx.playerDef.speed + s.player.speedBonus) / 5);
      }
      ctx.addLog({ left: `${ctx.playerDef.name} casts Expeditious Retreat — Dash this turn and as a bonus action each round`, style: 'status' });
      break;
    }
    case 'jump':
      // SRD: triple jump distance for the duration. The engine doesn't model
      // jump distance per-tile yet — we surface the multiplier on PlayerState
      // so future jump-check code can read it.
      s.player.jumpMultiplier = 3;
      ctx.addLog({ left: `${ctx.playerDef.name} casts Jump — jump distance ×3 for 1 minute`, style: 'status' });
      break;
    case 'magic-weapon': {
      // SRD: +1 to attack and damage with a touched nonmagical weapon for
      // 1 hour. Higher-level upcasts grant +2 (L3-5) or +3 (L6+). The
      // bonus rides on PlayerAttack via applyEquipment.
      const bonus = slotLevel >= 6 ? 3 : slotLevel >= 3 ? 2 : 1;
      // Self-buff (`weapon-bonus` modifier) → `recomputeBuffs` derives
      // `magicWeaponBonus` and rebuilds the attack; concentration end removes it.
      applySelfBuff(ctx, { spellId: 'magic-weapon', modifiers: [{ type: 'weapon-bonus', value: bonus }], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Magic Weapon — +${bonus} to attack and damage for 1 hour`, style: 'status' });
      break;
    }
    case 'see-invisibility':
      // SRD: see invisible creatures and the Ethereal Plane for 1 hour.
      // Self-buff `flag` → `recomputeBuffs` derives `seeInvisible`.
      applySelfBuff(ctx, { spellId: 'see-invisibility', modifiers: [{ type: 'flag', name: 'see-invisible' }] });
      ctx.addLog({ left: `${ctx.playerDef.name} casts See Invisibility — sees Invisible creatures for 1 hour`, style: 'status' });
      break;
    case 'darkvision':
      // SRD: target gains Darkvision 150 ft for 8 hours. Touch-self in our
      // single-character implementation. Writes to playerDef.senses so the
      // Vision module's effective-PP calculations factor it in.
      if (!ctx.playerDef.senses) ctx.playerDef.senses = {};
      ctx.playerDef.senses.darkvision = Math.max(ctx.playerDef.senses.darkvision ?? 0, 150);
      ctx.addLog({ left: `${ctx.playerDef.name} casts Darkvision — Darkvision 150 ft for 8 hours`, style: 'status' });
      break;
    case 'blur':
      // SRD: attackers have Disadvantage on attack rolls against you
      // (Concentration). Self-buff records the `blurred` condition; the generic
      // `removeBuffsForSpell` in endConcentration strips it when the spell ends.
      applySelfBuff(ctx, { spellId: 'blur', conditions: ['blurred'], concentration: true });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Blur — attackers have Disadvantage`, style: 'status' });
      break;
    case 'mirror-image': {
      // SRD: three illusory duplicates appear in your space. Recorded as a buff
      // with `charges: 3`; `recomputeBuffs` derives `mirrorImages`, and the
      // damage path (CombatFlow) decrements the buff's charges per absorbed hit,
      // removing the buff at 0. Re-casting replaces the buff (refreshes to 3).
      applySelfBuff(ctx, { spellId: 'mirror-image', charges: 3 });
      ctx.addLog({ left: `${ctx.playerDef.name} casts Mirror Image — three duplicates shimmer into being`, style: 'status' });
      break;
    }
    case 'invisibility': {
      // SRD: a creature you touch has the Invisible condition until the
      // spell ends. Ends early when the target makes an attack roll, deals
      // damage, or casts a spell. Concentration up to 1 hour.
      // Target is `targetIds[0]` (NPC) or the caster (self-cast → empty
      // targetIds). The caster's `invisibilityTargetId` is set so the
      // attack-resolution paths know which creature to watch for the
      // end-on-attack trigger; concentration end strips the condition and
      // clears the field.
      // The buff (carrying the `invisible` condition) lives on whichever
      // creature is the recipient — the player (self-cast) or an NPC. The
      // creature-agnostic store handles both; `endConcentration` strips it from
      // the right host. `invisibilityTargetId` stays as the pointer the
      // end-on-attack triggers watch.
      const tid = targetIds?.[0];
      if (tid) {
        const target = s.npcs.find((n) => n.id === tid && n.hp > 0);
        if (!target) { ctx.addLog({ left: `${spell.name}: invalid target`, style: 'miss' }); break; }
        applyBuffTo(target, { spellId: 'invisibility', conditions: ['invisible'], concentration: true });
        s.player.invisibilityTargetId = target.id;
        ctx.addLog({ left: `${ctx.playerDef.name} casts Invisibility on ${target.revealedName ?? target.name}`, style: 'status' });
        logInvisibilityFind(ctx, applyInvisibilityConcealment(ctx, target.id), target.revealedName ?? target.name);
      } else {
        applySelfBuff(ctx, { spellId: 'invisibility', conditions: ['invisible'], concentration: true });
        s.player.invisibilityTargetId = 'player';
        ctx.addLog({ left: `${ctx.playerDef.name} casts Invisibility on themselves — they vanish`, style: 'status' });
        logInvisibilityFind(ctx, applyInvisibilityConcealment(ctx, 'player'), ctx.playerDef.name);
      }
      break;
    }
    case 'misty-step': {
      // SRD: bonus action, teleport up to 30 ft to an unoccupied tile you
      // can see. We validate range (Chebyshev distance ≤ rangeFeet/5),
      // passability (the target tile must be passable), and that the tile
      // is not occupied by another creature. Failures abort the cast
      // BEFORE consumeCastingResources has returned — but at this point the
      // bonus action is already spent. We log the failure and return; the
      // bonus action remains spent as the SRD penalty for an aborted cast.
      if (!spell.selfTeleport) { ctx.addLog({ left: `${spell.name} is missing selfTeleport metadata`, style: 'miss' }); break; }
      if (!tile) { ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' }); break; }
      const rangeTiles = Math.max(1, Math.ceil(spell.selfTeleport.rangeFeet / 5));
      const dx = Math.abs(tile.x - s.player.tileX);
      const dy = Math.abs(tile.y - s.player.tileY);
      if (Math.max(dx, dy) > rangeTiles) {
        ctx.addLog({ left: `${spell.name} — destination is out of range (${spell.selfTeleport.rangeFeet} ft)`, style: 'miss' });
        break;
      }
      const { cols, rows, blocksMovement } = s.map;
      if (tile.x < 0 || tile.x >= cols || tile.y < 0 || tile.y >= rows || blocksMovement[tile.y][tile.x]) {
        ctx.addLog({ left: `${spell.name} — destination is impassable`, style: 'miss' });
        break;
      }
      const occupied = s.npcs.some((n) => n.hp > 0 && n.tileX === tile.x && n.tileY === tile.y);
      if (occupied) {
        ctx.addLog({ left: `${spell.name} — destination is occupied`, style: 'miss' });
        break;
      }
      const fromX = s.player.tileX;
      const fromY = s.player.tileY;
      s.player.tileX = tile.x;
      s.player.tileY = tile.y;
      ctx.addLog({
        left: `${ctx.playerDef.name} teleports — (${fromX},${fromY}) → (${tile.x},${tile.y})`,
        style: 'status',
      });
      break;
    }
    case 'enhance-ability': {
      // SRD: touch a willing creature, choose Bear's Endurance / Bull's
      // Strength / Cat's Grace / Eagle's Splendor / Fox's Cunning /
      // Owl's Wisdom. The chosen creature gains Advantage on ability
      // checks of the corresponding ability score for the duration.
      // Single-character implementation: self-target only. The
      // `enhanced-ability` modifier is projected onto `s.player.enhancedAbility`
      // by `recomputeBuffs` (which `rollAbilityCheck` reads), and concentration
      // end clears it generically via `removeBuffsForSpell`. The ability pick
      // rides on the cast action's `abilityChoice`; defaults to STR if missing.
      const pick = abilityChoice ?? spell.abilityChoices?.[0] ?? 'str';
      applySelfBuff(ctx, { spellId: spell.id, modifiers: [{ type: 'enhanced-ability', ability: pick }], concentration: true });
      const variant = ENHANCE_ABILITY_VARIANTS[pick] ?? pick.toUpperCase();
      ctx.addLog({ left: `${ctx.playerDef.name} casts Enhance Ability (${variant}) — Advantage on ${pick.toUpperCase()} ability checks`, style: 'status' });
      break;
    }
    default:
      ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name}`, style: 'status' });
  }
}

/**
 * Resolve a player spell cast. Validates eligibility, consumes resources,
 * dispatches to the right resolution branch based on the spell's JSON shape.
 */
/**
 * US-124 — use a Spell Scroll from inventory. Resolves the scroll's spell and
 * casts it via the scroll path (no slot; scroll consumed). Targeting reuses the
 * normal resolver: attack / auto-hit spells fall back to the selected target,
 * self / utility spells need none. (AOE-tile scrolls that need a chosen tile
 * are not yet supported by this no-prompt path.)
 */
/**
 * SRD Enlarge/Reduce — dual-mode. The target's disposition picks the mode:
 *   • self or ally → ENLARGE: grow to Large, Advantage on STR checks (via
 *     `enhanced-ability`) and STR saves, +1d4 weapon damage (`weapon-damage-dice`).
 *     Applied as a self-buff for the caster; an ally target is marked `enlarged`
 *     (the +1d4 only flows through the player's own attacks, so the ally case is
 *     largely descriptive).
 *   • enemy → REDUCE: unwilling, so a CON save negates; on a fail the creature
 *     gains the `reduced` condition → its weapon hits deal 1d4 less
 *     (`npcReducedPenalty`). STR-save Disadvantage is descriptive.
 * Concentration is started only when the spell actually lands. The `reduced` /
 * `enlarged` conditions are stripped on Concentration-end via the spell's
 * `effect.onFail` cleanup list; the caster's self-buff is dropped by the
 * generic buff cleanup.
 */
export function castEnlargeReduce(ctx: GameContext, spell: SpellDef, targetIds: string[] | undefined): void {
  const s = ctx.state;
  const targetId = targetIds?.[0] ?? s.selectedTargetId ?? 'player';
  const onSelf = targetId === 'player';
  const npc = !onSelf ? s.npcs.find((n) => n.id === targetId && n.hp > 0) : undefined;
  if (!onSelf && !npc) { ctx.addLog({ left: `Enlarge/Reduce: no valid target.`, style: 'miss' }); return; }

  const tx = onSelf ? s.player.tileX : npc!.tileX;
  const ty = onSelf ? s.player.tileY : npc!.tileY;
  if (chebyshev(s.player.tileX, s.player.tileY, tx, ty) > Math.max(1, Math.ceil(spell.rangeFeet / 5))) {
    ctx.addLog({ left: `Enlarge/Reduce: target out of range.`, style: 'miss' });
    return;
  }

  const enlarge = onSelf || npc!.disposition === 'ally';
  if (enlarge && onSelf) {
    applySelfBuff(ctx, {
      spellId: 'enlarge-reduce', concentration: true, modifiers: [
        { type: 'size', size: 'large' },
        { type: 'enhanced-ability', ability: 'str' },
        { type: 'advantage', on: 'save', key: 'str' },
        { type: 'weapon-damage-dice', count: 1, sides: 4 },
      ],
    });
    ctx.addLog({ left: `${ctx.playerDef.name} casts Enlarge — grows to Large: Advantage on STR checks & saves, +1d4 weapon damage.`, style: 'status' });
    startConcentration(ctx, 'enlarge-reduce');
  } else if (enlarge) {
    if (!npc!.conditions.includes('enlarged')) npc!.conditions.push('enlarged');
    ctx.addLog({ left: `${ctx.playerDef.name} casts Enlarge on ${combatantDisplayName(npc!, s.npcs)} — it grows to Large.`, style: 'status' });
    startConcentration(ctx, 'enlarge-reduce');
  } else {
    const def = ctx.resolveMonsterDef(npc!.defId);
    if (!def) return;
    const dc = spellSaveDC(ctx);
    const saveMod = (def.savingThrows && def.savingThrows.con !== undefined) ? def.savingThrows.con : mod(def.con);
    const roll = d20();
    const total = roll + saveMod;
    const success = total >= dc;
    ctx.addLog({
      left: `${combatantDisplayName(npc!, s.npcs)} ${success ? 'resists Reduce' : 'is reduced — weapons hit for 1d4 less'}`,
      right: `CON d20(${roll})+${saveMod}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    if (!success) {
      if (!npc!.conditions.includes('reduced')) npc!.conditions.push('reduced');
      startConcentration(ctx, 'enlarge-reduce');
    }
  }
}
