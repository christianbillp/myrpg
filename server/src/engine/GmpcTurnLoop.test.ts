/**
 * US-130 — GMPC turn-loop + shell integration.
 *
 * These exercise the engine-level seams that make a GMPC a real combatant:
 *   • `advanceTurn` hands a GMPC's initiative slot to the GM-driven `gmpc_turn`
 *     phase (it does NOT run NPC AI on the shell), and skips a downed GMPC.
 *   • the shell ⇄ actor sync keeps HP/position consistent across the boundary.
 *   • the builders produce a full-kit PlayerState + a targetable shell stat block.
 */
import { describe, it, expect } from 'vitest';
import { advanceTurn } from './CombatFlow.js';
import { doMoveTo, doMove } from './ExplorationActions.js';
import { gmpcTakeCombatTurn } from './GmpcCombatAI.js';
import {
  buildGmpcPlayerState, buildGmpcShell, buildGmpcShellDef,
  pullShellIntoActor, pushActorIntoShell, gmpcIdForDef, retagPlayerEventsToActor,
} from './Gmpc.js';
import type { GameEvent } from './types.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { PlayerDef, GameDefs, PlayerState, MonsterDef, PlayerAction } from './types.js';

function goblinDef(): MonsterDef {
  return {
    id: 'goblin', name: 'Goblin', type: 'Small Humanoid', maxHp: 7, ac: 12,
    str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8, proficiencyBonus: 2, initiativeBonus: 2,
    stealthBonus: 0, passivePerception: 9, speed: 30, attacks: [], xp: 50, cr: '1/4',
    color: 0x44aa77, tokenAsset: 'g.svg', size: 'small',
  } as MonsterDef;
}

function rangerDef(): PlayerDef {
  return {
    id: 'lyra', name: 'Lyra', className: 'Ranger', level: 3, speciesId: 'elf', speciesName: 'Elf',
    color: 0x33aa55, maxHp: 28, ac: 15,
    str: 10, dex: 16, con: 14, int: 10, wis: 14, cha: 10,
    speed: 30, proficiencyBonus: 2, passivePerception: 13,
    skills: { perception: 4, stealth: 5 }, savingThrows: {},
    defaultEquipment: { armorId: null, weaponId: null, shieldId: null },
    defaultInventoryIds: [], defaultFeatureIds: [], defaultCantripIds: [],
    defaultSpellbookIds: [], defaultPreparedSpellIds: ['hunters-mark'],
    defaultSpellSlots: [3], tracks: {}, featIds: [],
    tokenAsset: '/tokens/lyra.svg', size: 'medium',
    spellcastingAbility: 'wis',
  } as unknown as PlayerDef;
}

const DEFS = { features: [], species: [], classes: [] } as unknown as GameDefs;

describe('GMPC builders (US-130)', () => {
  it('buildGmpcPlayerState seeds a full-kit PC at long-rest values', () => {
    const st = buildGmpcPlayerState(rangerDef(), DEFS, { x: 4, y: 5 });
    expect(st.hp).toBe(28);
    expect(st.spellSlots).toEqual([3]);
    expect(st.preparedSpellIds).toEqual(['hunters-mark']);
    expect([st.tileX, st.tileY]).toEqual([4, 5]);
    expect(st.actionUsed).toBe(false);
  });

  it('buildGmpcShellDef exposes the PC AC + dex-based initiative to enemy targeting', () => {
    const def = buildGmpcShellDef(rangerDef());
    expect(def.ac).toBe(15);
    expect(def.initiativeBonus).toBe(3);     // mod(16)
    expect(def.passivePerception).toBe(14);  // 10 + perception 4
    expect(def.attacks).toEqual([]);         // the GM drives it; no NPC AI attacks
  });

  it('the shell carries the gmpc marker + the PlayerDef id (for client token resolution)', () => {
    const st = buildGmpcPlayerState(rangerDef(), DEFS, { x: 1, y: 1 });
    const shell = buildGmpcShell('gmpc_lyra', rangerDef(), st);
    expect(shell.gmpcId).toBe('gmpc_lyra');
    expect(shell.defId).toBe('lyra');
    expect(shell.disposition).toBe('ally');
    expect(shell.maxHp).toBe(28);
  });

  it('shell ⇄ actor sync round-trips HP / position / conditions', () => {
    const st = buildGmpcPlayerState(rangerDef(), DEFS, { x: 1, y: 1 });
    const shell = buildGmpcShell('gmpc_lyra', rangerDef(), st);
    // An enemy hits the shell and shoves it prone.
    shell.hp = 12; shell.tileX = 3; shell.tileY = 7; shell.conditions = ['prone'];
    pullShellIntoActor(shell, st);
    expect(st.hp).toBe(12);
    expect([st.tileX, st.tileY]).toEqual([3, 7]);
    expect(st.conditions).toEqual(['prone']);
    // The GMPC stands and moves on its turn; write back to the shell.
    st.conditions = []; st.tileX = 4; st.hp = 12;
    pushActorIntoShell(st, shell);
    expect(shell.conditions).toEqual([]);
    expect(shell.tileX).toBe(4);
  });
});

describe('GMPC turn loop (US-130)', () => {
  function setup() {
    const id = gmpcIdForDef('lyra');
    const def = rangerDef();
    const st: PlayerState = buildGmpcPlayerState(def, DEFS, { x: 2, y: 2 });
    const shell = buildGmpcShell(id, def, st);
    const { ctx, state } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0 },
      npcs: [
        shell,
        makeNpc({ id: 'enemy_x', defId: 'goblin', tileX: 8, tileY: 8, disposition: 'enemy', hp: 7, maxHp: 7 }),
      ],
    });
    state.gmpcs = [{ id, defId: 'lyra', state: st }];
    ctx.defs.monsters.push(buildGmpcShellDef(def));  // so resolveMonsterDef finds the shell's speed
    return { ctx, state, id };
  }

  it('advanceTurn resolves a GMPC slot via the deterministic AI, then continues', () => {
    const { ctx, state, id } = setup();
    let ran: string | null = null;
    (ctx as { engineRef: unknown }).engineRef = { runGmpcTurn: (gid: string) => { ran = gid; } };
    state.turnOrderIds = ['player', id];
    state.activeNpcIndex = 0;  // player just acted; next is the GMPC

    advanceTurn(ctx, []);

    expect(ran).toBe(id);                       // the GMPC took its (instant) turn
    expect(state.phase).toBe('player_turn');    // …and the loop wrapped back to the player
    const shell = state.npcs.find((n) => n.gmpcId === id)!;
    expect(shell.isActive).toBe(false);         // its active highlight was cleared after acting
  });

  it('a downed GMPC in the order is skipped to the next live combatant', () => {
    const { ctx, state, id } = setup();
    let ran = false;
    (ctx as { engineRef: unknown }).engineRef = { runGmpcTurn: () => { ran = true; } };
    const shell = state.npcs.find((n) => n.gmpcId === id)!;
    shell.hp = 0;                       // GMPC is down
    state.turnOrderIds = [id, 'player'];
    state.activeNpcIndex = 1;           // player last; next is the downed GMPC

    advanceTurn(ctx, []);

    expect(ran).toBe(false);                    // did not run a turn for the downed GMPC
    expect(state.phase).toBe('player_turn');    // skipped to the player
  });
});

describe('GMPC deterministic combat AI (US-130)', () => {
  const FIRE_BOLT = {
    id: 'fire-bolt', name: 'Fire Bolt', level: 0, school: 'evocation', classes: ['wizard'],
    castingTime: 'action', range: '120 feet', rangeFeet: 120,
    components: { verbal: true, somatic: true, material: null },
    duration: 'Instantaneous', concentration: false, ritual: false,
    attack: 'ranged-spell', damage: { dice: 1, sides: 10, bonus: 0, type: 'fire' },
  };

  function combatCtx(enemyTile: [number, number], opts?: { withSpell?: boolean; withWeapon?: boolean }) {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, movesLeft: 6, spellSlots: [], preparedSpellIds: [] },
      playerDef: {
        int: 16, dex: 12, str: 12, proficiencyBonus: 2,
        spellcastingAbility: opts?.withSpell ? 'int' : undefined,
        defaultCantripIds: opts?.withSpell ? ['fire-bolt'] : [],
        mainAttack: opts?.withWeapon
          ? { name: 'Dagger', statKey: 'dex', damageDice: 1, damageSides: 4, damageType: 'piercing' } as unknown as PlayerDef['mainAttack']
          : undefined,
      },
      monsters: [goblinDef()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'goblin', tileX: enemyTile[0], tileY: enemyTile[1], disposition: 'enemy', hp: 7, maxHp: 7 })],
    });
    r.state.environment = { lightLevel: 'bright' };
    r.state.traps = [];
    if (opts?.withSpell) r.ctx.defs.spells.push(FIRE_BOLT as unknown as (typeof r.ctx.defs.spells)[number]);
    return r;
  }

  it('casts an in-range offensive spell at the nearest enemy', () => {
    const { ctx } = combatCtx([2, 0], { withSpell: true });
    const acts: PlayerAction[] = [];
    gmpcTakeCombatTurn(ctx, (a) => acts.push(a));
    expect(acts).toHaveLength(1);
    expect(acts[0]).toEqual({ type: 'castSpell', spellId: 'fire-bolt', slotLevel: 0, targetIds: ['enemy_x'] });
  });

  it('moves toward an out-of-melee-range enemy when it has only a weapon', () => {
    const { ctx } = combatCtx([8, 0], { withWeapon: true });
    const acts: PlayerAction[] = [];
    gmpcTakeCombatTurn(ctx, (a) => acts.push(a));
    // First action is a move toward a tile adjacent to the goblin.
    expect(acts[0].type).toBe('moveTo');
    const move = acts[0] as { type: 'moveTo'; tileX: number; tileY: number };
    expect(Math.max(Math.abs(move.tileX - 8), Math.abs(move.tileY - 0))).toBe(1);
  });

  it('Dodges when it has no usable offensive option', () => {
    const { ctx } = combatCtx([2, 0]); // no spell, no weapon
    const acts: PlayerAction[] = [];
    gmpcTakeCombatTurn(ctx, (a) => acts.push(a));
    expect(acts).toEqual([{ type: 'dodge' }]);
  });
});

describe('GMPC turn actions resolve (phase-gate fix, US-130)', () => {
  it('a bound GMPC can move only when its turn is presented as player_turn', () => {
    // `gmpcAct` swaps the phase to `player_turn` while resolving a GMPC action,
    // because move/attack/cast handlers gate on `phase === 'player_turn'`. This
    // proves the gate that necessitates the swap: the same `doMoveTo`, with the
    // GMPC bound as the active actor, is a no-op under `gmpc_turn` but moves
    // under `player_turn`.
    const def = rangerDef();
    const gmpcState = buildGmpcPlayerState(def, DEFS, { x: 0, y: 0 });
    gmpcState.movesLeft = 6;
    const { ctx, state } = buildTestContext({ player: { tileX: 0, tileY: 0 } });
    state.traps = [];
    state.player = gmpcState;            // what `withActor` binds during the GMPC's turn

    // Raw GMPC turn phase → the handler's `player_turn` gate rejects the move.
    state.phase = 'gmpc_turn';
    doMoveTo(ctx, 3, 0, []);
    expect([gmpcState.tileX, gmpcState.tileY]).toEqual([0, 0]);

    // Presented as `player_turn` (what `gmpcAct` does) → the move resolves.
    state.phase = 'player_turn';
    gmpcState.movesLeft = 6;
    doMoveTo(ctx, 3, 0, []);
    expect([gmpcState.tileX, gmpcState.tileY]).toEqual([3, 0]);
  });

  it('a bound GMPC cannot move onto the swapped-out human\'s tile', () => {
    const def = rangerDef();
    const gmpcState = buildGmpcPlayerState(def, DEFS, { x: 0, y: 0 });
    gmpcState.movesLeft = 6;
    const { ctx, state } = buildTestContext({ player: { tileX: 0, tileY: 0 } });
    state.traps = [];
    state.player = gmpcState;          // GMPC bound as active actor
    state.phase = 'player_turn';
    state.parkedActorTile = { x: 1, y: 0 };  // the human stands here, swapped out

    doMove(ctx, 1, 0, []);             // step east onto the human → blocked
    expect([gmpcState.tileX, gmpcState.tileY]).toEqual([0, 0]);
    doMove(ctx, 0, 1, []);             // step south onto a free tile → allowed
    expect([gmpcState.tileX, gmpcState.tileY]).toEqual([0, 1]);
  });

  it('retags the GMPC action\'s player-tagged events to its shell id (animation)', () => {
    const id = 'gmpc_lyra';
    const events: GameEvent[] = [
      { type: 'entity_move', entityId: 'player', toX: 3, toY: 0 },
      { type: 'attack', attackerId: 'player', targetId: 'enemy_x', kind: 'ranged', outcome: 'hit' },
      { type: 'attack', attackerId: 'enemy_x', targetId: 'player', kind: 'melee', outcome: 'hit' }, // enemy OA vs the GMPC
      { type: 'spell_vfx', style: 'projectile', palette: 'fire', fromId: 'player', toId: 'enemy_x' },
      { type: 'damage', entityId: 'enemy_x', amount: 5, newHp: 2 },
    ];
    retagPlayerEventsToActor(events, id);
    expect((events[0] as { entityId: string }).entityId).toBe(id);                 // the GMPC moved
    expect((events[1] as { attackerId: string }).attackerId).toBe(id);            // the GMPC attacked
    expect((events[2] as { targetId: string }).targetId).toBe(id);               // OA hit the GMPC
    expect((events[2] as { attackerId: string }).attackerId).toBe('enemy_x');    // attacker untouched
    expect((events[3] as { fromId: string }).fromId).toBe(id);                    // cast VFX from the GMPC
    expect((events[4] as { entityId: string }).entityId).toBe('enemy_x');         // enemy damage untouched
  });
});
