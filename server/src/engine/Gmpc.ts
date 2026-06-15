/**
 * US-130 — GMPC (GM-controlled player character) support helpers.
 *
 * A GMPC is a full player character the GM controls and roleplays. It is held
 * on `GameState.gmpcs` as a `GmpcActor` carrying a complete `PlayerState`, and
 * the engine binds that state into the active-actor slot for its turn (see
 * `GameEngine.withActor`) so every player-mechanics path resolves against it
 * unchanged.
 *
 * For the GMPC to be **targeted, take a turn-order slot, and render**, it also
 * gets an ally `NpcState` "shell" in `state.npcs` (`gmpcId` set). The shell is
 * never an autonomous combatant — the turn loop and sim ticks skip it. HP,
 * position, and conditions are kept in sync between the shell (canonical while
 * enemies act on the map) and the `PlayerState` (canonical while the GMPC acts):
 *
 *   • `pullShellIntoActor` — before the GMPC's turn / on serialisation.
 *   • `pushActorIntoShell` — after the GMPC's turn / after any `gmpc_act`.
 *
 * This module also owns the two derived artefacts a GMPC needs at boot: a fresh
 * full-kit `PlayerState` from a `PlayerDef` (`buildGmpcPlayerState`, mirroring
 * the human path in `SessionBuilder`) and a synthetic `MonsterDef` shell stat
 * block (`buildGmpcShellDef`) so enemy targeting reads the GMPC's real AC.
 */
import type { GameDefs, MonsterDef, GameEvent } from './types.js';
import type { PlayerDef, PlayerState } from '../../../shared/types.js';
import type { NpcState } from '../../../shared/types/npcState.js';
import { PLAYER_FACTION_ID } from '../../../shared/types/factions.js';
import { mod } from './Dice.js';
import { speciesAbilityResources } from './SpeciesAbilities.js';
import { magicInitiateResources } from './MagicInitiate.js';
import { hasSpeedZero, TURN_CONDITIONS } from './ConditionSystem.js';

/** Stable combatant/shell id for a GMPC built from a `PlayerDef`. */
export function gmpcIdForDef(defId: string): string {
  return `gmpc_${defId}`;
}

/**
 * Build a fresh full-kit `PlayerState` for a GMPC from its `PlayerDef` — the
 * non-resume, non-dev-flag mirror of the human seed in `SessionBuilder`. The
 * GMPC fields its full class kit (spell slots, prepared spells, feature
 * resource pools, pact magic) at full / long-rest values.
 */
export function buildGmpcPlayerState(
  playerDef: PlayerDef,
  defs: GameDefs,
  tile: { x: number; y: number },
): PlayerState {
  return {
    defId: playerDef.id,
    tileX: tile.x, tileY: tile.y,
    hp: playerDef.maxHp,
    xp: playerDef.xp,
    balanceCp: playerDef.defaultCp ?? 0,
    inventoryIds: [...(playerDef.defaultInventoryIds ?? [])],
    equippedSlots: { ...playerDef.defaultEquipment },
    resources: {
      ...Object.fromEntries(
        (playerDef.defaultFeatureIds ?? [])
          .map((fid) => defs.features.find((f) => f.id === fid))
          .filter((f): f is NonNullable<typeof f> => !!f && !!f.resource && f.resource.kind !== 'unlimited')
          .map((f) => [f.id, f.resource!.max] as const),
      ),
      ...speciesAbilityResources(playerDef, defs.species),
      ...magicInitiateResources(playerDef),
    },
    actionUsed: false,
    bonusActionUsed: false,
    reactionUsed: false,
    freeObjectInteractionUsed: false,
    initiativeRoll: 0,
    movesLeft: 0,
    deathSaveSuccesses: 0,
    deathSaveFailures: 0,
    hitDiceUsed: 0,
    tempHp: 0,
    heroicInspiration: false,
    exhaustionLevel: 0,
    conditions: [],
    equippedSlotLabels: { armor: null, weapon: null, shield: null },
    ac: playerDef.ac,
    spellSlots: [...(playerDef.defaultSpellSlots ?? [])],
    pactMagic: playerDef.defaultPactMagic
      ? { remaining: playerDef.defaultPactMagic.max, max: playerDef.defaultPactMagic.max, level: playerDef.defaultPactMagic.level }
      : undefined,
    preparedSpellIds: [...(playerDef.defaultPreparedSpellIds ?? [])],
    concentratingOn: null,
    activeBuffs: [],
    mageArmor: false,
    shieldActive: false,
    speedBonus: 0,
    expeditiousRetreat: false,
    jumpMultiplier: 1,
    magicWeaponBonus: 0,
    seeInvisible: false,
    ongoingEffects: [],
  } as PlayerState;
}

/**
 * Synthetic `MonsterDef` so enemy targeting / initiative can read a GMPC shell's
 * stat block (AC, the six abilities, passive Perception, initiative). The GMPC
 * never acts through the NPC AI, so `attacks` is empty — the GM drives it.
 * `def` is the GMPC's built (level-up-replayed, equipped) `PlayerDef`.
 */
export function buildGmpcShellDef(def: PlayerDef): MonsterDef {
  return {
    id: def.id,
    name: def.name,
    type: `${capitalize(sizeWord(def))} Humanoid (${def.className})`,
    maxHp: def.maxHp,
    ac: def.ac,
    str: def.str, dex: def.dex, con: def.con, int: def.int, wis: def.wis, cha: def.cha,
    proficiencyBonus: def.proficiencyBonus,
    initiativeBonus: mod(def.dex),
    stealthBonus: def.skills['stealth'] ?? 0,
    passivePerception: 10 + (def.skills['perception'] ?? 0),
    speed: def.speed,
    attacks: [],
    xp: 0,
    cr: '—',
    color: def.color,
    tokenAsset: def.tokenAsset,
    size: def.size ?? 'medium',
  } as MonsterDef;
}

/**
 * Build the ally `NpcState` shell for a GMPC. `defId` is the `PlayerDef` id so
 * the client resolves its token from the player roster. Disposition `ally` +
 * the party faction makes enemies treat it as a hostile target through the
 * existing target picker — no targeting-code changes needed.
 */
export function buildGmpcShell(gmpcId: string, def: PlayerDef, st: PlayerState): NpcState {
  return {
    id: gmpcId,
    gmpcId,
    defId: def.id,
    name: def.name,
    revealedName: def.name,
    combatLabel: '',
    tileX: st.tileX, tileY: st.tileY,
    disposition: 'ally',
    attitude: 'friendly',
    factionId: PLAYER_FACTION_ID,
    hp: st.hp,
    maxHp: def.maxHp,
    tempHp: st.tempHp,
    size: def.size ?? 'medium',
    isActive: false,
    reactionUsed: false,
    conditions: [...st.conditions],
    inventoryIds: [],
    ongoingEffects: [],
  } as NpcState;
}

/** Copy the shell's map-canonical fields (hp/pos/conditions) into the bound
 *  `PlayerState`. Run before the GMPC's turn and on serialisation so its full
 *  state reflects damage / forced movement / conditions enemies imposed. */
export function pullShellIntoActor(shell: NpcState, st: PlayerState): void {
  st.tileX = shell.tileX;
  st.tileY = shell.tileY;
  st.hp = shell.hp;
  st.tempHp = shell.tempHp ?? 0;
  st.conditions = [...shell.conditions];
}

/**
 * Reset a GMPC's per-turn action economy at the start of its turn — the
 * active-actor equivalent of `enterPlayerTurn`'s reset, seeded with the PC's own
 * speed for movement. Expects the GMPC's `PlayerState` + its built `PlayerDef`.
 */
export function resetActorTurnEconomy(st: PlayerState, def: PlayerDef): void {
  st.actionUsed = false;
  st.bonusActionUsed = false;
  st.reactionUsed = false;
  st.attacksRemaining = 0;
  st.attackedThisTurn = false;
  st.offhandAttackUsedThisTurn = false;
  st.cleaveUsedThisTurn = false;
  st.freeObjectInteractionUsed = false;
  st.movedThisTurn = false;
  st.readiedAttack = false;
  st.steadyAim = false;
  st.sneakAttackUsedThisTurn = false;
  st.conditions = st.conditions.filter((c) => !TURN_CONDITIONS.includes(c));
  st.movesLeft = (hasSpeedZero(st.conditions) || st.hp <= 0) ? 0 : Math.floor((def.speed + (st.speedBonus ?? 0)) / 5);
}

/** Copy the bound `PlayerState`'s map-canonical fields back onto the shell.
 *  Run after the GMPC's turn and after any `gmpc_act` so the map, enemy
 *  targeting, and client see the GMPC's new position / HP / conditions. */
export function pushActorIntoShell(st: PlayerState, shell: NpcState): void {
  shell.tileX = st.tileX;
  shell.tileY = st.tileY;
  shell.hp = st.hp;
  shell.tempHp = st.tempHp;
  shell.conditions = [...st.conditions];
}

/**
 * Retag animation events emitted during a GMPC's action from the `'player'`
 * actor id to the GMPC's shell id, so the client animates the GMPC's token (its
 * movement, attack swings, cast VFX) instead of the human's. Safe to apply to
 * the whole action's event batch: while the GMPC is the bound `state.player`,
 * every `'player'` reference in those events is the GMPC (the human isn't
 * represented as `'player'` during that window) — including an enemy's
 * opportunity-attack `targetId` against the moving GMPC.
 */
export function retagPlayerEventsToActor(events: GameEvent[], actorId: string): void {
  const swap = (v: string | undefined): string | undefined => (v === 'player' ? actorId : v);
  for (const e of events) {
    const ev = e as Record<string, unknown>;
    switch (e.type) {
      case 'entity_move':
      case 'damage':
      case 'heal':
      case 'death':
      case 'condition_changed':
      case 'npc_speech':
        ev.entityId = swap(ev.entityId as string | undefined);
        break;
      case 'attack':
        ev.attackerId = swap(ev.attackerId as string | undefined);
        ev.targetId = swap(ev.targetId as string | undefined);
        break;
      case 'spell_vfx':
        ev.fromId = swap(ev.fromId as string | undefined);
        ev.toId = swap(ev.toId as string | undefined);
        break;
      case 'turn_started':
      case 'turn_ended':
        ev.combatantId = swap(ev.combatantId as string | undefined);
        break;
    }
  }
}

function sizeWord(def: PlayerDef): string {
  return def.size ?? 'medium';
}
function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
