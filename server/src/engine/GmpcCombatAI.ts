/**
 * US-130 — deterministic GMPC combat AI.
 *
 * Resolves a GMPC's combat turn instantly through the engine (no LLM), using the
 * character's full PC kit. It runs inside the active-actor binding the engine
 * sets up (`state.player` is the GMPC, `ctx.playerDef` its def, phase presented
 * as `player_turn`), and drives the SAME `PlayerAction` handlers the human uses
 * via the injected `dispatch` — so attacks, leveled spellcasting, and movement
 * resolve and spend the GMPC's own resources with no special-casing.
 *
 * Policy (single main action, v1): pick the nearest living enemy; choose the
 * highest expected-damage option the character can bring to bear (a castable
 * offensive spell, else a weapon attack); close the distance if out of range;
 * then act. The GM can still narrate the result with `npc_speaks` — this owns
 * only the mechanics.
 */
import type { GameContext } from './GameContext.js';
import type { PlayerAction, NpcState, SpellDef } from './types.js';
import { canCastSpell, castableSpellIds, playerAttackReachTiles } from './ActionGuards.js';
import { canSee } from './Vision.js';
import { chebyshev } from './EnemyAI.js';
import { mod } from './Dice.js';

type Dispatch = (action: PlayerAction) => void;

interface OffensiveOption {
  rangeTiles: number;
  expectedDamage: number;
  /** Build the attack/cast action against a target id. */
  action: (targetId: string) => PlayerAction;
}

const TILE_FT = 5;

/**
 * Run the GMPC's mechanical combat turn. Dispatches move + one offensive action
 * (or a defensive fallback). Turn completion (advancing initiative) is the
 * caller's job — this never ends the turn itself.
 */
export function gmpcTakeCombatTurn(ctx: GameContext, dispatch: Dispatch): void {
  const s = ctx.state;
  const me = s.player;

  const enemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0 && !n.conditions.includes('hidden'));
  if (enemies.length === 0) return;
  const target = enemies.reduce((best, n) =>
    chebyshev(me.tileX, me.tileY, n.tileX, n.tileY) < chebyshev(me.tileX, me.tileY, best.tileX, best.tileY) ? n : best);

  // All the ways this character can hurt the target, best first.
  const options = offensiveOptions(ctx).sort((a, b) => b.expectedDamage - a.expectedDamage);
  if (options.length === 0) { dispatch({ type: 'dodge' }); return; }

  // If the best option is already usable (in range + line of sight), take it.
  for (const opt of options) {
    if (canBringToBear(ctx, me, target, opt.rangeTiles)) {
      dispatch(opt.action(target.id));
      return;
    }
  }

  // Out of range for everything — close on the target, then re-check.
  const dest = approachTile(ctx, target);
  if (dest) dispatch({ type: 'moveTo', tileX: dest.x, tileY: dest.y });
  for (const opt of options) {
    if (canBringToBear(ctx, s.player, target, opt.rangeTiles)) {
      dispatch(opt.action(target.id));
      return;
    }
  }
  // Couldn't reach anything this turn — we at least advanced toward the foe.
}

/** True when the actor at its current tile can hit `target` with a `rangeTiles`
 *  option — within range and not behind total cover. */
function canBringToBear(ctx: GameContext, me: { tileX: number; tileY: number }, target: NpcState, rangeTiles: number): boolean {
  if (chebyshev(me.tileX, me.tileY, target.tileX, target.tileY) > rangeTiles) return false;
  const v = canSee(
    ctx.state,
    { tileX: me.tileX, tileY: me.tileY, senses: ctx.playerDef.senses },
    { tileX: target.tileX, tileY: target.tileY, conditions: target.conditions, id: target.id },
  );
  return v.cover !== 'total';
}

/** Collect the character's usable offensive options (castable damage spells +
 *  the weapon attack), each with a rough expected-damage score for ranking. */
function offensiveOptions(ctx: GameContext): OffensiveOption[] {
  const out: OffensiveOption[] = [];

  for (const id of castableSpellIds(ctx)) {
    const spell = ctx.defs.spells.find((sp) => sp.id === id);
    if (!spell || !isOffensiveSingleTarget(spell)) continue;
    if (!canCastSpell(ctx, id)) continue;
    const slotLevel = spell.level;  // cantrips cast at 0; leveled at base level
    out.push({
      rangeTiles: Math.max(1, Math.floor(spell.rangeFeet / TILE_FT)),
      expectedDamage: spellExpectedDamage(spell),
      action: (targetId) => ({ type: 'castSpell', spellId: id, slotLevel, targetIds: [targetId] }),
    });
  }

  const atk = ctx.playerDef.mainAttack;
  if (atk) {
    const statMod = mod(atk.statKey === 'dex' ? ctx.playerDef.dex : ctx.playerDef.str);
    const ranged = !!atk.rangeNormal && atk.rangeNormal > 0;
    out.push({
      rangeTiles: ranged ? Math.max(1, Math.floor((atk.rangeNormal ?? 0) / TILE_FT)) : playerAttackReachTiles(ctx),
      expectedDamage: atk.damageDice * (atk.damageSides + 1) / 2 + statMod,
      action: (targetId) => ({ type: 'attack', targetId }),
    });
  }

  return out;
}

/** A damage spell aimed at a single creature (not a self/utility/tile-only AoE),
 *  which the deterministic AI can fire with `targetIds: [enemy]`. */
function isOffensiveSingleTarget(spell: SpellDef): boolean {
  if (spell.rangeFeet <= 0 || !spell.damage) return false;
  if (spell.area) return false;                          // tile-targeted AoE — needs aim, skip in v1
  return spell.attack === 'ranged-spell' || spell.attack === 'auto-hit' || !!spell.save;
}

function spellExpectedDamage(spell: SpellDef): number {
  const d = spell.damage;
  if (!d) return 0;
  const perInstance = d.dice * (d.sides + 1) / 2 + (d.bonus ?? 0);
  const instances = spell.darts ?? 1;                    // Magic Missile fires several
  const hitFactor = spell.attack === 'ranged-spell' ? 0.65 : spell.save ? 0.75 : 1;  // auto-hit/Magic Missile = 1
  return perInstance * instances * hitFactor;
}

/** Nearest passable, unoccupied, in-bounds tile adjacent to the target — the
 *  approach destination. `doMoveTo` walks toward it as far as movement allows,
 *  so even an unreachable pick still closes the gap. */
function approachTile(ctx: GameContext, target: NpcState): { x: number; y: number } | null {
  const s = ctx.state;
  const { cols, rows, blocksMovement } = s.map;
  const occupied = (x: number, y: number) =>
    (s.player.tileX === x && s.player.tileY === y)
    || (s.parkedActorTile?.x === x && s.parkedActorTile?.y === y)  // the swapped-out human
    || s.npcs.some((n) => n.hp > 0 && n.tileX === x && n.tileY === y);
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = target.tileX + dx, y = target.tileY + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      if (blocksMovement[y][x] || occupied(x, y)) continue;
      const dist = chebyshev(s.player.tileX, s.player.tileY, x, y);
      if (dist < bestDist) { bestDist = dist; best = { x, y }; }
    }
  }
  return best;
}
