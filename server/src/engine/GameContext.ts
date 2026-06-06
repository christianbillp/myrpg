import {
  GameState, GameEvent, NpcState, MonsterDef, LogEntry, GameDefs,
} from './types.js';
import type { PlayerDef, EngineEvent } from './types.js';
import type { EventBus } from './EventBus.js';

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

  autoEndCombatIfNoEnemies(): void;
  resistMod(damage: number, damageType: string, def: MonsterDef, displayName: string): { finalDamage: number; log: LogEntry | null };
  /** Apply damage to the player. When `damageType` is supplied, the player's
   *  species-granted resistances / vulnerabilities / immunities (US-108) are
   *  applied first; omit it for untyped/abstract damage (no resistance). */
  applyDamageToPlayer(damage: number, events: GameEvent[], damageType?: string): void;
  killNpc(id: string): void;
  killWithReward(npc: NpcState, def: MonsterDef, killMessage: string, includeTotal?: boolean): void;
  applyMasteryConditions(target: NpcState, vexApplied: boolean, slowApplied: boolean): void;

  doStartCombat(events: GameEvent[]): void;
  doPlayerOpportunityAttack(npc: NpcState, events: GameEvent[]): void;

  /** Spawn an enemy near the player (uses `findFreeTileNear`). Returns the spawned NpcState or null when no tile is free in range. */
  spawnEnemyNearPlayer(monsterId: string, minDist?: number, maxDist?: number): NpcState | null;
  /** Spawn an enemy at a specific tile, falling back to the nearest free tile when the target is occupied / impassable. */
  spawnEnemyAt(monsterId: string, tx: number, ty: number): NpcState | null;
  /** Conjure a player-owned summon (Mage Hand, Unseen Servant) at a tile. Despawns any existing summon of the same `spellId`. */
  spawnSummon(monsterId: string, spellId: string, tx: number, ty: number): NpcState | null;

  /** Synchronous event bus — see EventBus.ts. Publishers should call this at well-defined moments; subscribers (TriggerSystem etc.) react. */
  readonly bus: EventBus;
  /** Convenience shorthand for `ctx.bus.publish(event)`. */
  publish(event: EngineEvent): void;

  /**
   * Removes an NPC from the encounter entirely (not killed — they escaped).
   * Used when a fleeing creature reaches the map edge. The NPC is filtered
   * out of `state.npcs`; combat auto-ends if no enemies remain.
   */
  removeNpc(id: string): void;

  /**
   * The events array for the *current* outer call (typically `processAction`
   * or an AIGM tool invocation). Synchronous engine subsystems that don't
   * receive an explicit `events` parameter (notably TriggerSystem actions)
   * append to this so their `entity_move` / animation events make it back to
   * the client. Null when no outer call is in flight.
   */
  eventSink: GameEvent[] | null;

  /**
   * True only during `GameEngine`'s constructor, while the encounter_started
   * triggers are firing. Read by `doStartCombat` to know it should defer
   * `advanceTurn` — the first enemy turn must not run inside session
   * construction or the client never gets a chance to see it animate.
   * See `GameEngine.runPendingTurnAdvance` for the deferred path.
   */
  isConstructing: boolean;
  /**
   * Back-reference to the owning GameEngine, used by subsystems that need
   * access to engine-only state (e.g. ConversationSystem reads the in-memory
   * NpcSave map and routes non-conversation effects through
   * `fireSingleAction`). Typed loosely to avoid the cyclic import.
   */
  engineRef: {
    fireSingleAction(action: import('../../../shared/types.js').TriggerAction): void;
    getNpcSaves(): Map<string, import('../../../shared/types.js').NpcSave>;
  } | null;
}
