/**
 * TrapSystem — first-class concealed tile traps plus deployable area-denial
 * gear (caltrops, ball bearings).
 *
 * Two distinct hazards live here:
 *
 *   1. Traps (`GameState.traps`) — a concealed hazard on a single tile. It is
 *      noticed via Perception (passive on move, or the Search action), removed
 *      via the Disarm action (Dexterity / Sleight of Hand with Thieves' Tools,
 *      SRD DC 15), or springs when the player steps onto it — rolling a save
 *      for damage (half on save) and an optional condition.
 *
 *   2. Area-denial gear — caltrops / ball bearings deployed onto the map. These
 *      are NOT traps; they create a visible `ActiveZone` (the same primitive
 *      spells use) so they render like a spell effect and appear in tile info.
 *      The zone's `enterSave` / `enterDamage` machinery (SpellSystem) resolves
 *      the SRD "enters the area" save.
 *
 * SRD basis: detect/understand traps — Wisdom (Perception) / Intelligence
 * (Investigation); disarm with Thieves' Tools — DC 15 Dexterity (Sleight of
 * Hand) (Tools.md, Rogue L1). Caltrops — 5-ft square, DC 15 Dex, 1 Piercing +
 * Speed 0; Ball Bearings — 10-ft square, DC 10 Dex, Prone (Adventuring_Gear.md).
 */
import type { GameContext } from './GameContext.js';
import type { GameEvent, LogEntry, TrapState, ActiveZone, GearDef } from './types.js';
import { d, d20, mod } from './Dice.js';
import { chebyshev } from './EnemyAI.js';

/** Passive Perception auto-spots a concealed trap within this Chebyshev range
 *  (~10 ft) as the player moves past — mirrors the hidden-NPC reveal sweep. */
const PASSIVE_TRAP_RANGE_TILES = 2;
/** Default tint for a deployed-gear zone when the gear doesn't specify one. */
const DEFAULT_GEAR_TINT = '#c9a23b';

/** SRD trap save modifier for the player. */
function playerSaveBonus(ctx: GameContext, ability: TrapState['trigger']['saveAbility']): number {
  const abMod = mod(ctx.playerDef[ability]);
  const prof = ctx.playerDef.savingThrowProficiencies.includes(ability) ? ctx.playerDef.proficiencyBonus : 0;
  return abMod + prof;
}

/**
 * The player has just stepped onto a tile — spring any armed trap there.
 * Called from the move flow after the position is committed.
 */
export function checkTrapTriggers(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  const trap = s.traps.find((t) => t.armed && t.tileX === s.player.tileX && t.tileY === s.player.tileY);
  if (trap) springTrapOnPlayer(ctx, trap, events);
}

/** Roll the trap's save for the player and apply damage + condition. The trap
 *  is spent (disarmed) afterwards so it never fires twice. */
export function springTrapOnPlayer(ctx: GameContext, trap: TrapState, events: GameEvent[]): void {
  const s = ctx.state;
  trap.armed = false;
  trap.discovered = true;
  const tr = trap.trigger;

  const saveBonus = playerSaveBonus(ctx, tr.saveAbility);
  const roll = d20();
  const total = roll + saveBonus;
  const success = total >= tr.saveDC;

  let damage = tr.damageBonus;
  for (let i = 0; i < tr.damageDice; i++) damage += d(tr.damageSides);
  const applied = success ? (tr.halfOnSave ? Math.floor(damage / 2) : 0) : damage;

  ctx.addLog({ left: `⚠ ${trap.name}! ${trap.triggeredMessage ?? 'A trap springs!'}`, style: 'header' });
  ctx.addLog({
    left: `${ctx.playerDef.name} ${success ? 'partly avoids' : 'is caught by'} ${trap.name}`,
    right: `${tr.saveAbility.toUpperCase()} d20(${roll})+${saveBonus}=${total} vs DC ${tr.saveDC}`,
    style: success ? 'normal' : 'status',
  });
  if (applied > 0) ctx.applyDamageToPlayer(applied, events);
  if (!success && tr.condition && !s.player.conditions.includes(tr.condition)) {
    s.player.conditions.push(tr.condition);
    ctx.addLog({ left: `${ctx.playerDef.name} is ${tr.condition}.`, style: 'status' });
  }
  ctx.publish({ type: 'custom', name: 'trap_triggered', payload: { trapId: trap.id, tileX: trap.tileX, tileY: trap.tileY } });
}

/**
 * Passive trap detection on player move. Any concealed armed trap within range
 * whose `detectDC` ≤ the player's passive Perception is noticed without a roll.
 * Mirrors `runPassivePerceptionSweep` for hidden NPCs.
 */
export function runPassiveTrapDetection(ctx: GameContext): void {
  const s = ctx.state;
  const passivePP = 10 + (ctx.playerDef.skills['perception'] ?? 0);
  for (const trap of s.traps) {
    if (trap.discovered || !trap.armed) continue;
    if (chebyshev(s.player.tileX, s.player.tileY, trap.tileX, trap.tileY) > PASSIVE_TRAP_RANGE_TILES) continue;
    if (passivePP >= trap.detectDC) {
      trap.discovered = true;
      ctx.addLog({ left: `${ctx.playerDef.name} notices a trap: ${trap.name}.`, style: 'status' });
    }
  }
}

/**
 * Active trap detection folded into the Search action. Uses the single Search
 * d20 roll (Wisdom Perception) against every concealed armed trap adjacent to
 * the player. Returns log lines for the caller to merge into the Search output.
 */
export function detectAdjacentTraps(ctx: GameContext, searchRoll: number): LogEntry[] {
  const s = ctx.state;
  const logs: LogEntry[] = [];
  for (const trap of s.traps) {
    if (trap.discovered || !trap.armed) continue;
    if (chebyshev(s.player.tileX, s.player.tileY, trap.tileX, trap.tileY) > 1) continue;
    if (searchRoll >= trap.detectDC) {
      trap.discovered = true;
      logs.push({ left: `Search (${searchRoll} vs DC ${trap.detectDC}) — found a trap: ${trap.name}`, style: 'hit' });
    }
  }
  return logs;
}

/**
 * Disarm action — remove a discovered, armed trap on an adjacent tile. Rolls
 * Dexterity (Sleight of Hand); Thieves' Tools grant Advantage (SRD: the tools
 * are how you disarm a trap). A botch (missing the DC by 5+) springs the trap.
 */
export function doDisarmTrap(ctx: GameContext, tileX: number, tileY: number, events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
  const trap = s.traps.find((t) => t.tileX === tileX && t.tileY === tileY && t.armed && t.discovered);
  if (!trap) return;
  if (chebyshev(s.player.tileX, s.player.tileY, tileX, tileY) > 1) return;
  // Disarming costs the full Action in combat (SRD Utilize action).
  if (s.phase === 'player_turn') {
    if (s.player.actionUsed) return;
    s.player.actionUsed = true;
  }

  const hasTools = s.player.inventoryIds.includes('thieves_tools');
  const skillMod = ctx.playerDef.skills['sleightOfHand'] ?? 0;
  const r1 = d20();
  const r2 = d20();
  const roll = hasTools ? Math.max(r1, r2) : r1;
  const total = roll + skillMod;
  const success = total >= trap.disarmDC;

  ctx.addLog({
    left: `${ctx.playerDef.name} works to disarm ${trap.name}${hasTools ? " (Thieves' Tools)" : ' (no tools)'}`,
    right: `DEX(Sleight of Hand) ${hasTools ? `adv(${r1},${r2})` : `d20(${roll})`}+${skillMod}=${total} vs DC ${trap.disarmDC}`,
    style: 'header',
  });
  if (success) {
    trap.armed = false;
    ctx.addLog({ left: `${trap.name} is disarmed.`, style: 'hit' });
    ctx.publish({ type: 'custom', name: 'trap_disarmed', payload: { trapId: trap.id } });
  } else if (total <= trap.disarmDC - 5) {
    ctx.addLog({ left: `A slip — ${trap.name} goes off!`, style: 'miss' });
    springTrapOnPlayer(ctx, trap, events);
  } else {
    ctx.addLog({ left: `${trap.name} holds — the mechanism doesn't give. (try again)`, style: 'miss' });
  }
}

/** True when this item is area-denial gear the player can deploy. */
export function isDeployableGear(def: { type: string } | undefined): def is GearDef & { areaDenial: NonNullable<GearDef['areaDenial']> } {
  return !!def && def.type === 'gear' && !!(def as GearDef).areaDenial;
}

/**
 * Deploy area-denial gear (caltrops, ball bearings) onto a tile, creating a
 * persistent `ActiveZone`. The zone renders like a spell effect and shows in
 * tile info; its `enterSave` / `enterDamage` resolve as creatures walk in.
 */
export function doDeployGear(ctx: GameContext, itemId: string, tileX: number, tileY: number, _events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
  const def = ctx.defs.equipment.find((i) => i.id === itemId);
  if (!isDeployableGear(def)) return;
  if (!s.player.inventoryIds.includes(itemId)) return;
  if (tileX < 0 || tileY < 0 || tileX >= s.map.cols || tileY >= s.map.rows) return;
  if (s.map.blocksMovement[tileY][tileX]) return;

  const ad = def.areaDenial;
  const rangeTiles = Math.max(1, Math.ceil(ad.rangeFeet / 5));
  if (chebyshev(s.player.tileX, s.player.tileY, tileX, tileY) > rangeTiles) return;

  // Deploying costs the full Action in combat (SRD Utilize action).
  if (s.phase === 'player_turn') {
    if (s.player.actionUsed) return;
    s.player.actionUsed = true;
  }

  // Consume one unit of the gear.
  const idx = s.player.inventoryIds.indexOf(itemId);
  s.player.inventoryIds.splice(idx, 1);

  const tiles = squareTiles(ctx, tileX, tileY, ad.sizeFeet);
  const zone: ActiveZone = {
    id: ctx.uid(),
    spellId: `gear:${itemId}`,
    name: ad.zoneName,
    shape: 'cube',
    sizeFeet: ad.sizeFeet,
    originX: tileX,
    originY: tileY,
    tiles,
    condition: ad.condition,
    enterSave: ad.enterSave,
    enterDamage: ad.enterDamage,
    difficultTerrain: false,
    affectedNpcIds: [],
    affectedPlayer: false,
    roundsRemaining: Math.max(1, ad.durationRounds),
    casterId: 'player',
    tintHex: ad.tintHex ?? DEFAULT_GEAR_TINT,
  };
  s.activeZones = s.activeZones ?? [];
  s.activeZones.push(zone);
  ctx.addLog({ left: `${ctx.playerDef.name} scatters ${def.name} across ${tiles.length} tile(s).`, style: 'status' });
}

/** Enumerate the tiles of a square area `sizeFeet` on a side, anchored on the
 *  target tile (centred for odd sizes, extending right/down for even — matches
 *  the spell cube convention). Impassable tiles are skipped. */
function squareTiles(ctx: GameContext, cx: number, cy: number, sizeFeet: number): Array<[number, number]> {
  const s = ctx.state;
  const side = Math.max(1, Math.ceil(sizeFeet / 5));
  let x0: number, x1: number, y0: number, y1: number;
  if (side % 2 === 1) {
    const rr = (side - 1) / 2;
    x0 = cx - rr; x1 = cx + rr; y0 = cy - rr; y1 = cy + rr;
  } else {
    x0 = cx; x1 = cx + side - 1; y0 = cy; y1 = cy + side - 1;
  }
  const tiles: Array<[number, number]> = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= s.map.cols || y >= s.map.rows) continue;
      if (s.map.blocksMovement[y][x]) continue;
      tiles.push([x, y]);
    }
  }
  return tiles;
}
