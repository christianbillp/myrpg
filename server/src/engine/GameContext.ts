import {
  GameState, GameEvent, NpcState, MonsterDef, LogEntry, QuestGoalType, GameDefs,
} from './types.js';
import type { PlayerDef } from './types.js';

export interface GameContext {
  readonly state: GameState;
  readonly playerDef: PlayerDef;
  readonly defs: GameDefs;

  addLog(entry: LogEntry | string): void;
  addLogs(entries: (LogEntry | string)[]): void;
  uid(): string;

  resolveMonsterDef(defId: string): MonsterDef | undefined;
  resolveNpcByEntity(entity: string): NpcState | undefined;
  assignCombatLabel(npc: NpcState): void;
  aggroFaction(npc: NpcState): void;
  advanceQuest(type: QuestGoalType): void;

  autoEndCombatIfNoEnemies(): void;
  resistMod(damage: number, damageType: string, def: MonsterDef, displayName: string): { finalDamage: number; log: LogEntry | null };
  applyDamageToPlayer(damage: number, events: GameEvent[]): void;
  killNpc(id: string): void;
  killWithReward(npc: NpcState, def: MonsterDef, killMessage: string, includeTotal?: boolean): void;
  applyMasteryConditions(target: NpcState, vexApplied: boolean, slowApplied: boolean): void;

  doStartCombat(events: GameEvent[]): void;
  doPlayerOpportunityAttack(npc: NpcState, events: GameEvent[]): void;

  /** Spawn an enemy near the player (uses `findFreeTileNear`). Returns the spawned NpcState or null when no tile is free in range. */
  spawnEnemyNearPlayer(monsterId: string, minDist?: number, maxDist?: number): NpcState | null;
  /** Spawn an enemy at a specific tile, falling back to the nearest free tile when the target is occupied / impassable. */
  spawnEnemyAt(monsterId: string, tx: number, ty: number): NpcState | null;
}
