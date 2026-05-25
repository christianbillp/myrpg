import { GameEvent, ConsumableDef, LogEntry } from './types.js';
import type { GameContext } from './GameContext.js';
import { drinkPotion } from './CombatSystem.js';
import { doEnemyOpportunityAttack as caDoEnemyOA } from './CombatActions.js';
import { doStartCombat as cfDoStartCombat } from './CombatFlow.js';
import { chebyshev } from './EnemyAI.js';
import { isIncapacitated, isVisible } from './ConditionSystem.js';
import { d, d20, mod } from './Dice.js';
import { canShortRest as guardCanShortRest } from './ActionGuards.js';

export function doMove(ctx: GameContext, dx: number, dy: number, events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
  if (isIncapacitated(s.player.conditions)) return;

  const nx = s.player.tileX + dx;
  const ny = s.player.tileY + dy;
  if (nx < 0 || ny < 0 || nx >= s.map.cols || ny >= s.map.rows) return;
  if (!s.map.passable[ny][nx]) return;
  if (dx !== 0 && dy !== 0) {
    if (!s.map.passable[s.player.tileY][nx] && !s.map.passable[ny][s.player.tileX]) return;
  }
  if (s.npcs.some((n) => n.hp > 0 && n.tileX === nx && n.tileY === ny)) return;
  if (s.phase === 'player_turn' && s.player.movesLeft <= 0) return;

  const oldX = s.player.tileX;
  const oldY = s.player.tileY;
  s.player.tileX = nx;
  s.player.tileY = ny;
  events.push({ type: 'entity_move', entityId: 'player', toX: nx, toY: ny });

  if (s.phase === 'player_turn') {
    s.player.movesLeft--;
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
    checkCombatTrigger(ctx, events);
  }
}

export function doMoveTo(ctx: GameContext, targetX: number, targetY: number, events: GameEvent[]): void {
  const s = ctx.state;
  if (s.phase !== 'exploring' && s.phase !== 'player_turn') return;
  const { cols, rows, passable } = s.map;
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
      if (!passable[nr][nc]) continue;
      if (dr !== 0 && dc !== 0 && !passable[cy][nc] && !passable[nr][cx]) continue;
      if (s.npcs.some((n) => n.hp > 0 && n.tileX === nc && n.tileY === nr)) continue;
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
  ctx.advanceQuest('collect');
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
  if (s.phase !== 'exploring') return;

  const roll = d20() + (ctx.playerDef.skills['perception'] ?? 0);
  const adj = s.secrets.filter(
    (sec) => chebyshev(s.player.tileX, s.player.tileY, sec.tileX, sec.tileY) <= 1,
  );

  if (adj.length === 0) {
    ctx.addLog({ left: `Search (${roll}) — nothing found`, style: 'miss' });
    return;
  }

  const secret = adj[0];
  const success = roll >= secret.def.dc;
  s.secrets = s.secrets.filter((sec) => sec !== secret);

  const logs: LogEntry[] = [];
  if (success) {
    ctx.advanceQuest('explore');
    logs.push({ left: `Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.successText}`, style: 'hit' });
    const r = secret.def.reward;
    if (r.type === 'gold') {
      s.player.gold += r.amount;
      logs.push({ left: `+${r.amount} GP`, style: 'status' });
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
  const { healed, logs } = drinkPotion(item);
  const before = s.player.hp;
  s.player.hp = Math.min(ctx.playerDef.maxHp, s.player.hp + healed);
  ctx.addLogs([...logs, { left: `HP: ${before} → ${s.player.hp}/${ctx.playerDef.maxHp}`, style: 'status' }]);
  if (s.phase === 'player_turn') s.player.bonusActionUsed = true;
}
