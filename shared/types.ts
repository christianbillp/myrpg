// Single source of truth for types shared between client and server.
// Server-only types (GameDefs) live in server/src/engine/types.ts.

// ── Reference data types (feats, backgrounds, species) ───────────────────────

export interface FeatEffects {
  savageAttacker?: boolean;
  armorAcBonus?: number;
  initiativeProficiency?: boolean;
  initiativeSwap?: boolean;
  rangedAttackBonus?: number;
  greatWeaponFighting?: boolean;
  twoWeaponFightingBonus?: boolean;
  abilityScoreIncrease?: { abilities: string[]; amount?: number; distribution?: string; maxScore: number };
  grappleFromStrike?: boolean;
  advantageVsGrappled?: boolean;
  fastWrestler?: boolean;
  peerlessAim?: boolean;
  overcomeDamageResistance?: string[];
  critBonusDamageEqualToAbilityScore?: boolean;
  freeCasting?: { maxSlotLevel: number };
  blinkSteps?: { feet: number; trigger: string };
  improveFate?: { dice: string; rangeInFeet: number; rechargeOn: string };
  truesight?: { feet: number };
  skillOrToolProficiencies?: { count: number; choices: string };
  learnedCantrips?: { count: number; lists: string[] };
  preparedSpell?: { level: number; lists: string[]; freeCastsPerLongRest: number };
  spellcastingAbility?: { choices: string[] };
  [key: string]: unknown;
}

export interface FeatDef {
  id: string;
  name: string;
  category: 'origin' | 'general' | 'fighting-style' | 'epic-boon';
  prerequisites: {
    minLevel: number | null;
    minAbilityScore: { abilities: string[]; minValue: number } | null;
    requiresFeature: string | null;
    repeatable: boolean;
    repeatableNote?: string | null;
  };
  description: string;
  effects: FeatEffects;
}

export interface BackgroundDef {
  id: string;
  name: string;
  abilityScores: string[];
  feat: { id: string; options: Record<string, unknown> | null };
  skillProficiencies: string[];
  toolProficiency: string | { choices: string[]; count: number };
  equipmentOptions: Array<{
    label: string;
    items: Array<{ itemId?: string; name?: string; count?: number }>;
    gold: number;
  }>;
}

export interface SpeciesTraitEffects {
  darkvision?: { feet: number };
  damageResistance?: string[];
  savingThrowAdvantage?: Array<{ condition?: string; ability?: string }>;
  hpMaxBonus?: { atLevel1: number; perLevel: number };
  lineageChoice?: {
    spellcastingAbility: { choices: string[] };
    options: Array<{ id: string; level1?: { speedBonus?: number; [k: string]: unknown }; [k: string]: unknown }>;
  };
  [key: string]: unknown;
}

export interface SpeciesTrait {
  name: string;
  description: string;
  effects: SpeciesTraitEffects;
}

export interface SpeciesDef {
  id: string;
  name: string;
  creatureType: string;
  size: string | { choices: string[] };
  speed: number;
  traits: SpeciesTrait[];
}

// ── Entity definitions (characters, monsters, NPCs) ──────────────────────────

export interface PlayerAttack {
  name: string;
  statKey: 'str' | 'dex';
  damageDice: number;
  damageSides: number;
  damageType: string;
  savageAttacker: boolean;
  graze: boolean;
  vex: boolean;
  sap: boolean;
  slow: boolean;
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
  speciesId: string;
  speciesLineage: string | null;
  className: string;
  backgroundId: string;
  featIds: string[];
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
  color: number;
  xp: number;
  savageAttacker: boolean;
  fightingStyleDefense: boolean;
  defaultEquipment: EquipmentSlots;
  defaultInventoryIds: string[];
  mainAttack: PlayerAttack;
  description?: string;
}

export interface MonsterAttack {
  name: string;
  attackType: 'melee' | 'ranged' | 'both';
  bonus: number;
  reach: number;
  rangeNormal?: number;
  rangeLong?: number;
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
  hpFormula?: string;
  ac: number;
  str: number; dex: number; con: number; int: number; wis: number; cha: number;
  proficiencyBonus: number;
  savingThrows?: Record<string, number>;
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
  immunities?: string[];
  conditionImmunities?: string[];
  nimbleEscape?: boolean;
  combatSpawn?: boolean;
}

export interface NPCDef {
  id: string;
  name: string;
  monsterClass: string;
  color: number;
  persona?: string;
}

// ── Equipment item types ─────────────────────────────────────────────────────

export interface ConsumableDef {
  id: string; name: string; type: 'consumable';
  healDice: number; healSides: number; healBonus: number;
}

export type ArmorCategory = 'light' | 'medium' | 'heavy';

export interface ArmorDef {
  id: string; name: string; type: 'armor';
  category: ArmorCategory;
  baseAc: number; addDex: boolean; maxDex: number | null;
  stealthDisadv?: boolean;
  minStr?: number | null;
  cost?: number;
}

export interface ShieldDef {
  id: string; name: string; type: 'shield';
  acBonus: number;
  cost?: number;
}

export type WeaponMastery = 'graze' | 'vex' | 'sap' | 'nick' | 'topple' | 'push' | 'cleave' | 'slow';

export interface WeaponDef {
  id: string; name: string; type: 'weapon';
  statKey: 'str' | 'dex';
  damageDice: number; damageSides: number; damageType: string;
  mastery: WeaponMastery | string | null;
  finesse: boolean; twoHanded: boolean;
  thrown: boolean; throwNormal: number; throwLong: number;
  cost?: number;
}

export type EquipmentDef = ArmorDef | ShieldDef | WeaponDef;
export type ItemDef = ConsumableDef | EquipmentDef;

// ── Encounter / quest types ──────────────────────────────────────────────────

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

// Map definition as served by the API (client receives processed boolean grid).
export interface SavedMapDef {
  id: string;
  name: string;
  mapdescription: string;
  cols: number;
  rows: number;
  passable: boolean[][];
}

// Encounter card definition (the JSON files in server/data/encounters/).
export interface EncounterDef {
  id: string;
  encounterTitle: string;
  description: string;
  encounterTypes: EncounterType[];
  mapId: string;
  npcIds?: string[];
  allyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  startingZones?: string[];
}

// ── Combat log ───────────────────────────────────────────────────────────────

export type LogEntryStyle = 'normal' | 'hit' | 'crit' | 'kill' | 'heal' | 'status' | 'header' | 'miss';

export interface LogEntry {
  left: string;
  right?: string;
  style?: LogEntryStyle;
}

// ── Game state ───────────────────────────────────────────────────────────────

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
  actionUsed: boolean;
  bonusActionUsed: boolean;
  reactionUsed: boolean;
  movesLeft: number;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
  hitDiceUsed: number;
  tempHp: number;
  heroicInspiration: boolean;
  exhaustionLevel: number;
  conditions: string[];
  equippedSlotLabels: { armor: string | null; weapon: string | null; shield: string | null };
}

export interface AvailableActions {
  canAttack: boolean;
  throwableItemIds: string[];
  canHide: boolean;
  canSecondWind: boolean;
  canDash: boolean;
  canDodge: boolean;
  canDisengage: boolean;
  canShortRest: boolean;
}

// Unified NPC state — covers neutral social NPCs, allied combatants, and enemies.
// disposition drives rendering (token colour, HP bar) and AI (who they attack).
export interface NpcState {
  id: string;
  defId: string;
  name: string;
  tileX: number;
  tileY: number;
  disposition: Disposition;
  factionId: string;
  combatLabel: string;
  revealedName?: string;
  combatPassive?: boolean;
  hp: number;
  maxHp: number;
  isActive: boolean;
  reactionUsed: boolean;
  conditions: string[];
  inventoryIds: string[];
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
  encounterTitle: string;
  quests: QuestState[];
  selectedTargetId: string | null;
  activeNpcIndex: number;
  turnOrderIds: string[];
  introduction: string;
  encounterContext: string;
  npcPersonas: NpcPersona[];
  availableActions: AvailableActions;
}

// ── Animation events ─────────────────────────────────────────────────────────

export type GameEvent =
  | { type: 'entity_move'; entityId: string; toX: number; toY: number }
  | { type: 'log'; lines: string[] };

// ── Player actions ───────────────────────────────────────────────────────────

export type PlayerAction =
  | { type: 'move'; dx: number; dy: number }
  | { type: 'moveTo'; tileX: number; tileY: number }
  | { type: 'attack'; targetId?: string }
  | { type: 'throw'; itemId: string; targetId?: string }
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

// ── WebSocket protocol (server → client) ─────────────────────────────────────

export type ServerWSMessage =
  | { type: 'state_update'; state: GameState; events: GameEvent[] }
  | { type: 'aidm_reply'; reply: string }
  // Streaming AIDM protocol — emitted during processAIDMChat:
  //   aidm_start: a new AIDM turn has begun; the client opens a fresh
  //     assistant bubble (baseline = 0).
  //   aidm_chunk: text delta appended to the current assistant bubble.
  //   aidm_checkpoint: the chunks since the last checkpoint are canonical —
  //     the client advances its discard baseline to the current text length.
  //   aidm_speculative_discard: the chunks since the last checkpoint were
  //     written before a roll-requesting tool and must be removed from the
  //     visible bubble. Client rolls back to the discard baseline.
  //   aidm_done: the final, persisted reply text + roll-result strings.
  | { type: 'aidm_start' }
  | { type: 'aidm_chunk'; text: string }
  | { type: 'aidm_checkpoint' }
  | { type: 'aidm_speculative_discard' }
  | { type: 'aidm_done'; reply: string; rollResults: string[] }
  | { type: 'error'; message: string };

// ── Session creation ─────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  encounterTypes: EncounterType[];
  mapType: 'open' | 'rooms' | 'saved';
  playerDefId: string;
  savedMapId?: string;
  encounterTitle?: string;
  savedMapName?: string;
  savedMapDescription?: string;
  npcIds?: string[];
  allyIds?: string[];
  customIntroduction?: string;
  customContext?: string;
  startingZones?: string[];
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

// ── Save / story log ─────────────────────────────────────────────────────────

export interface EncounterLogLine {
  type: 'combat' | 'dm_player' | 'dm_reply';
  text: string;
}

export interface EncounterRecord {
  id: string;
  timestamp: string;
  description: string;
  encounterTitle: string;
  xpGained: number;
  goldGained: number;
  outcome: 'survived' | 'defeated';
  lines: EncounterLogLine[];
}

export interface StorylogEntry {
  encounterId: string;
  narrative: string;
}
