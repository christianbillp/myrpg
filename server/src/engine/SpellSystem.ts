// Generic spell resolver — drives spell casting from the JSON `SpellDef`
// fields rather than per-spell hardcoded logic. Branches on the spell's
// `attack` / `save` / `effect` shape:
//
//   • attack: 'ranged-spell' | 'melee-spell' → roll d20 + PB + spellMod vs AC
//   • attack: 'auto-hit'                     → Magic Missile-style dart spread
//   • save: { ability, halfOnSuccess }       → each target rolls; full/half damage
//   • otherwise                              → utility (no roll); log + flag effect
//
// Damage is routed through ctx.resistMod for resist/vuln/immune handling.
// Cantrip damage scales with character level per SRD ("Cantrip Upgrade").
// Concentration tracking lives in ConcentrationSystem.ts.

import type { GameContext } from './GameContext.js';
import type { GameEvent, NpcState, SpellDef, LogEntry, MonsterDef } from './types.js';
import { d, d20, mod } from './Dice.js';
import { chebyshev } from './EnemyAI.js';
import { canCastSpell } from './ActionGuards.js';
import { startConcentration } from './ConcentrationSystem.js';
import { applyEquipment } from './EquipmentSystem.js';
import { publishNpcDamage } from './ThresholdPublisher.js';
import { combatantDisplayName } from './CombatFlow.js';
import { emitNoise, NOISE_SPELL_VERBAL } from './Sound.js';
import { canSee as visCanSee } from './Vision.js';

/** Cover the target benefits from against the player's spell attack. */
function visCanSeeTargetCover(ctx: GameContext, target: NpcState): 'none' | 'half' | 'three-quarters' | 'total' {
  const v = visCanSee(
    ctx.state,
    { tileX: ctx.state.player.tileX, tileY: ctx.state.player.tileY, senses: ctx.playerDef.senses },
    { tileX: target.tileX, tileY: target.tileY, conditions: target.conditions, id: target.id },
  );
  return v.cover;
}

/** Ability mod for the player's spellcasting ability (defaults to 0 if unset). */
function spellMod(ctx: GameContext): number {
  const ab = ctx.playerDef.spellcastingAbility;
  if (!ab) return 0;
  return mod(ctx.playerDef[ab]);
}

/** Spell save DC = 8 + PB + spellMod. */
export function spellSaveDC(ctx: GameContext): number {
  return 8 + ctx.playerDef.proficiencyBonus + spellMod(ctx);
}

/** Spell attack bonus = PB + spellMod. */
export function spellAttackBonus(ctx: GameContext): number {
  return ctx.playerDef.proficiencyBonus + spellMod(ctx);
}

/**
 * Cantrip damage scaling per SRD: damage dice count increases at character
 * levels 5, 11, and 17. Levelled spells don't scale through this — they
 * scale by being cast in a higher slot (handled in resolve()).
 */
function cantripDiceMultiplier(level: number): number {
  if (level >= 17) return 4;
  if (level >= 11) return 3;
  if (level >= 5)  return 2;
  return 1;
}

function rollDamage(dice: number, sides: number, bonus = 0): { total: number; rolls: number[] } {
  const rolls: number[] = [];
  for (let i = 0; i < dice; i++) rolls.push(d(sides));
  return { total: rolls.reduce((a, b) => a + b, 0) + bonus, rolls };
}

function npcSaveMod(target: NpcState, def: MonsterDef, ability: string): number {
  // Use the monster's saving throw map if present; otherwise raw ability mod.
  if (def.savingThrows && def.savingThrows[ability] !== undefined) return def.savingThrows[ability];
  const score = (def as unknown as Record<string, number>)[ability];
  return typeof score === 'number' ? mod(score) : 0;
}

/**
 * Apply damage to a single NPC, routing through resistMod. Idempotent on
 * already-dead targets — repeated calls do nothing instead of re-firing kill
 * rewards (which would otherwise grant duplicate XP for e.g. extra Magic
 * Missile darts that strike a corpse).
 */
function applyDamageToNpc(
  ctx: GameContext,
  target: NpcState,
  amount: number,
  damageType: string,
): void {
  if (amount <= 0) return;
  if (target.hp <= 0) return;
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return;
  const { finalDamage, log: resistLog } = ctx.resistMod(amount, damageType, def, target.name);
  if (resistLog) ctx.addLog(resistLog);
  const hpBefore = target.hp;
  target.hp = Math.max(0, target.hp - finalDamage);
  publishNpcDamage(ctx, target, hpBefore, target.hp);
  if (target.hp <= 0) ctx.killWithReward(target, def, `☠ ${combatantDisplayName(target, ctx.state.npcs)} is slain!`);
}

// ── Action-economy + slot consumption ────────────────────────────────────────

function consumeCastingResources(ctx: GameContext, spell: SpellDef, slotLevel: number, asRitual: boolean): void {
  const s = ctx.state;
  // Ritual casts don't consume a spell slot (SRD: the spell is cast over 10
  // minutes from the spellbook). They also don't spend the action/bonus
  // action — they're a fictional time cost, only legal out of combat.
  if (asRitual) return;
  if (spell.level > 0) {
    s.player.spellSlots[spell.level - 1] = Math.max(0, (s.player.spellSlots[spell.level - 1] ?? 0) - 1);
  }
  // We don't gate by slotLevel here — the picker passes spell.level by default;
  // upcast support is wired in but not yet exposed by the UI.
  if (s.phase === 'player_turn') {
    switch (spell.castingTime) {
      case 'action':       s.player.actionUsed = true; break;
      case 'bonus-action': s.player.bonusActionUsed = true; break;
      case 'reaction':     s.player.reactionUsed = true; break;
    }
  }
  void slotLevel;
}

// ── Resolution branches ─────────────────────────────────────────────────────

function resolveAttackRollSpell(
  ctx: GameContext,
  spell: SpellDef,
  target: NpcState,
  slotLevel: number,
): boolean {
  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return false;
  if (!spell.damage) return false;

  // SRD cover for spell attack rolls. Total cover blocks the cast entirely
  // before any roll happens — refunds nothing (the slot was already
  // consumed by consumeCastingResources, which mirrors the player's choice
  // to commit). The defender's cover bonus stacks onto effective AC.
  const visionCover = visCanSeeTargetCover(ctx, target);
  if (visionCover === 'total') {
    ctx.addLog({
      left: `${ctx.playerDef.name} casts ${spell.name} — ${combatantDisplayName(target, ctx.state.npcs)} is behind total cover`,
      style: 'miss',
    });
    return false;
  }
  const coverAcBonus = visionCover === 'three-quarters' ? 5 : visionCover === 'half' ? 2 : 0;
  const effectiveAc = def.ac + coverAcBonus;

  const bonus = spellAttackBonus(ctx);
  const roll = d20();
  const isCrit = roll === 20;
  const total = roll + bonus;
  const hit = isCrit || (roll !== 1 && total >= effectiveAc);
  const coverNote = coverAcBonus > 0 ? ` (+${coverAcBonus} cover)` : '';

  if (!hit) {
    ctx.addLog({
      left: `${ctx.playerDef.name} casts ${spell.name} at ${combatantDisplayName(target, ctx.state.npcs)} — miss`,
      right: `d20(${roll})+${bonus}=${total} vs AC ${effectiveAc}${coverNote}`,
      style: 'miss',
    });
    return false;
  }

  // Cantrip scaling: extra dice at character L5/11/17. Leveled spells get
  // upcast bonus dice via slotLevel > spell.level (one extra die per level
  // above base for damage-cantrip-shaped attacks; we apply a generic +1d
  // per upcast tier as a placeholder — Aelar is L1 so it doesn't trigger).
  const dieMult = spell.level === 0 ? cantripDiceMultiplier(ctx.playerDef.level) : 1;
  const upcastBonus = Math.max(0, slotLevel - spell.level);
  const baseDice = spell.damage.dice * dieMult + upcastBonus;
  const dice = isCrit ? baseDice * 2 : baseDice;
  const { total: dmg, rolls } = rollDamage(dice, spell.damage.sides, spell.damage.bonus ?? 0);

  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} — ${isCrit ? 'CRIT' : 'hit'}, ${dmg} ${spell.damage.type}`,
    right: `d20(${roll})+${bonus}=${total} vs AC ${effectiveAc}${coverNote} · ${dice}d${spell.damage.sides}[${rolls.join(',')}]`,
    style: isCrit ? 'crit' : 'hit',
  });
  applyDamageToNpc(ctx, target, dmg, spell.damage.type);

  // Riders (Ray of Frost slow) — engine-side recognition by spell id, kept
  // short to avoid sprawling per-spell logic.
  if (spell.id === 'ray-of-frost') {
    if (!target.conditions.includes('slowed')) target.conditions.push('slowed');
    ctx.addLog({ left: `${combatantDisplayName(target, ctx.state.npcs)} is slowed (Speed −10 ft until end of next turn)`, style: 'status' });
  }
  return true;
}

function resolveAutoHitSpell(
  ctx: GameContext,
  spell: SpellDef,
  targetIds: string[],
  slotLevel: number,
): boolean {
  if (!spell.damage || !spell.darts) return false;
  const s = ctx.state;
  const darts = spell.darts + Math.max(0, slotLevel - spell.level);

  // Distribute darts: if no targetIds given, fire all at first selected target.
  // If fewer targetIds than darts, extras pile onto the LAST one (caller's choice).
  const assignments: NpcState[] = [];
  if (targetIds.length === 0) {
    const t = s.npcs.find((n) => n.id === s.selectedTargetId && n.hp > 0 && n.disposition !== 'ally');
    if (!t) return false;
    for (let i = 0; i < darts; i++) assignments.push(t);
  } else {
    // Round-robin then pile on last.
    for (let i = 0; i < darts; i++) {
      const id = targetIds[Math.min(i, targetIds.length - 1)];
      const t = s.npcs.find((n) => n.id === id && n.hp > 0 && n.disposition !== 'ally');
      if (t) assignments.push(t);
    }
  }

  if (assignments.length === 0) return false;

  // SRD: all darts strike simultaneously. Pool damage per target so a single
  // application resolves the entire spell — prevents duplicate kill rewards
  // when 2+ darts target the same creature.
  const perTarget = new Map<string, { target: NpcState; darts: number; total: number }>();
  for (const target of assignments) {
    const { total } = rollDamage(spell.damage.dice, spell.damage.sides, spell.damage.bonus ?? 0);
    const acc = perTarget.get(target.id) ?? { target, darts: 0, total: 0 };
    acc.darts += 1;
    acc.total += total;
    perTarget.set(target.id, acc);
  }

  let grandTotal = 0;
  for (const { target, total } of perTarget.values()) {
    grandTotal += total;
    applyDamageToNpc(ctx, target, total, spell.damage.type);
  }
  const summary = [...perTarget.values()].map((v) => `${combatantDisplayName(v.target, ctx.state.npcs)}×${v.darts}`).join(', ');
  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} → ${summary} (${grandTotal} ${spell.damage.type})`,
    right: `${darts} darts × 1d${spell.damage.sides}+${spell.damage.bonus ?? 0}`,
    style: 'hit',
  });
  return true;
}

/**
 * Compute the set of tile coordinates affected by a cone of `lengthTiles`
 * originating at `(ox, oy)` pointing toward `(targetX, targetY)`. Models a
 * D&D 5e cone (length = base diameter, ~53° total angle): at distance d along
 * the cone's axis, tiles within perpendicular distance ≤ d/2 + 0.5 are in.
 * Returns "x,y" strings for O(1) membership lookup.
 */
function coneTileSet(
  ox: number, oy: number,
  targetX: number, targetY: number,
  lengthTiles: number,
): Set<string> {
  let dx = targetX - ox;
  let dy = targetY - oy;
  const len = Math.hypot(dx, dy);
  if (len === 0) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
  const out = new Set<string>();
  for (let ry = -lengthTiles; ry <= lengthTiles; ry++) {
    for (let rx = -lengthTiles; rx <= lengthTiles; rx++) {
      if (rx === 0 && ry === 0) continue;                      // skip origin
      const along = rx * dx + ry * dy;                         // signed scalar projection
      if (along <= 0 || along > lengthTiles + 0.5) continue;
      const perp = Math.abs(-rx * dy + ry * dx);               // perpendicular distance
      if (perp > along * 0.5 + 0.5) continue;                  // cone half-angle ~27°
      out.add(`${ox + rx},${oy + ry}`);
    }
  }
  return out;
}

/**
 * Tile-side count for a sphere or cube area.
 *
 *   Sphere: `area.sizeFeet` is the **radius**, so the grid footprint is
 *           `2 * sizeFeet / 5` tiles on a side (5 ft Sleep → 2 × 2 = 4 cells,
 *           20 ft Fog Cloud → 8 × 8).
 *   Cube:   `area.sizeFeet` is the **side length**, so the footprint is
 *           `sizeFeet / 5` tiles on a side (15 ft Thunderwave → 3 × 3,
 *           10 ft Grease → 2 × 2).
 */
function spellSideTiles(spell: SpellDef): number {
  const sizeFeet = spell.area?.sizeFeet ?? 5;
  if (spell.area?.shape === 'sphere') return Math.max(1, Math.ceil(2 * sizeFeet / 5));
  return Math.max(1, Math.ceil(sizeFeet / 5));
}

/**
 * Tiles covered by a sphere/cube area when the clicked tile is `(cx, cy)`.
 *
 *   • Odd side count: the clicked tile is the centre, area is a chebyshev
 *     disc of radius `(sideTiles − 1) / 2`.
 *   • Even side count: the clicked tile is the **top-left** of the area;
 *     the rest extends right + down by `sideTiles − 1`. Fixed orientation
 *     keeps cursor movement smooth — moving the cursor one tile shifts the
 *     area one tile, with no mirroring across the caster's axis. The
 *     "extend away from caster" rule we used earlier caused the area to
 *     jump by 2 tiles whenever the cursor crossed the caster's row / column.
 */
function rectAreaCells(
  _ctx: GameContext,
  sideTiles: number,
  cx: number,
  cy: number,
): { xMin: number; xMax: number; yMin: number; yMax: number } {
  if (sideTiles % 2 === 1) {
    const r = (sideTiles - 1) / 2;
    return { xMin: cx - r, xMax: cx + r, yMin: cy - r, yMax: cy + r };
  }
  const offset = sideTiles - 1;
  return { xMin: cx, xMax: cx + offset, yMin: cy, yMax: cy + offset };
}

/**
 * Living non-player creatures in a spell's area, computed from the spell's
 * `area.shape`. Cones key off (player tile → target tile) direction; spheres
 * and cubes use the tile-side helpers above. Includes allies — AOE spells
 * like Burning Hands are indiscriminate per SRD.
 */
function creaturesInArea(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
): NpcState[] {
  const s = ctx.state;

  if (spell.area?.shape === 'cone') {
    const radiusTiles = Math.max(1, Math.ceil((spell.area?.sizeFeet ?? 5) / 5));
    // Cone origins at the caster's tile (self-range — the only shape we ship
    // today); direction comes from the `tile` payload.
    const tx = tile?.x ?? s.player.tileX + 1;
    const ty = tile?.y ?? s.player.tileY;
    const inCone = coneTileSet(s.player.tileX, s.player.tileY, tx, ty, radiusTiles);
    return s.npcs.filter((n) => n.hp > 0 && inCone.has(`${n.tileX},${n.tileY}`));
  }

  // Sphere / cube.
  const cx = spell.range === 'self' ? s.player.tileX : (tile?.x ?? s.player.tileX);
  const cy = spell.range === 'self' ? s.player.tileY : (tile?.y ?? s.player.tileY);
  const sideTiles = spellSideTiles(spell);
  const { xMin, xMax, yMin, yMax } = rectAreaCells(ctx, sideTiles, cx, cy);
  return s.npcs.filter((n) =>
    n.hp > 0 && n.tileX >= xMin && n.tileX <= xMax && n.tileY >= yMin && n.tileY <= yMax,
  );
}

/**
 * Normalise `SpellEffect.onFail` (which the schema allows as either a single
 * string or an array of strings) to a plain list of condition names.
 */
function normaliseConditionList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

/**
 * Flavour line for a failed save. Recognises a handful of spells with
 * iconic narration; falls back to a generic "is &lt;condition&gt;" / "is affected"
 * for everything else.
 */
function conditionLogText(spell: SpellDef, conds: string[]): string {
  if (conds.length === 0) return 'is affected';
  if (spell.id === 'hideous-laughter') return 'collapses, helpless with laughter';
  if (spell.id === 'sleep')            return 'falls into a magical slumber';
  if (spell.id === 'charm-person')     return 'is charmed';
  return 'is ' + conds.join(' and ');
}

function resolveSaveSpell(
  ctx: GameContext,
  spell: SpellDef,
  tile: { x: number; y: number } | undefined,
  slotLevel: number,
  selectedIds?: string[],
): boolean {
  if (!spell.save) return false;
  const dc = spellSaveDC(ctx);

  let targets = creaturesInArea(ctx, spell, tile);

  // SRD "creature of your choice" spells (Sleep) pair the AOE click with a
  // second-step picker — the client sends the chosen ids in `selectedIds`,
  // and only those are saved against. When the picker isn't used (default
  // path or non-selective AOEs), every creature in the area is targeted.
  if (spell.area?.creaturesOfYourChoice && selectedIds) {
    const allowed = new Set(selectedIds);
    targets = targets.filter((n) => allowed.has(n.id));
  }

  if (targets.length === 0) {
    ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name} — no creatures in area`, style: 'miss' });
    return false;
  }

  // Damage roll — scale dice for cantrip level or upcast slot. SRD says save-
  // based damage spells are rolled ONCE and split — we do the same.
  const upcastBonus = Math.max(0, slotLevel - spell.level);
  const dieMult = spell.level === 0 ? cantripDiceMultiplier(ctx.playerDef.level) : 1;
  let dmgRoll: { total: number; rolls: number[] } | null = null;
  if (spell.damage) {
    const dice = spell.damage.dice * dieMult + upcastBonus;
    dmgRoll = rollDamage(dice, spell.damage.sides, spell.damage.bonus ?? 0);
  }

  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} (${spell.save.ability.toUpperCase()} save DC ${dc})`,
    right: dmgRoll && spell.damage ? `${spell.damage.dice * dieMult + upcastBonus}d${spell.damage.sides}[${dmgRoll.rolls.join(',')}]=${dmgRoll.total}` : '',
    style: 'header',
  });

  let anyAffected = false;
  for (const target of targets) {
    const def = ctx.resolveMonsterDef(target.defId);
    if (!def) continue;
    const saveBonus = npcSaveMod(target, def, spell.save.ability);
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;

    if (dmgRoll && spell.damage) {
      const dmg = success && spell.save.halfOnSuccess ? Math.floor(dmgRoll.total / 2) : success ? 0 : dmgRoll.total;
      ctx.addLog({
        left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'saves' : 'fails'} — ${dmg} ${spell.damage.type}`,
        right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
        style: success ? 'normal' : 'hit',
      });
      applyDamageToNpc(ctx, target, dmg, spell.damage.type);
      if (dmg > 0) anyAffected = true;
    } else if (spell.effect) {
      // Pure condition save (Sleep). `onFail` may be a single condition or an
      // array — Hideous Laughter applies both Prone and Incapacitated.
      const conds = !success ? normaliseConditionList(spell.effect.onFail) : [];
      for (const c of conds) {
        if (!target.conditions.includes(c)) target.conditions.push(c);
      }
      ctx.addLog({
        left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : conditionLogText(spell, conds)}`,
        right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
        style: success ? 'normal' : 'status',
      });
      if (!success && conds.length > 0) anyAffected = true;
    }
  }
  return anyAffected;
}

/**
 * Single-target save spell (Hideous Laughter, Charm Person, …). The caller
 * has already validated target + range; we just roll the save and apply the
 * effect / damage to the one creature.
 */
function resolveSingleTargetSaveSpell(
  ctx: GameContext,
  spell: SpellDef,
  target: NpcState,
  slotLevel: number,
): boolean {
  if (!spell.save) return false;
  const dc = spellSaveDC(ctx);

  const def = ctx.resolveMonsterDef(target.defId);
  if (!def) return false;
  const saveBonus = npcSaveMod(target, def, spell.save.ability);
  const roll = d20();
  const total = roll + saveBonus;
  const success = total >= dc;

  const upcastBonus = Math.max(0, slotLevel - spell.level);
  const dieMult = spell.level === 0 ? cantripDiceMultiplier(ctx.playerDef.level) : 1;
  let dmgRoll: { total: number; rolls: number[] } | null = null;
  if (spell.damage) {
    const dice = spell.damage.dice * dieMult + upcastBonus;
    dmgRoll = rollDamage(dice, spell.damage.sides, spell.damage.bonus ?? 0);
  }

  ctx.addLog({
    left: `${ctx.playerDef.name} casts ${spell.name} on ${combatantDisplayName(target, ctx.state.npcs)} (${spell.save.ability.toUpperCase()} save DC ${dc})`,
    right: dmgRoll && spell.damage ? `${spell.damage.dice * dieMult + upcastBonus}d${spell.damage.sides}[${dmgRoll.rolls.join(',')}]=${dmgRoll.total}` : '',
    style: 'header',
  });

  if (dmgRoll && spell.damage) {
    const dmg = success && spell.save.halfOnSuccess ? Math.floor(dmgRoll.total / 2) : success ? 0 : dmgRoll.total;
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'saves' : 'fails'} — ${dmg} ${spell.damage.type}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'hit',
    });
    applyDamageToNpc(ctx, target, dmg, spell.damage.type);
    return dmg > 0;
  } else if (spell.effect) {
    const conds = !success ? normaliseConditionList(spell.effect.onFail) : [];
    for (const c of conds) {
      if (!target.conditions.includes(c)) target.conditions.push(c);
    }
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : conditionLogText(spell, conds)}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    return !success && conds.length > 0;
  } else {
    // Pure narrative single-target save (Charm Person, Hideous Laughter). The
    // outcome is logged but no engine-tracked condition is set yet — content
    // can wire one via spell.effect.onFail when needed.
    ctx.addLog({
      left: `${combatantDisplayName(target, ctx.state.npcs)} ${success ? 'resists' : 'is affected'}`,
      right: `d20(${roll})+${saveBonus}=${total} vs DC ${dc}`,
      style: success ? 'normal' : 'status',
    });
    return !success;
  }
}

function resolveUtilitySpell(ctx: GameContext, spell: SpellDef): void {
  // No roll; just narrate. Specific lasting effects (Mage Armor, Shield as
  // reaction) handled by spell-id switch — kept here, not as separate files,
  // since each is one-line semantic flag flips.
  const s = ctx.state;
  switch (spell.id) {
    case 'mage-armor':
      // Self/touch: target self (the only valid target without an ally system).
      if (s.player.equippedSlots.armorId) {
        ctx.addLog({ left: `Mage Armor fizzles — already wearing armor`, style: 'miss' });
        return;
      }
      s.player.mageArmor = true;
      applyEquipment(ctx.playerDef, s.player.equippedSlots, ctx.defs.equipment, true);
      s.player.ac = ctx.playerDef.ac;
      ctx.addLog({ left: `${ctx.playerDef.name} casts Mage Armor — AC ${ctx.playerDef.ac} for 8 hours`, style: 'status' });
      break;
    case 'detect-magic':
      ctx.addLog({ left: `${ctx.playerDef.name} casts Detect Magic — senses magical effects within 30 ft`, style: 'status' });
      break;
    case 'feather-fall':
      ctx.addLog({ left: `${ctx.playerDef.name} casts Feather Fall`, style: 'status' });
      break;
    case 'shield':
      // Shield is a reaction interrupt — handled in ReactionSystem; if the
      // player triggers it through the CAST button outside that flow, log a no-op.
      ctx.addLog({ left: `Shield can only be cast as a Reaction to an incoming attack`, style: 'miss' });
      break;
    default:
      ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name}`, style: 'status' });
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** A spell is "aggressive" if it can damage or impose a harmful condition on a creature. */
function isAggressiveSpell(spell: SpellDef): boolean {
  return !!(spell.attack || spell.damage || spell.save || spell.darts);
}

/**
 * If we're in exploring phase and the cast is aggressive, promote any neutral
 * targets to enemy, aggro their faction, and start combat — mirroring the
 * behaviour of the ATTACK button. Returns the list of affected NPCs so the
 * caller doesn't have to recompute them.
 */
function maybeAggroOnCast(
  ctx: GameContext,
  spell: SpellDef,
  targetIds: string[] | undefined,
  tile: { x: number; y: number } | undefined,
  events: GameEvent[],
): NpcState[] {
  const s = ctx.state;
  if (s.phase !== 'exploring') return [];
  if (!isAggressiveSpell(spell)) return [];

  // Identify the non-ally NPCs affected by the cast. Attack-roll and
  // single-target save spells (Hideous Laughter, Charm Person) key off the
  // selected creature; AOE save spells use the area sweep.
  let affected: NpcState[] = [];
  if (spell.attack === 'ranged-spell' || spell.attack === 'melee-spell' || spell.attack === 'auto-hit'
    || (spell.save && !spell.area)) {
    const ids = targetIds && targetIds.length > 0 ? targetIds : (s.selectedTargetId ? [s.selectedTargetId] : []);
    affected = ids
      .map((id) => s.npcs.find((n) => n.id === id))
      .filter((n): n is NpcState => !!n && n.hp > 0 && n.disposition !== 'ally');
  } else if (spell.save) {
    // For aggro-trigger purposes we still filter to non-allies — allies in the
    // area take damage in the resolver but don't influence faction aggro.
    affected = creaturesInArea(ctx, spell, tile).filter((n) => n.disposition !== 'ally');
  }

  if (affected.length === 0) return [];

  // Promote any neutrals → enemy and assign combat labels.
  for (const npc of affected) {
    if (npc.disposition === 'neutral') {
      npc.disposition = 'enemy';
      if (!npc.combatLabel) ctx.assignCombatLabel(npc);
    }
  }
  // Aggro shared-faction neutrals on the first promoted target (matches doAttack).
  ctx.aggroFaction(affected[0]);
  ctx.doStartCombat(events);
  return affected;
}

/**
 * Resolve a player spell cast. Validates eligibility, consumes resources,
 * dispatches to the right resolution branch based on the spell's JSON shape.
 */
export function doCastSpell(
  ctx: GameContext,
  spellId: string,
  slotLevel: number,
  targetIds: string[] | undefined,
  tile: { x: number; y: number } | undefined,
  asRitual: boolean,
  events: GameEvent[],
  damageTypeChoice?: string,
): void {
  const baseSpell = ctx.defs.spells.find((sp) => sp.id === spellId);
  if (!baseSpell) return;

  // Spells that let the caster pick a damage type at cast time (Chromatic
  // Orb, …) carry a `damageTypeChoices` list. Apply the player's choice by
  // swapping `damage.type` on a shallow clone so the rest of the resolver
  // doesn't need a per-call override path.
  let spell = baseSpell;
  if (baseSpell.damageTypeChoices && baseSpell.damageTypeChoices.length > 0 && baseSpell.damage) {
    const fallback = baseSpell.damage.type;
    const picked = damageTypeChoice && baseSpell.damageTypeChoices.includes(damageTypeChoice)
      ? damageTypeChoice
      : fallback;
    spell = { ...baseSpell, damage: { ...baseSpell.damage, type: picked } };
  }

  // Ritual casting has its own eligibility rules: spell must have the Ritual
  // tag, must be known (spellbook OR cantrip — cantrips can't really be cast
  // as rituals but we don't gate on level here), and it can only happen
  // outside combat (10-minute fictional cast). It does NOT require the spell
  // be prepared, and it does NOT consume a slot.
  if (asRitual) {
    if (!spell.ritual) { ctx.addLog({ left: `${spell.name} cannot be cast as a ritual`, style: 'miss' }); return; }
    if (ctx.state.phase !== 'exploring') { ctx.addLog({ left: `Ritual casting requires 10 minutes — not possible in combat`, style: 'miss' }); return; }
    const known = ctx.playerDef.defaultSpellbookIds?.includes(spellId)
      ?? ctx.playerDef.defaultCantripIds?.includes(spellId);
    if (!known) { ctx.addLog({ left: `${spell.name} is not in your spellbook`, style: 'miss' }); return; }
  } else if (!canCastSpell(ctx, spellId)) {
    return;
  }

  // ── Pre-cast validation — bail BEFORE consuming any slot/action ───────────
  // For attack-roll spells, resolve target and range up front; for AOE spells
  // there's no useful pre-check (any tile is valid; empty-area is the caller's
  // own miss). If a check fails here we return silently — no slot spent, no
  // action used.
  let preResolvedTarget: NpcState | null = null;
  if (spell.attack === 'ranged-spell' || spell.attack === 'melee-spell') {
    const tid = targetIds?.[0] ?? ctx.state.selectedTargetId;
    if (!tid) { ctx.addLog({ left: `${spell.name}: no target`, style: 'miss' }); return; }
    const target = ctx.state.npcs.find((n) => n.id === tid && n.hp > 0 && n.disposition !== 'ally');
    if (!target) { ctx.addLog({ left: `${spell.name}: invalid target`, style: 'miss' }); return; }
    const dist = chebyshev(ctx.state.player.tileX, ctx.state.player.tileY, target.tileX, target.tileY);
    if (dist > Math.max(1, Math.ceil(spell.rangeFeet / 5))) {
      ctx.addLog({ left: `${spell.name}: target out of range`, style: 'miss' });
      return;
    }
    preResolvedTarget = target;
  } else if (spell.attack === 'auto-hit') {
    const tid = targetIds?.[0] ?? ctx.state.selectedTargetId;
    const target = tid ? ctx.state.npcs.find((n) => n.id === tid && n.hp > 0 && n.disposition !== 'ally') : null;
    if (!target) { ctx.addLog({ left: `${spell.name}: no target`, style: 'miss' }); return; }
    preResolvedTarget = target;
  } else if (spell.save && !spell.area) {
    // Single-target save spell (Hideous Laughter, Charm Person, …).
    // Validate target + range up front so we don't consume a slot / action on
    // a no-target cast or an out-of-range pick.
    const tid = targetIds?.[0] ?? ctx.state.selectedTargetId;
    const target = tid ? ctx.state.npcs.find((n) => n.id === tid && n.hp > 0 && n.disposition !== 'ally') : null;
    if (!target) { ctx.addLog({ left: `${spell.name}: no target`, style: 'miss' }); return; }
    const dist = chebyshev(ctx.state.player.tileX, ctx.state.player.tileY, target.tileX, target.tileY);
    if (dist > Math.max(1, Math.ceil(spell.rangeFeet / 5))) {
      ctx.addLog({ left: `${spell.name}: target out of range`, style: 'miss' });
      return;
    }
    preResolvedTarget = target;
  }

  // Aggressive casts in exploring phase trigger combat first — same as the
  // ATTACK button. Neutrals turn enemy before the spell resolves so attack
  // rolls and area effects see them as valid hostiles.
  maybeAggroOnCast(ctx, spell, targetIds, tile, events);

  consumeCastingResources(ctx, spell, slotLevel, asRitual);

  // SRD: a spell with a Verbal component spoken aloud breaks Hide on the
  // caster. We emit a `noise` event at the caster's tile; the Sound bus
  // subscriber will clear the hide. Subtle Spell / silent-cast metamagic
  // would later set `components.verbal = false` to suppress this.
  if (spell.components.verbal) {
    emitNoise(ctx, ctx.state.player.tileX, ctx.state.player.tileY, NOISE_SPELL_VERBAL, 'player');
  }

  // Summon spells (Mage Hand, Unseen Servant) take the AOE-click tile and
  // conjure the spell's `summon.monsterId` there. Handled before the
  // mechanical-shape branch since these are neither attack rolls nor saves.
  if (spell.summon) {
    if (!tile) {
      ctx.addLog({ left: `${spell.name}: no target tile`, style: 'miss' });
      return;
    }
    const dist = chebyshev(ctx.state.player.tileX, ctx.state.player.tileY, tile.x, tile.y);
    if (dist > Math.max(1, Math.ceil(spell.rangeFeet / 5))) {
      ctx.addLog({ left: `${spell.name}: target tile out of range`, style: 'miss' });
      return;
    }
    const summoned = ctx.spawnSummon(spell.summon.monsterId, spell.id, tile.x, tile.y);
    if (!summoned) {
      ctx.addLog({ left: `${spell.name}: no space to summon`, style: 'miss' });
      return;
    }
    ctx.addLog({ left: `${ctx.playerDef.name} casts ${spell.name} — ${summoned.name} appears`, style: 'status' });
    return;
  }

  // Branch by mechanical shape; each resolver returns whether the spell
  // actually produced a lasting effect (any target affected, damage dealt,
  // etc.) so we can suppress concentration on a "spell fizzled" outcome.
  let anyEffect = false;
  if (spell.attack === 'ranged-spell' || spell.attack === 'melee-spell') {
    anyEffect = preResolvedTarget
      ? resolveAttackRollSpell(ctx, spell, preResolvedTarget, slotLevel)
      : false;
  } else if (spell.attack === 'auto-hit') {
    anyEffect = resolveAutoHitSpell(ctx, spell, targetIds ?? [], slotLevel);
  } else if (spell.save) {
    if (preResolvedTarget) {
      anyEffect = resolveSingleTargetSaveSpell(ctx, spell, preResolvedTarget, slotLevel);
    } else {
      anyEffect = resolveSaveSpell(ctx, spell, tile, slotLevel, targetIds);
    }
  } else {
    // Utility / self spells (Mage Armor, Detect Magic, …) always produce
    // their effect by definition — they don't roll for it.
    resolveUtilitySpell(ctx, spell);
    anyEffect = true;
  }

  // Concentration only kicks in after a real effect lands — every target
  // saved or the spell missed → no ongoing effect → no concentration cost.
  // A new concentration spell drops any previous one first.
  if (spell.concentration && anyEffect) startConcentration(ctx, spell.id);
}

// Export labels useful for the UI.
export function spellLabel(spell: SpellDef): string {
  return spell.level === 0 ? `${spell.name} (cantrip)` : `${spell.name} (L${spell.level})`;
}

// Expose a simple "log opener" for narrative GM hooks if needed later.
function _logOpenerStub(_log: LogEntry): void { /* intentionally empty */ }
void _logOpenerStub;
