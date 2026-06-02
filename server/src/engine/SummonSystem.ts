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
import { d, d20, mod } from './Dice.js';
import { combatantDisplayName } from './CombatFlow.js';

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

  const npc = s.npcs.find((n) => n.id === summonNpcId);
  if (!npc || !npc.summonSpellId || npc.summonOwnerId !== 'player') return;
  if (npc.hp <= 0) return;

  const spell = ctx.defs.spells.find((sp) => sp.id === npc.summonSpellId);
  if (!spell?.summon) return;

  // SRD Flaming Sphere: command move uses the caster's BONUS ACTION, not
  // the Action; moving the sphere INTO a creature's space triggers a
  // DEX save against the sphere's damage and the sphere stops moving for
  // the turn (we model that as "no movement happens, but the save still
  // resolves" — the sphere stays put).
  const isFlamingSphere = spell.id === 'flaming-sphere';
  if (isFlamingSphere) {
    if (s.phase === 'player_turn' && s.player.bonusActionUsed) return;
  } else {
    if (s.phase === 'player_turn' && s.player.actionUsed) return;
  }

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
  const occupant: { kind: 'player' } | { kind: 'npc'; npc: NpcState } | null =
    (s.player.tileX === tile.x && s.player.tileY === tile.y && s.player.hp > 0)
      ? { kind: 'player' }
      : (() => {
          const hit = s.npcs.find((n) => n !== npc && n.hp > 0 && n.tileX === tile.x && n.tileY === tile.y);
          return hit ? { kind: 'npc' as const, npc: hit } : null;
        })();

  if (occupant && isFlamingSphere) {
    // Ram-into-creature path. Trigger the save against the occupant, then
    // the sphere stops (stays at its current tile). Bonus Action still
    // consumed — the player committed to the move.
    rollFlamingSphereSaveAgainst(ctx, npc, spell, occupant);
    if (s.phase === 'player_turn') s.player.bonusActionUsed = true;
    ctx.addLog({ left: `${ctx.playerDef.name} rolls ${npc.name} into ${occupant.kind === 'player' ? ctx.playerDef.name : combatantDisplayName(occupant.npc, s.npcs)} — the sphere stops.`, style: 'status' });
    return;
  }
  if (occupant) return; // Non-flaming-sphere summons silently refuse occupied tiles.

  events.push({ type: 'entity_move', entityId: npc.id, toX: tile.x, toY: tile.y });
  npc.tileX = tile.x;
  npc.tileY = tile.y;

  if (s.phase === 'player_turn') {
    if (isFlamingSphere) s.player.bonusActionUsed = true;
    else s.player.actionUsed = true;
  }
  ctx.addLog({ left: `${ctx.playerDef.name} directs ${npc.name}.`, style: 'status' });
}

/**
 * Roll the Flaming Sphere damage save against a single target. Used both
 * by the "moved into your space" trigger inside `doCommandSummon` and by
 * the end-of-turn proximity sweep in `runFlamingSphereEndOfTurnSaves`. The
 * save DC comes from the caster (their spell save DC = 8 + PB + ability
 * mod). On a fail the target takes 2d6 fire (full); on a save it takes
 * half.
 */
function rollFlamingSphereSaveAgainst(
  ctx: GameContext,
  sphere: NpcState,
  spell: import('./types.js').SpellDef,
  target: { kind: 'player' } | { kind: 'npc'; npc: NpcState },
): void {
  if (!spell.damage || !spell.save) return;
  const s = ctx.state;
  const dc = 8 + ctx.playerDef.proficiencyBonus + (
    ctx.playerDef.spellcastingAbility ? mod(ctx.playerDef[ctx.playerDef.spellcastingAbility]) : 0
  );
  const rolls: number[] = [];
  for (let i = 0; i < spell.damage.dice; i++) rolls.push(d(spell.damage.sides));
  const rawDamage = rolls.reduce((a, b) => a + b, 0);
  if (target.kind === 'player') {
    const ability = spell.save.ability;
    const abMod = mod(ctx.playerDef[ability as 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha']);
    const profBonus = ctx.playerDef.savingThrowProficiencies.includes(ability)
      ? ctx.playerDef.proficiencyBonus
      : 0;
    const saveBonus = abMod + profBonus;
    const roll = d20();
    const total = roll + saveBonus;
    const success = total >= dc;
    const dmg = success ? Math.floor(rawDamage / 2) : rawDamage;
    ctx.addLog({
      left: `${ctx.playerDef.name} ${success ? 'saves' : 'fails'} — ${dmg} ${spell.damage.type}`,
      right: `DEX d20(${roll})+${saveBonus}=${total} vs DC ${dc} · ${spell.damage.dice}d${spell.damage.sides}[${rolls.join(',')}]=${rawDamage}`,
      style: success ? 'normal' : 'hit',
    });
    if (dmg > 0) ctx.applyDamageToPlayer(dmg, []);
    return;
  }
  const npc = target.npc;
  const def = ctx.resolveMonsterDef(npc.defId);
  if (!def) return;
  const saveMod = (def.savingThrows && def.savingThrows[spell.save.ability] !== undefined)
    ? def.savingThrows[spell.save.ability]!
    : mod(def[spell.save.ability as 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha']);
  const roll = d20();
  const total = roll + saveMod;
  const success = total >= dc;
  const dmg = success ? Math.floor(rawDamage / 2) : rawDamage;
  // Route through the standard resistance path so resistance / vulnerability
  // / immunity apply (the Flaming Sphere is fire-immune so it can't hurt
  // itself; other fire-resistant creatures take less).
  const { finalDamage, log: resistLog } = ctx.resistMod(dmg, spell.damage.type, def, npc.name);
  if (resistLog) ctx.addLog(resistLog);
  ctx.addLog({
    left: `${combatantDisplayName(npc, s.npcs)} ${success ? 'saves' : 'fails'} — ${finalDamage} ${spell.damage.type}`,
    right: `${spell.save.ability.toUpperCase()} d20(${roll})+${saveMod}=${total} vs DC ${dc} · ${spell.damage.dice}d${spell.damage.sides}[${rolls.join(',')}]=${rawDamage}`,
    style: success ? 'normal' : 'hit',
  });
  if (finalDamage > 0 && npc.hp > 0) {
    npc.hp = Math.max(0, npc.hp - finalDamage);
    if (npc.hp <= 0) ctx.killWithReward(npc, def, `☠ ${combatantDisplayName(npc, s.npcs)} is incinerated!`);
  }
}

/**
 * SRD Flaming Sphere — any creature that ends its turn within 5 ft of the
 * sphere makes a DEX save against the sphere's damage. Called from
 * `finalizeNpcTurn` and from the player end-of-turn handler. `subjectId`
 * is `'player'` or the NPC id whose turn just ended.
 */
export function runFlamingSphereEndOfTurnSaves(ctx: GameContext, subjectId: 'player' | string): void {
  const s = ctx.state;
  const spheres = s.npcs.filter((n) => n.summonSpellId === 'flaming-sphere' && n.summonOwnerId === 'player' && n.hp > 0);
  if (spheres.length === 0) return;
  for (const sphere of spheres) {
    const spell = ctx.defs.spells.find((sp) => sp.id === 'flaming-sphere');
    if (!spell) continue;
    if (subjectId === 'player') {
      if (chebyshev(s.player.tileX, s.player.tileY, sphere.tileX, sphere.tileY) > 1) continue;
      if (s.player.hp <= 0) continue;
      rollFlamingSphereSaveAgainst(ctx, sphere, spell, { kind: 'player' });
    } else {
      const npc = s.npcs.find((n) => n.id === subjectId);
      if (!npc || npc.hp <= 0) continue;
      // Don't damage the sphere with itself.
      if (npc.summonSpellId === 'flaming-sphere') continue;
      if (chebyshev(npc.tileX, npc.tileY, sphere.tileX, sphere.tileY) > 1) continue;
      rollFlamingSphereSaveAgainst(ctx, sphere, spell, { kind: 'npc', npc });
    }
  }
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
  // SRD Flaming Sphere is not destroyed by damage — only the spell's
  // duration / concentration end / re-cast can remove it. Skip the
  // damage-ends-summon path for it.
  if (npc.summonSpellId === 'flaming-sphere') return;
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
