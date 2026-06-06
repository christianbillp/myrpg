/**
 * Test context factory — a tiny builder that returns a real `GameContext`
 * + `GameState` suitable for unit / integration tests of the engine's
 * pure layers (sim, awareness, combat math).
 *
 * Built around two principles:
 *
 *   1. **Real EventBus.** Tests should exercise the actual pub/sub
 *      surface, not a mock. The bus is cheap to instantiate.
 *
 *   2. **Minimal but valid state.** Every field that a code path under
 *      test might read needs a sensible default — we'd rather a test
 *      fail on real behaviour than on `undefined.foo`. The defaults
 *      below mirror what `SessionBuilder` produces for a freshly-spawned
 *      encounter (empty inventory, no conditions, phase `exploring`,
 *      tick counters at zero).
 *
 * Override anything the test needs via the `overrides` argument. The
 * shape mirrors `GameState` so the override merges layer by layer.
 *
 * @example
 *   const { ctx, state } = buildTestContext({
 *     player: { tileX: 5, tileY: 5 },
 *     npcs: [makeNpc({ id: 'guard1', tileX: 10, tileY: 10, factionId: 'town_guard' })],
 *   });
 */
import type { GameContext } from '../engine/GameContext.js';
import type {
  GameState, NpcState, PlayerDef, GameDefs, MonsterDef,
  LogEntry, GameEvent,
} from '../engine/types.js';
import { EventBus } from '../engine/EventBus.js';

export interface TestContextOverrides {
  player?: Partial<GameState['player']>;
  playerDef?: Partial<PlayerDef>;
  npcs?: NpcState[];
  map?: Partial<GameState['map']>;
  phase?: GameState['phase'];
  worldTickCount?: number;
  dayPhase?: GameState['dayPhase'];
  monsters?: MonsterDef[];
}

export interface TestContextResult {
  ctx: GameContext;
  state: GameState;
  playerDef: PlayerDef;
  defs: GameDefs;
  /** Captured events from `ctx.eventSink` — read directly to assert
   *  what fired during the system-under-test. */
  events: GameEvent[];
  /** Captured log entries pushed via `ctx.addLog`. */
  logs: LogEntry[];
}

/** Build a fully open (no movement/sight blocking) 20x20 grid by default. */
function makeMap(overrides?: Partial<GameState['map']>): GameState['map'] {
  const cols = overrides?.cols ?? 20;
  const rows = overrides?.rows ?? 20;
  const blocksMovement =
    overrides?.blocksMovement ??
    Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const blocksSight =
    overrides?.blocksSight ??
    Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  return {
    cols,
    rows,
    blocksMovement,
    blocksSight,
    ...overrides,
  } as GameState['map'];
}

function makePlayer(overrides?: Partial<GameState['player']>): GameState['player'] {
  return {
    defId: 'test_player',
    tileX: 0,
    tileY: 0,
    hp: 20,
    xp: 0,
    balanceCp: 0,
    inventoryIds: [],
    equippedSlots: { armorId: null, weaponId: null, shieldId: null },
    resources: {},
    actionUsed: false,
    bonusActionUsed: false,
    reactionUsed: false,
    freeObjectInteractionUsed: false,
    initiativeRoll: 0,
    movesLeft: 6,
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    hitDiceUsed: 0,
    tempHp: 0,
    heroicInspiration: false,
    exhaustionLevel: 0,
    conditions: [],
    equippedSlotLabels: { armor: null, weapon: null, shield: null },
    ac: 10,
    spellSlots: [],
    preparedSpellIds: [],
    concentratingOn: null,
    mageArmor: false,
    ...overrides,
  } as GameState['player'];
}

function makePlayerDef(overrides?: Partial<PlayerDef>): PlayerDef {
  return {
    id: 'test_player',
    name: 'Test Player',
    classId: 'fighter',
    level: 1,
    speciesId: 'human',
    color: 0x00ff00,
    maxHp: 20,
    ac: 10,
    str: 14,
    dex: 14,
    con: 14,
    int: 10,
    wis: 10,
    cha: 10,
    speed: 30,
    proficiencyBonus: 2,
    initiativeBonus: 2,
    passivePerception: 10,
    skills: {},
    savingThrows: { str: 2, dex: 2, con: 2, int: 0, wis: 0, cha: 0 },
    defaultEquipment: { armorId: null, weaponId: null, shieldId: null },
    defaultInventoryIds: [],
    defaultFeatureIds: [],
    defaultCantripIds: [],
    defaultSpellbookIds: [],
    defaultPreparedSpellIds: [],
    defaultSpellSlots: [],
    tracks: {},
    featIds: [],
    ...overrides,
  } as PlayerDef;
}

/**
 * Build a complete NpcState with sane defaults. The only required
 * fields are id + tileX/tileY; everything else has a reasonable
 * fallback so tests can stay terse.
 */
export function makeNpc(overrides: Partial<NpcState> & { id: string }): NpcState {
  return {
    defId: overrides.defId ?? 'commoner',
    name: overrides.name ?? overrides.id,
    combatLabel: '',
    tileX: overrides.tileX ?? 0,
    tileY: overrides.tileY ?? 0,
    disposition: 'neutral',
    attitude: 'indifferent',
    factionId: overrides.factionId ?? overrides.id,
    hp: 10,
    maxHp: 10,
    isActive: false,
    reactionUsed: false,
    conditions: [],
    inventoryIds: [],
    ongoingEffects: [],
    ...overrides,
  } as NpcState;
}

export function buildTestContext(overrides: TestContextOverrides = {}): TestContextResult {
  const state: GameState = {
    mapName: 'test-map',
    encounterContext: 'test',
    phase: overrides.phase ?? 'exploring',
    map: makeMap(overrides.map),
    player: makePlayer(overrides.player),
    npcs: overrides.npcs ?? [],
    mapItems: [],
    secrets: [],
    npcPersonas: [],
    eventLog: [],
    worldTickCount: overrides.worldTickCount ?? 0,
    dayPhase: overrides.dayPhase ?? 'morning',
    turnOrderIds: [],
    activeNpcIndex: 0,
    factionStandings: {},
    factionRelations: {},
    discoveredFactions: [],
    rumors: [],
    worldFlags: {},
    triggers: [],
    firedTriggerIds: [],
    pendingAigmEvents: [],
    narrationLastUsed: {},
    objective: '',
    quests: [],
    encounterComplete: false,
    selectedTargetId: null,
    pendingReaction: null,
    pendingReroll: null,
  } as unknown as GameState;

  const playerDef = makePlayerDef(overrides.playerDef);
  const defs: GameDefs = {
    monsters: overrides.monsters ?? [],
    npcs: [],
    factions: [],
    equipment: [],
    spells: [],
    features: [],
    feats: [],
    backgrounds: [],
    species: [],
    classes: [],
    subclasses: [],
    conversations: [],
    narration: [],
  } as unknown as GameDefs;

  const events: GameEvent[] = [];
  const logs: LogEntry[] = [];
  const bus = new EventBus();

  const ctx: GameContext = {
    state,
    playerDef,
    defs,
    addLog(entry) {
      logs.push(typeof entry === 'string' ? { left: entry, style: 'status' } : entry);
    },
    addLogs(entries) {
      for (const e of entries) {
        logs.push(typeof e === 'string' ? { left: e, style: 'status' } : e);
      }
    },
    uid: (() => { let i = 0; return () => `t${++i}`; })(),
    resolveMonsterDef(defId) { return defs.monsters.find((m) => m.id === defId); },
    resolveNpcByEntity(entity) { return state.npcs.find((n) => n.id === entity); },
    assignCombatLabel() { /* no-op */ },
    aggroFaction() { /* no-op */ },
    autoEndCombatIfNoEnemies() { /* no-op */ },
    resistMod(damage) { return { finalDamage: damage, log: null }; },
    applyDamageToPlayer(damage) { state.player.hp = Math.max(0, state.player.hp - damage); },
    killNpc(id) { const n = state.npcs.find((x) => x.id === id); if (n) n.hp = 0; },
    killWithReward() { /* no-op */ },
    knockOutNpc(npc) { npc.conditions.push('unconscious', 'stable'); },
    applyMasteryConditions() { /* no-op */ },
    doStartCombat() { /* no-op */ },
    doPlayerOpportunityAttack() { /* no-op */ },
    spawnEnemyNearPlayer() { return null; },
    spawnEnemyAt() { return null; },
    spawnSummon() { return null; },
    bus,
    publish(event) { bus.publish(event); },
    removeNpc(id) { state.npcs = state.npcs.filter((n) => n.id !== id); },
    eventSink: events,
    isConstructing: false,
    engineRef: null,
  };

  return { ctx, state, playerDef, defs, events, logs };
}
