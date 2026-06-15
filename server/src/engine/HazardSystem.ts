/**
 * Environmental hazards (Tactical Crucible #32) — spreading fire, pools of acid,
 * collapsing floors. A hazard is an `ActiveZone` carrying a `hazard` payload, so
 * it reuses the zone tint rendering on the client; here it gains a per-round
 * tick that **damages** creatures in its tiles and optionally **spreads**.
 *
 * The battlefield becomes a weapon: shove or kick a foe into the fire (via the
 * improvised-action / move tools), or just keep clear of the spreading flames.
 *
 * `tickHazardZones` runs once per combat round (from `enterPlayerTurn`, alongside
 * the spell-zone tick). `registerHazardZone` is the authoring entry point — used
 * by the `spawn_hazard` trigger action (and any AIGM/encounter that drops a
 * hazard, e.g. a toppled brazier).
 */
import type { GameContext } from './GameContext.js';
import type { GameEvent, ActiveZone, NpcState } from './types.js';
import { rollDamage, applyDamageToNpc } from './SpellPrimitives.js';
import { playerSaveVsDc } from './NpcSpellcasting.js';
import { npcSaveMod } from './CombatSystem.js';
import { d20 } from './Dice.js';
import { combatantDisplayName } from './DisplayNames.js';

type Hazard = NonNullable<ActiveZone['hazard']>;

/** Damage everything standing in each hazard, then grow the spreading ones.
 *  Called once per combat round. */
export function tickHazardZones(ctx: GameContext, events: GameEvent[]): void {
  const zones = ctx.state.activeZones;
  if (!zones || zones.length === 0) return;
  for (const z of zones) {
    if (z.hazard) tickOneHazard(ctx, z, z.hazard, events);
  }
}

function inZone(z: ActiveZone, x: number, y: number): boolean {
  return z.tiles.some(([tx, ty]) => tx === x && ty === y);
}

function tickOneHazard(ctx: GameContext, z: ActiveZone, h: Hazard, events: GameEvent[]): void {
  const s = ctx.state;

  // Player.
  if (s.player.hp > 0 && inZone(z, s.player.tileX, s.player.tileY)) {
    const raw = rollDamage(h.dice, h.sides, h.bonus ?? 0).total;
    if (h.saveAbility && h.saveDC) {
      ctx.addLog({ left: `${ctx.playerDef.name} is caught in the ${z.name}!`, style: 'miss' });
      playerSaveVsDc(ctx, h.saveAbility, h.saveDC, raw, h.damageType, !!h.halfOnSave, events);
    } else {
      ctx.addLog({ left: `The ${z.name} sears ${ctx.playerDef.name} — ${raw} ${h.damageType}`, style: 'miss' });
      ctx.applyDamageToPlayer(raw, events, h.damageType);
    }
  }

  // NPCs (a snapshot — applyDamageToNpc may remove the dying).
  for (const npc of [...s.npcs]) {
    if (npc.hp <= 0 || !inZone(z, npc.tileX, npc.tileY)) continue;
    const def = ctx.resolveMonsterDef(npc.defId);
    if (!def) continue;
    const raw = rollDamage(h.dice, h.sides, h.bonus ?? 0).total;
    let dmg = raw;
    if (h.saveAbility && h.saveDC) {
      const mod = npcSaveMod(npc, def, h.saveAbility);
      const roll = d20();
      const success = roll + mod >= h.saveDC;
      dmg = success ? (h.halfOnSave ? Math.floor(raw / 2) : 0) : raw;
      ctx.addLog({
        left: `${combatantDisplayName(npc, s.npcs)} ${success ? 'saves' : 'fails'} vs the ${z.name} — ${dmg} ${h.damageType}`,
        right: `${h.saveAbility.toUpperCase()} d20(${roll})+${mod} vs DC ${h.saveDC}`,
        style: success ? 'status' : 'miss',
      });
    } else {
      ctx.addLog({ left: `The ${z.name} sears ${combatantDisplayName(npc, s.npcs)} — ${dmg} ${h.damageType}`, style: 'miss' });
    }
    applyDamageToNpc(ctx, npc, dmg, h.damageType);
  }

  if (h.spreads) spreadHazard(ctx, z, h);
}

/** Grow a spreading hazard by one ring of orthogonally-adjacent passable tiles
 *  (fire racing across the floor; it doesn't cross walls), capped by `maxTiles`. */
function spreadHazard(ctx: GameContext, z: ActiveZone, h: Hazard): void {
  const { cols, rows, blocksMovement } = ctx.state.map;
  const max = h.maxTiles ?? 24;
  if (z.tiles.length >= max) return;
  const set = new Set(z.tiles.map(([x, y]) => `${x},${y}`));
  const added: Array<[number, number]> = [];
  for (const [x, y] of z.tiles) {
    if (set.size >= max) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (blocksMovement[ny][nx]) continue;
      const k = `${nx},${ny}`;
      if (set.has(k)) continue;
      set.add(k);
      added.push([nx, ny]);
      if (set.size >= max) break;
    }
  }
  if (added.length > 0) {
    z.tiles.push(...added);
    ctx.addLog({ left: `The ${z.name} spreads!`, style: 'status' });
  }
}

export interface HazardSpec {
  x: number;
  y: number;
  /** Radius in feet (chebyshev disc); ≤5 ft = the single anchor tile. */
  sizeFeet?: number;
  name?: string;
  tintHex?: string;
  dice: number;
  sides: number;
  bonus?: number;
  damageType: string;
  saveAbility?: Hazard['saveAbility'];
  saveDC?: number;
  halfOnSave?: boolean;
  spreads?: boolean;
  maxTiles?: number;
  /** Rounds the hazard burns before going out; omitted = persists for the fight. */
  rounds?: number;
}

/** Register a battlefield hazard as an `ActiveZone`. */
export function registerHazardZone(ctx: GameContext, spec: HazardSpec): ActiveZone {
  const s = ctx.state;
  s.activeZones = s.activeZones ?? [];
  const radius = Math.max(0, Math.floor((spec.sizeFeet ?? 5) / 5) - 1);
  const { cols, rows, blocksMovement } = s.map;
  const tiles: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = spec.x + dx, y = spec.y + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      if (blocksMovement[y][x]) continue;
      tiles.push([x, y]);
    }
  }
  if (tiles.length === 0) tiles.push([spec.x, spec.y]);
  const zone: ActiveZone = {
    id: ctx.uid(),
    spellId: 'hazard',
    name: spec.name ?? 'Fire',
    shape: 'sphere',
    sizeFeet: spec.sizeFeet ?? 5,
    originX: spec.x,
    originY: spec.y,
    tiles,
    affectedNpcIds: [],
    affectedPlayer: false,
    roundsRemaining: spec.rounds ?? 9999,
    casterId: 'hazard',
    tintHex: spec.tintHex ?? '#ff7a3c',
    hazard: {
      dice: spec.dice, sides: spec.sides, bonus: spec.bonus, damageType: spec.damageType,
      saveAbility: spec.saveAbility, saveDC: spec.saveDC, halfOnSave: spec.halfOnSave,
      spreads: spec.spreads, maxTiles: spec.maxTiles,
    },
  };
  s.activeZones.push(zone);
  ctx.addLog({ left: `${zone.name} erupts!`, style: 'header' });
  return zone;
}
