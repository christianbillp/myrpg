/**
 * SummonSystem — player-owned summons (Mage Hand, Unseen Servant).
 *
 * Summons are NPCs with `summonSpellId` + `summonOwnerId` set. They skip the
 * combat turn loop entirely (see `CombatFlow.doStartCombat`), aren't part of
 * any faction's roster (their `factionId` is `summon:<spell-id>`), and act
 * only when the caster spends an Action via `commandSummon`. This module
 * owns:
 *
 *  • `doCommandSummon` — the action handler: validate range, move the summon,
 *    spend the Action.
 *  • `checkSummonTether` — end-of-turn proximity check (Mage Hand's 30 ft
 *    rule). Run from the player-turn finalizer.
 *  • `endSummonsOnDamage` — invoked from `applyNpcAttackHit` / GM tool /
 *    trigger damage so Unseen Servant ends the moment it's hit.
 */
import type { GameContext } from './GameContext.js';
import type { GameEvent, NpcState } from './types.js';
import { chebyshev } from './EnemyAI.js';

/**
 * Convert a feet distance to the equivalent chebyshev tile budget. SRD
 * tiles are 5 ft, so 30 ft = 6 tiles, 15 ft = 3 tiles, etc.
 */
function feetToTiles(feet: number): number {
  return Math.max(1, Math.ceil(feet / 5));
}

/**
 * Resolve a `commandSummon` action. Validates ownership + range + passable
 * destination, then walks the summon to the target tile and consumes the
 * caster's Action. Out-of-range or invalid clicks are silent no-ops so the
 * player's Action isn't spent on a misclick.
 */
export function doCommandSummon(
  ctx: GameContext,
  summonNpcId: string,
  tile: { x: number; y: number },
  events: GameEvent[],
): void {
  const s = ctx.state;
  if (s.phase !== 'player_turn' && s.phase !== 'exploring') return;
  if (s.phase === 'player_turn' && s.player.actionUsed) return;

  const npc = s.npcs.find((n) => n.id === summonNpcId);
  if (!npc || !npc.summonSpellId || npc.summonOwnerId !== 'player') return;
  if (npc.hp <= 0) return;

  const spell = ctx.defs.spells.find((sp) => sp.id === npc.summonSpellId);
  if (!spell?.summon) return;

  const moveRange = feetToTiles(spell.summon.moveRangeFeet);
  const dist = chebyshev(npc.tileX, npc.tileY, tile.x, tile.y);
  if (dist > moveRange) {
    ctx.addLog({ left: `${npc.name}: target tile out of range (${moveRange} tiles)`, style: 'miss' });
    return;
  }

  // Destination bounds + occupancy check. We don't path-find — the summon
  // just glides to the chosen tile if it's reachable in straight line of
  // sight (Mage Hand is spectral; Unseen Servant is incorporeal).
  const { cols, rows, passable } = s.map;
  if (tile.x < 0 || tile.x >= cols || tile.y < 0 || tile.y >= rows) return;
  if (!passable[tile.y][tile.x]) return;
  const occupied = (s.player.tileX === tile.x && s.player.tileY === tile.y)
    || s.npcs.some((n) => n !== npc && n.hp > 0 && n.tileX === tile.x && n.tileY === tile.y);
  if (occupied) return;

  events.push({ type: 'entity_move', entityId: npc.id, toX: tile.x, toY: tile.y });
  npc.tileX = tile.x;
  npc.tileY = tile.y;

  if (s.phase === 'player_turn') s.player.actionUsed = true;
  ctx.addLog({ left: `${ctx.playerDef.name} directs ${npc.name}.`, style: 'status' });
}

/**
 * SRD Mage Hand: "vanishes if it is ever more than 30 ft from you." Called
 * from the player-turn finalizer so the check runs once per round. The
 * caster's tile is the reference point. Despawns any tethered summon that
 * busted its range. Unseen Servant has no tether — `tetherFeet` is omitted
 * from its spell def so it's skipped here.
 */
export function checkSummonTether(ctx: GameContext): void {
  const s = ctx.state;
  for (const npc of [...s.npcs]) {
    if (!npc.summonSpellId || npc.summonOwnerId !== 'player') continue;
    const spell = ctx.defs.spells.find((sp) => sp.id === npc.summonSpellId);
    const tether = spell?.summon?.tetherFeet;
    if (!tether) continue;
    const tetherTiles = feetToTiles(tether);
    if (chebyshev(s.player.tileX, s.player.tileY, npc.tileX, npc.tileY) > tetherTiles) {
      ctx.addLog({ left: `${npc.name} drifts out of range and vanishes.`, style: 'status' });
      ctx.removeNpc(npc.id);
    }
  }
}

/**
 * SRD Unseen Servant: "If the servant takes any damage, the spell ends."
 * Called whenever an NPC takes damage. If the damaged NPC is a summon, its
 * spell ends — we despawn the entity regardless of its remaining HP since
 * the spell ending makes it vanish.
 */
export function endSummonsOnDamage(ctx: GameContext, npc: NpcState): void {
  if (!npc.summonSpellId || npc.summonOwnerId !== 'player') return;
  ctx.addLog({ left: `${npc.name} dissipates — the spell ends.`, style: 'status' });
  ctx.removeNpc(npc.id);
}

/**
 * Wire the engine's `damage_dealt` event so any source of damage (spell,
 * NPC attack, AIGM tool, trigger) ends a damaged summon. Subscribers fire
 * synchronously so the despawn is visible in the same tick as the damage.
 */
export function registerSummonHooks(ctx: GameContext): void {
  ctx.bus.subscribe('damage_dealt', (e) => {
    if (e.target === 'player') return;
    const npc = ctx.state.npcs.find((n) => n.id === e.target);
    if (npc) endSummonsOnDamage(ctx, npc);
  }, /*priority*/ 100);
}
