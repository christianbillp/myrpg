// Mirror of server/src/engine/types.ts — keep in sync manually.

export type LogEntryStyle = 'normal' | 'hit' | 'crit' | 'kill' | 'heal' | 'status' | 'header' | 'miss';

export interface LogEntry {
  left: string;
  right?: string;
  style?: LogEntryStyle;
}

export type CombatMode = 'exploring' | 'player_turn' | 'enemy_turn' | 'death_saves' | 'defeat';
export type EncounterType = 'simple_combat' | 'social_interaction' | 'exploration';
export type QuestGoalType = 'kill' | 'collect' | 'explore' | 'talk';
export type Disposition = 'ally' | 'neutral' | 'enemy';

export interface EquipmentSlots {
  armorId: string | null;
  weaponId: string | null;
  shieldId: string | null;
}

export interface PlayerState {
  defId: string;
  tileX: number; tileY: number;
  hp: number; xp: number; gold: number;
  inventoryIds: string[];
  equippedSlots: EquipmentSlots;
  secondWindUses: number;
  hidden: boolean;
  actionUsed: boolean; bonusActionUsed: boolean; reactionUsed: boolean;
  movesLeft: number;
  deathSaveSuccesses: number; deathSaveFailures: number;
  hitDiceUsed: number;
  conditions: string[];
}

export interface NpcState {
  id: string; defId: string;
  tileX: number; tileY: number;
  disposition: Disposition;
  label: string;
  hp: number; maxHp: number;
  isActive: boolean; vexed: boolean; hidden: boolean;
  reactionUsed: boolean; conditions: string[];
}

export interface MapItemState {
  id: string; defId: string;
  tileX: number; tileY: number;
}

export interface SecretState {
  tileX: number; tileY: number;
  def: { id: string; dc: number };
}

export interface QuestState {
  id: string; title: string;
  goalType: QuestGoalType; goalTarget: number;
  rewardXp: number; rewardGp: number;
  progress: number; completed: boolean;
}

export interface GameMap {
  passable: boolean[][];
  cols: number; rows: number;
}

export interface NpcPersona { id: string; name: string; persona: string; }

export interface GameState {
  sessionId: string;
  phase: CombatMode;
  map: GameMap;
  player: PlayerState;
  npcs: NpcState[];
  mapItems: MapItemState[];
  secrets: SecretState[];
  combatLog: LogEntry[];
  logScrollOffset: number;
  encounterTypes: EncounterType[];
  mapName: string;
  quests: QuestState[];
  selectedTargetId: string | null;
  activeNpcIndex: number;
  turnOrderIds: string[];
  introduction: string;
  encounterContext: string;
  npcPersonas: NpcPersona[];
}

export type GameEvent =
  | { type: 'entity_move'; entityId: string; toX: number; toY: number }
  | { type: 'log'; lines: string[] };

export type PlayerAction =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'attack'; targetId?: string }
  | { type: 'hide' }
  | { type: 'secondWind' }
  | { type: 'dash' }
  | { type: 'dodge' }
  | { type: 'disengage' }
  | { type: 'endTurn' }
  | { type: 'rollDeathSave' }
  | { type: 'shortRest' }
  | { type: 'search' }
  | { type: 'usePotion' }
  | { type: 'equip'; slot: 'armor' | 'weapon' | 'shield'; itemId: string }
  | { type: 'unequip'; slot: 'armor' | 'weapon' | 'shield' }
  | { type: 'selectTarget'; entityId: string | null }
  | { type: 'scrollLog'; delta: number };

export type ServerWSMessage =
  | { type: 'state_update'; state: GameState; events: GameEvent[] }
  | { type: 'aidm_reply'; reply: string }
  | { type: 'error'; message: string };

export interface CreateSessionRequest {
  encounterTypes: EncounterType[];
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  savedMapId?: string;
  savedMapName?: string;
  savedMapDescription?: string;
  npcIds?: string[];
  resumeHp?: number;
  resumeXp?: number;
  resumeGold?: number;
  resumeInventoryIds?: string[];
  resumeEquippedSlots?: EquipmentSlots;
  resumeSecondWindUses?: number;
}
