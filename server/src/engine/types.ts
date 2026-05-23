// ── Data-model types (mirrors of client/src/data/) ────────────────────────────

export interface PlayerAttack {
  name: string;
  statKey: 'str' | 'dex';
  damageDice: number;
  damageSides: number;
  damageType: string;
  savageAttacker: boolean;
  graze: boolean;
  vex: boolean;
}

export interface EquipmentSlots {
  armorId: string | null;
  weaponId: string | null;
  shieldId: string | null;
}

export interface PlayerDef {
  id: string;
  name: string;
  speciesName: string;
  className: string;
  level: number;
  maxHp: number;
  ac: number;
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
  proficiencyBonus: number;
  skills: Record<string, number>;
  savingThrowProficiencies: string[];
  savingThrows: Record<string, number>;
  secondWindMaxUses: number;
  hitDieType: number;
  sneakAttackDice: number;
  speed: number;
  speedFt: number;
  color: number;
  xp: number;
  savageAttacker: boolean;
  fightingStyleDefense: boolean;
  defaultEquipment: EquipmentSlots;
  defaultInventoryIds: string[];
  mainAttack: PlayerAttack;
}

export interface MonsterAttack {
  name: string;
  attackType: 'melee' | 'ranged' | 'both';
  bonus: number;
  reach: number;
  damageDice: number;
  damageSides: number;
  damageBonus: number;
  damageType: string;
}

export interface MonsterDef {
  id: string;
  name: string;
  type: string;
  maxHp: number;
  ac: number;
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
  proficiencyBonus: number;
  initiativeBonus: number;
  stealthBonus: number;
  passivePerception: number;
  speed: number;
  attacks: MonsterAttack[];
  xp: number;
  cr: string;
  color: number;
  resistances?: string[];
  vulnerabilities?: string[];
}

export interface NPCDef {
  id: string;
  name: string;
  monsterClass: string;
  color: number;
  persona?: string;
}

export interface ConsumableDef {
  id: string; name: string; type: 'consumable';
  healDice: number; healSides: number; healBonus: number;
}

export interface ArmorDef {
  id: string; name: string; type: 'armor';
  baseAc: number; addDex: boolean; maxDex: number | null;
}

export interface ShieldDef {
  id: string; name: string; type: 'shield';
  acBonus: number;
}

export interface WeaponDef {
  id: string; name: string; type: 'weapon';
  statKey: 'str' | 'dex';
  damageDice: number; damageSides: number; damageType: string;
  mastery: string | null; finesse: boolean; twoHanded: boolean;
}

export type ItemDef = ConsumableDef | ArmorDef | ShieldDef | WeaponDef;

// ── Encounter / quest types ────────────────────────────────────────────────────

export type EncounterType = 'simple_combat' | 'social_interaction' | 'exploration';
export type QuestGoalType = 'kill' | 'collect' | 'explore' | 'talk';

export type SecretReward =
  | { type: 'gold'; amount: number }
  | { type: 'item'; itemId: string }
  | { type: 'lore'; text: string };

export interface SecretDef {
  id: string; dc: number; reward: SecretReward; successText: string; failureText: string;
}

export interface QuestDef {
  id: string; title: string;
  goal: { type: QuestGoalType; target: number };
  rewardXp: number; rewardGp: number;
}

// ── Combat log ────────────────────────────────────────────────────────────────

export type LogEntryStyle = 'normal' | 'hit' | 'crit' | 'kill' | 'heal' | 'status' | 'header' | 'miss';

export interface LogEntry {
  left: string;
  right?: string;
  style?: LogEntryStyle;
}

// ── Game state ─────────────────────────────────────────────────────────────────

export type CombatMode = 'exploring' | 'player_turn' | 'enemy_turn' | 'death_saves' | 'defeat';

export type Disposition = 'ally' | 'neutral' | 'enemy';

export interface PlayerState {
  defId: string;
  tileX: number;
  tileY: number;
  hp: number;
  xp: number;
  gold: number;
  inventoryIds: string[];
  equippedSlots: EquipmentSlots;
  secondWindUses: number;
  hidden: boolean;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  reactionUsed: boolean;
  movesLeft: number;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
  hitDiceUsed: number;
  conditions: string[];
}

// Unified NPC state — covers neutral social NPCs, allied combatants, and enemies.
// disposition drives rendering (token colour, HP bar) and AI (who they attack).
export interface NpcState {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
  disposition: Disposition;
  label: string;
  hp: number;
  maxHp: number;
  isActive: boolean;
  vexed: boolean;
  hidden: boolean;
  reactionUsed: boolean;
  conditions: string[];
}

export interface MapItemState {
  id: string;
  defId: string;
  tileX: number;
  tileY: number;
}

export interface SecretState {
  tileX: number;
  tileY: number;
  def: SecretDef;
}

export interface QuestState {
  id: string;
  title: string;
  goalType: QuestGoalType;
  goalTarget: number;
  rewardXp: number;
  rewardGp: number;
  progress: number;
  completed: boolean;
}

export interface GameMap {
  passable: boolean[][];
  cols: number;
  rows: number;
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

// ── Animation events ───────────────────────────────────────────────────────────

export type GameEvent =
  | { type: 'entity_move'; entityId: string; toX: number; toY: number }
  | { type: 'log'; lines: string[] };

// ── Player actions ─────────────────────────────────────────────────────────────

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

// ── WebSocket protocol (server → client) ──────────────────────────────────────

export type ServerWSMessage =
  | { type: 'state_update'; state: GameState; events: GameEvent[] }
  | { type: 'aidm_reply'; reply: string }
  | { type: 'error'; message: string };

// ── Session creation ──────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  encounterTypes: EncounterType[];
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  savedMapId?: string;
  npcIds?: string[];
  resumeHp?: number;
  resumeXp?: number;
  resumeGold?: number;
  resumeInventoryIds?: string[];
  resumeEquippedSlots?: EquipmentSlots;
  resumeSecondWindUses?: number;
}

export interface CreateSessionResponse {
  sessionId: string;
  state: GameState;
}
