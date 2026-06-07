import { GameEvent, ConsumableDef, LogEntry } from './types.js';
import type { GameContext } from './GameContext.js';
import { drinkPotion } from './CombatSystem.js';
import { doEnemyOpportunityAttack as caDoEnemyOA } from './CombatActions.js';
import { doStartCombat as cfDoStartCombat } from './CombatFlow.js';
import { chebyshev } from './EnemyAI.js';
import { isIncapacitated, isVisible, clearHide } from './ConditionSystem.js';
import { d, d20, mod, applyHalflingLuck } from './Dice.js';
import { runPerceptionSweep, runPassivePerceptionSweep } from './Vision.js';
import { itemDisplayName } from '../../../shared/types.js';
import { canShortRest as guardCanShortRest, canSearch as guardCanSearch } from './ActionGuards.js';
import { tickZoneEnterSaves } from './SpellSystem.js';
import { checkTrapTriggers, runPassiveTrapDetection, detectAdjacentTraps } from './TrapSystem.js';
import { formatCoins } from '../../../shared/currency.js';
import type { GameState } from './types.js';

/** SRD Difficult Terrain movement cost for the player (US-044): 2 movement
 *  tiles to enter a difficult-terrain tile, else 1. Difficult-terrain zones
 *  (Web / Grease) are the current source; a static map layer can extend this. */
function difficultTerrainCostForPlayer(s: GameState, x: number, y: number): number {
  const inDifficultZone = (s.activeZones ?? []).some(
    (z) => z.difficultTerrain && z.tiles.some(([zx, zy]) => zx === x && zy === y),
  );
  return inDifficultZone ? 2 : 1;
}

export function doMove(ctx: GameContext, dx: number, dy: number, events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
  if (isIncapacitated(s.player.conditions)) return;

  const nx = s.player.tileX + dx;
  const ny = s.player.tileY + dy;
  if (nx < 0 || ny < 0 || nx >= s.map.cols || ny >= s.map.rows) return;
  if (s.map.blocksMovement[ny][nx]) return;
  if (dx !== 0 && dy !== 0) {
    if (s.map.blocksMovement[s.player.tileY][nx] && s.map.blocksMovement[ny][s.player.tileX]) return;
  }
  // Living-NPC collision check with hidden-NPC handling:
  //   • Trigger-locked hidden NPC (in_a_niche, behind_a_wall) — incorporeal
  //     until an authored reveal fires; the player passes through with no
  //     log line, preserving the narrative beat.
  //   • Normal hidden NPC — the player stumbles into a creature they had
  //     no idea was there. Clear the hidden state (so the token + name
  //     surface) and block the step, with a log line so the player
  //     understands why their move didn't land.
  //   • Living, visible NPC — block as before.
  const blocker = s.npcs.find((n) => n.hp > 0 && n.tileX === nx && n.tileY === ny);
  if (blocker) {
    const blockerHidden = blocker.conditions.includes('hidden');
    if (blockerHidden && blocker.revealedByTrigger) {
      // Walk through silently — the trigger owns the reveal beat.
    } else {
      if (blockerHidden) {
        clearHide(blocker);
        ctx.addLog({ left: `${ctx.playerDef.name} stumbles into ${blocker.revealedName ?? blocker.name}!`, style: 'status' });
      }
      return;
    }
  }
  if (s.phase === 'player_turn' && s.player.movesLeft <= 0) return;

  const oldX = s.player.tileX;
  const oldY = s.player.tileY;
  s.player.tileX = nx;
  s.player.tileY = ny;
  s.player.movedThisTurn = true;
  events.push({ type: 'entity_move', entityId: 'player', toX: nx, toY: ny });

  // SRD enter-zone save: any active zone with an `enterSave` (Web, Grease)
  // rolls a fresh save the moment the player steps onto one of its tiles.
  // `tickZoneEnterSaves` is idempotent on creatures already carrying the
  // zone's condition, so re-entering the same zone after a successful
  // save does NOT re-roll on the same step.
  tickZoneEnterSaves(ctx, 'player');

  // A concealed trap on the entered tile springs immediately. May down the
  // player (death_saves / defeat), so bail before further turn processing.
  checkTrapTriggers(ctx, events);
  if ((s.phase as string) === 'death_saves' || (s.phase as string) === 'defeat') return;

  if (s.phase === 'player_turn') {
    // SRD Difficult Terrain (US-044): entering a difficult-terrain tile costs
    // 2 ft per foot — i.e. 2 movement tiles. Difficult-terrain zones (Web /
    // Grease) already cost enemies double via `applyZoneStepEffects`; mirror it
    // for the player. Clamp at 0 so entering with a single tile left is allowed.
    const cost = difficultTerrainCostForPlayer(s, nx, ny);
    s.player.movesLeft = Math.max(0, s.player.movesLeft - cost);
    // OA gate (SRD): the reactor must see the moving creature. If the player is
    // hidden or invisible, no enemy can OA them; if the enemy is incapacitated
    // or already burned its reaction this round, it can't react either.
    if (!s.player.conditions.includes('disengaged') && isVisible(s.player.conditions)) {
      for (const npc of s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0 && !n.reactionUsed && !isIncapacitated(n.conditions))) {
        if (chebyshev(oldX, oldY, npc.tileX, npc.tileY) <= 1 &&
            chebyshev(nx, ny, npc.tileX, npc.tileY) > 1) {
          caDoEnemyOA(ctx, npc, events);
          if ((s.phase as string) === 'death_saves' || (s.phase as string) === 'defeat') return;
        }
      }
    }
  } else {
    checkItemPickup(ctx);
  }

  // Passive Perception vs Stealth: any hidden NPC the player has just
  // stepped within range/LOS of, whose `hideDC` ≤ Reed's effective passive
  // Perception, is noticed without a roll. Fired BEFORE `player_moved`
  // publishes so authored triggers gated on `player_moved` (e.g. ambush
  // start-combat) see the reveals already applied — a hidden ambusher that
  // gets spotted on the same step that triggers combat enters the fight
  // visible.
  runPassivePerceptionSweep(ctx);

  // Same idea for concealed traps: a trap the player walks within ~10 ft of is
  // noticed without a roll if its detectDC ≤ passive Perception.
  runPassiveTrapDetection(ctx);

  // Publish player_moved on the bus BEFORE the combat-start proximity check
  // so an enter_area trigger that spawns enemies near the player can kick
  // off combat on the same tile entry.
  ctx.publish({ type: 'player_moved', x: nx, y: ny });

  if (s.phase === 'exploring') checkCombatTrigger(ctx, events);
}

export function doMoveTo(ctx: GameContext, targetX: number, targetY: number, events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
  const { cols, rows, blocksMovement } = s.map;
  if (targetX < 0 || targetX >= cols || targetY < 0 || targetY >= rows) return;

  const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
  const prev: Array<Array<[number, number] | null>> = Array.from({ length: rows }, () => new Array(cols).fill(null));
  const px = s.player.tileX, py = s.player.tileY;
  dist[py][px] = 0;
  const queue: [number, number][] = [[py, px]];
  while (queue.length > 0) {
    const [cy, cx] = queue.shift()!;
    for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]] as [number,number][]) {
      const nr = cy + dr, nc = cx + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (blocksMovement[nr][nc]) continue;
      if (dr !== 0 && dc !== 0 && blocksMovement[cy][nc] && blocksMovement[nr][cx]) continue;
      // Trigger-locked hidden NPCs are treated as walk-through here so the
      // BFS doesn't carve detours around invisible creatures; `doMove` will
      // let the step land on their tile silently. Normal hidden + visible
      // living NPCs still block routing.
      if (s.npcs.some((n) => n.hp > 0 && n.tileX === nc && n.tileY === nr
          && !(n.conditions.includes('hidden') && n.revealedByTrigger))) continue;
      if (dist[nr][nc] !== -1) continue;
      dist[nr][nc] = dist[cy][cx] + 1;
      prev[nr][nc] = [cy, cx];
      queue.push([nr, nc]);
    }
  }
  if (dist[targetY][targetX] === -1) return;

  const path: [number, number][] = [];
  let cur: [number, number] = [targetY, targetX];
  while (cur[0] !== py || cur[1] !== px) {
    path.unshift(cur);
    cur = prev[cur[0]][cur[1]]!;
  }
  for (const [ny, nx] of path) {
    const phase = s.phase as string;
    if (phase === 'death_saves' || phase === 'defeat') break;
    doMove(ctx, nx - s.player.tileX, ny - s.player.tileY, events);
  }
}

function checkItemPickup(ctx: GameContext): void {
  const s = ctx.state;
  const idx = s.mapItems.findIndex((i) => i.tileX === s.player.tileX && i.tileY === s.player.tileY);
  if (idx === -1) return;
  const item = s.mapItems[idx];
  const def = ctx.defs.equipment.find((i) => i.id === item.defId);
  if (def) {
    s.player.inventoryIds.push(item.defId);
    ctx.addLog(`Picked up ${def.name}!`);
  }
  s.mapItems.splice(idx, 1);
  ctx.publish({ type: 'item_picked_up', defId: item.defId });
}

function checkCombatTrigger(ctx: GameContext, events: GameEvent[]): void {
  const s = ctx.state;
  const enemies = s.npcs.filter((n) => n.disposition === 'enemy' && n.hp > 0);
  for (const enemy of enemies) {
    if (chebyshev(s.player.tileX, s.player.tileY, enemy.tileX, enemy.tileY) <= 2) {
      cfDoStartCombat(ctx, events);
      s.selectedTargetId = enemy.id;
      return;
    }
  }
}

export function doSearch(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanSearch(ctx)) return;

  // Search costs the full Action in combat (SRD); no economy during
  // exploration. Spending here keeps the action-button greying logic in
  // sync — `canSearch` flips to false until the next turn.
  if (s.phase === 'player_turn') s.player.actionUsed = true;

  const roll = applyHalflingLuck(d20(), ctx.playerDef.halflingLuck).natural + (ctx.playerDef.skills['perception'] ?? 0);
  const adj = s.secrets.filter(
    (sec) => chebyshev(s.player.tileX, s.player.tileY, sec.tileX, sec.tileY) <= 1,
  );

  // SRD Search [Action] — active Perception sweep against every hidden NPC
  // within 30 ft of the player. Each hider's `hideDC` is opposed by the
  // single roll above (the d20 fires once for the Action, reused across
  // every detection check). Spotting clears the hidden + invisible flags
  // via Vision.runPerceptionSweep, which performs its own roll internally
  // using the searcher's PP — we call it for each candidate.
  const PERCEPTION_RANGE_TILES = 6;
  const hidersInRange = s.npcs.filter((n) =>
    n.hp > 0
    && n.conditions.includes('hidden')
    && typeof n.hideDC === 'number'
    && chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= PERCEPTION_RANGE_TILES,
  );
  for (const h of hidersInRange) runPerceptionSweep(ctx, h.id);

  // SRD Search — also probe for concealed traps adjacent to the player, using
  // the same single Perception roll.
  const trapLogs = detectAdjacentTraps(ctx, roll);

  // SRD Search [Action] — corpse rifling: any adjacent NPC with an authored
  // `corpseSearch` payload resolves against the same roll. Payload is
  // single-use — cleared on resolution so a second SEARCH while still
  // adjacent reports "nothing else here." Pairs with the `set_npc_dead`
  // trigger action.
  const corpseLogs: LogEntry[] = [];
  for (const npc of s.npcs) {
    if (!npc.corpseSearch) continue;
    if (chebyshev(s.player.tileX, s.player.tileY, npc.tileX, npc.tileY) > 1) continue;
    const cs = npc.corpseSearch;
    const succeeded = roll >= cs.dc;
    corpseLogs.push({
      left: `Search ${npc.revealedName ?? npc.name} (${roll} vs DC ${cs.dc}) — ${succeeded ? cs.successText : cs.failureText}`,
      style: succeeded ? 'hit' : 'miss',
    });
    if (succeeded && cs.rewardItemId) {
      s.player.inventoryIds.push(cs.rewardItemId);
      const def = ctx.defs.equipment.find((i) => i.id === cs.rewardItemId);
      const name = def ? itemDisplayName(def, s.player.identifiedItemIds) : cs.rewardItemId;
      corpseLogs.push({ left: `You take ${name}.`, style: 'status' });
    }
    npc.corpseSearch = undefined;
    npc.corpseSearched = true;
  }

  if (adj.length === 0) {
    const pre = [...corpseLogs, ...trapLogs];
    if (pre.length > 0) ctx.addLogs(pre);
    else if (hidersInRange.length === 0) ctx.addLog({ left: `Search (${roll}) — nothing found`, style: 'miss' });
    return;
  }

  const secret = adj[0];
  const success = roll >= secret.def.dc;
  s.secrets = s.secrets.filter((sec) => sec !== secret);

  const logs: LogEntry[] = [...corpseLogs, ...trapLogs];
  if (success) {
    logs.push({ left: `Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.successText}`, style: 'hit' });
    const r = secret.def.reward;
    if (r.type === 'coins') {
      s.player.balanceCp += r.cp;
      logs.push({ left: `+${formatCoins(r.cp)}`, style: 'status' });
    } else if (r.type === 'item') {
      const item = ctx.defs.equipment.find((i) => i.id === r.itemId);
      if (item) { s.player.inventoryIds.push(r.itemId); logs.push({ left: `Found: ${item.name}`, style: 'status' }); }
    } else {
      logs.push({ left: `Lore: "${r.text}"`, style: 'normal' });
    }
  } else {
    logs.push({ left: `Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.failureText}`, style: 'miss' });
  }
  ctx.addLogs(logs);
}

export function doShortRest(ctx: GameContext): void {
  const s = ctx.state;
  if (!guardCanShortRest(ctx)) return;
  const conMod = mod(ctx.playerDef.con);
  const roll = d(ctx.playerDef.hitDieType);
  const healed = Math.max(1, roll + conMod);
  const before = s.player.hp;
  s.player.hp = Math.min(ctx.playerDef.maxHp, s.player.hp + healed);
  s.player.hitDiceUsed++;
  const remaining = ctx.playerDef.level - s.player.hitDiceUsed;
  ctx.addLogs([
    { left: `Short Rest — +${healed} HP restored`, right: `1d${ctx.playerDef.hitDieType}+CON(${conMod >= 0 ? '+' : ''}${conMod})=[${roll}]+${conMod}=${healed}`, style: 'heal' },
    { left: `HP: ${before} → ${s.player.hp}/${ctx.playerDef.maxHp}  (${remaining} Hit ${remaining === 1 ? 'Die' : 'Dice'} left)`, style: 'status' },
  ]);
  // Refill every short-rest feature resource the character knows. New
  // encounters already act as Long Rests via SessionBuilder seeding, so the
  // refill only matters when the player stays in the same session.
  for (const fid of ctx.playerDef.defaultFeatureIds ?? []) {
    const def = ctx.defs.features.find((f) => f.id === fid);
    if (def?.resource?.kind === 'uses-per-short-rest') {
      s.player.resources[fid] = def.resource.max;
    }
  }
  // Warlock Pact Magic refills on Short Rest per SRD — this is the whole
  // point of the pact-magic alternative slot pool. Absent for non-Warlocks.
  if (s.player.pactMagic) {
    s.player.pactMagic.remaining = s.player.pactMagic.max;
  }

  // SRD short-rest slot recovery (Wizard Arcane Recovery, Druid Natural
  // Recovery). Once per Long Rest, recover expended spell slots whose combined
  // level totals at most ⌈character level / budgetDivisor⌉ — none above
  // `maxSlotLevel` — by topping up the lowest-level empty slot first.
  // Auto-resolves (no picker UI yet); the greedy pick of the lowest level is
  // strictly optimal for slot count, and players rarely want a higher-level
  // slot back over multiple lower-level ones. Driven by the feature's
  // `slotRecovery` descriptor and gated on owning the feature — not a class
  // name — so a new recovery feature is data-only.
  const recoveryDef = (ctx.playerDef.defaultFeatureIds ?? [])
    .map((fid) => ctx.defs.features.find((f) => f.id === fid))
    .find((f) => f?.slotRecovery);
  if (recoveryDef?.slotRecovery && !s.player.arcaneRecoveryUsed) {
    const { budgetDivisor, maxSlotLevel } = recoveryDef.slotRecovery;
    let budget = Math.ceil(ctx.playerDef.level / budgetDivisor);
    const maxSlots = ctx.playerDef.defaultSpellSlots ?? [];
    const recovered: number[] = [];
    // Slots above `maxSlotLevel` can't be recovered; iterate ascending so we
    // top those up first per the "lowest level is strictly optimal" note above.
    for (let i = 0; i < Math.min(maxSlotLevel, maxSlots.length); i++) {
      const slotLevel = i + 1;
      while (budget >= slotLevel && (s.player.spellSlots[i] ?? 0) < (maxSlots[i] ?? 0)) {
        s.player.spellSlots[i] = (s.player.spellSlots[i] ?? 0) + 1;
        budget -= slotLevel;
        recovered.push(slotLevel);
      }
      if (budget <= 0) break;
    }
    if (recovered.length > 0) {
      s.player.arcaneRecoveryUsed = true;
      const parts = recovered.reduce<Record<number, number>>((m, lvl) => { m[lvl] = (m[lvl] ?? 0) + 1; return m; }, {});
      const summary = Object.entries(parts).sort(([a], [b]) => Number(a) - Number(b)).map(([lvl, n]) => `${n}× L${lvl}`).join(', ');
      ctx.addLog({ left: `📖 ${recoveryDef.name} — recovered ${summary}`, style: 'heal' });
    }
  }

  // Companions catch their breath on a Short Rest too — a modest HP recovery
  // (a quarter of maximum). NPCs don't track hit dice, so this is a flat proxy
  // rather than a die roll.
  for (const npc of s.npcs) {
    if (!npc.companion || npc.hp <= 0 || npc.hp >= npc.maxHp) continue;
    const beforeNpc = npc.hp;
    npc.hp = Math.min(npc.maxHp, npc.hp + Math.max(1, Math.ceil(npc.maxHp * 0.25)));
    ctx.addLog({ left: `${npc.revealedName ?? npc.name} catches a breath — +${npc.hp - beforeNpc} HP  (${npc.hp}/${npc.maxHp})`, style: 'heal' });
  }
}

export function doUsePotion(ctx: GameContext): void {
  const s = ctx.state;
  if (s.phase === 'player_turn' && s.player.bonusActionUsed) return;
  if (s.phase !== 'player_turn' && s.phase !== 'exploring') return;

  const idx = s.player.inventoryIds.findIndex((id) => {
    const item = ctx.defs.equipment.find((i) => i.id === id);
    return item?.type === 'consumable';
  });
  if (idx === -1) return;

  const itemId = s.player.inventoryIds.splice(idx, 1)[0];
  const item = ctx.defs.equipment.find((i) => i.id === itemId) as ConsumableDef;
  const { healed, tempHp, logs } = drinkPotion(item);
  const extra: LogEntry[] = [];
  if (healed > 0) {
    const before = s.player.hp;
    s.player.hp = Math.min(ctx.playerDef.maxHp, s.player.hp + healed);
    extra.push({ left: `HP: ${before} → ${s.player.hp}/${ctx.playerDef.maxHp}`, style: 'status' });
  }
  // SRD: Temporary HP doesn't stack — keep the higher of current vs granted.
  if (tempHp > 0 && tempHp > (s.player.tempHp ?? 0)) {
    s.player.tempHp = tempHp;
    extra.push({ left: `Temporary HP: ${s.player.tempHp}`, style: 'status' });
  }
  ctx.addLogs([...logs, ...extra]);
  if (s.phase === 'player_turn') s.player.bonusActionUsed = true;
}
