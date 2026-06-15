/**
 * US-130 — GMPC active-actor seam.
 *
 * The architecture: a GMPC's full `PlayerState` is bound into the active-actor
 * slot for its turn, so EVERY existing player-mechanics path operates on it
 * unchanged. These tests prove the load-bearing promise at the resolver level:
 * the same real `doCastSpell` consumes whichever PC's spell slots are bound,
 * leaving the other PC's pool untouched. (The full turn-loop / GM-drive layer
 * builds on this seam — see ambient-conversations.md sibling spec.)
 */
import { describe, it, expect } from 'vitest';
import { doCastSpell } from './SpellSystem.js';
import { dispatchPlayerAction } from './playerActions/registry.js';
import { gmpcActionFromInput } from './AIGMTools.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { SpellDef, MonsterDef, PlayerState } from './types.js';
import type { GameEngine } from './GameEngine.js';

const MAGIC_MISSILE: SpellDef = {
  id: 'magic-missile', name: 'Magic Missile', level: 1, school: 'evocation', classes: ['wizard'],
  castingTime: 'action', range: '120 feet', rangeFeet: 120,
  components: { verbal: true, somatic: true, material: null },
  duration: 'Instantaneous', concentration: false, ritual: false,
  attack: 'auto-hit', damage: { dice: 1, sides: 4, bonus: 1, type: 'force' }, darts: 3,
} as SpellDef;

function dummy(): MonsterDef {
  return {
    id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 80, ac: 1,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [], xp: 0, cr: '0', color: 0x888888, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

describe('GMPC active-actor seam (US-130)', () => {
  it('a bound GMPC spends ITS spell slots, not the human player\'s', () => {
    const { ctx, state, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, spellSlots: [2, 0, 0], preparedSpellIds: ['magic-missile'] },
      playerDef: { spellcastingAbility: 'int' },
      monsters: [dummy()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'dummy', tileX: 1, tileY: 0, disposition: 'enemy', hp: 80, maxHp: 80 })],
    });
    ctx.defs.spells.push(MAGIC_MISSILE);
    state.selectedTargetId = 'enemy_x';

    // Human casts → human's L1 pool drops, a second (GMPC) pool would be
    // untouched. Snapshot the human pool object so we can prove isolation.
    doCastSpell(ctx, 'magic-missile', 1, ['enemy_x'], undefined, false, events);
    expect(state.player.spellSlots[0]).toBe(1);
    const humanState = state.player;

    // Bind a GMPC's PlayerState into the active slot (what `withActor` does on
    // a GMPC turn) — a fresh PC with its own slot pool.
    const gmpcState: PlayerState = { ...JSON.parse(JSON.stringify(humanState)), spellSlots: [1, 0, 0], actionUsed: false, bonusActionUsed: false };
    state.player = gmpcState;
    doCastSpell(ctx, 'magic-missile', 1, ['enemy_x'], undefined, false, events);

    // The GMPC's pool drained; the human's pool is exactly where it was left.
    expect(gmpcState.spellSlots[0]).toBe(0);
    expect(humanState.spellSlots[0]).toBe(1);

    // Restore (what `withActor`'s finally block does) and confirm the human is intact.
    state.player = humanState;
    expect(state.player.spellSlots[0]).toBe(1);
  });

  it('both casts route through the same real resolver and damage the shared world', () => {
    const { ctx, state, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, spellSlots: [1, 0, 0], preparedSpellIds: ['magic-missile'] },
      playerDef: { spellcastingAbility: 'int' },
      monsters: [dummy()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'dummy', tileX: 1, tileY: 0, disposition: 'enemy', hp: 80, maxHp: 80 })],
    });
    ctx.defs.spells.push(MAGIC_MISSILE);
    state.selectedTargetId = 'enemy_x';
    const hp0 = state.npcs[0].hp;

    doCastSpell(ctx, 'magic-missile', 1, ['enemy_x'], undefined, false, events);
    const afterHuman = state.npcs[0].hp;
    expect(afterHuman).toBeLessThan(hp0);  // human's missiles landed

    const gmpcState: PlayerState = { ...JSON.parse(JSON.stringify(state.player)), spellSlots: [1, 0, 0], actionUsed: false, bonusActionUsed: false };
    state.player = gmpcState;
    doCastSpell(ctx, 'magic-missile', 1, ['enemy_x'], undefined, false, events);
    expect(state.npcs[0].hp).toBeLessThan(afterHuman);  // GMPC's missiles landed on the same enemy
  });

  it('a GMPC cast routed through the real action registry spends ITS slot', () => {
    // `engine.gmpcAct` binds the GMPC then calls `dispatchPlayerAction` — this
    // proves the registry path (not just the resolver directly) resolves a
    // `castSpell` PlayerAction against the swapped actor, the way the gmpc_act
    // tool drives it in production.
    const { ctx, state, events } = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0, spellSlots: [1, 0, 0], preparedSpellIds: ['magic-missile'] },
      playerDef: { spellcastingAbility: 'int' },
      monsters: [dummy()],
      npcs: [makeNpc({ id: 'enemy_x', defId: 'dummy', tileX: 1, tileY: 0, disposition: 'enemy', hp: 80, maxHp: 80 })],
    });
    ctx.defs.spells.push(MAGIC_MISSILE);

    const gmpcState: PlayerState = { ...JSON.parse(JSON.stringify(state.player)), spellSlots: [1, 0, 0], actionUsed: false, bonusActionUsed: false };
    state.player = gmpcState;  // what withActor binds for the GMPC's turn
    const hp0 = state.npcs[0].hp;

    const action = gmpcActionFromInput('castSpell', { spell_id: 'magic-missile', slot_level: 1, targets: ['enemy_x'] });
    expect(action).toEqual({ type: 'castSpell', spellId: 'magic-missile', slotLevel: 1, targetIds: ['enemy_x'], tile: undefined });
    dispatchPlayerAction(ctx, action!, events, null as unknown as GameEngine);

    expect(gmpcState.spellSlots[0]).toBe(0);          // the GMPC's slot was spent
    expect(state.npcs[0].hp).toBeLessThan(hp0);        // through the real resolver
  });
});

describe('gmpcActionFromInput — tool payload → PlayerAction (US-130)', () => {
  it('maps the no-arg action kinds', () => {
    expect(gmpcActionFromInput('dodge', {})).toEqual({ type: 'dodge' });
    expect(gmpcActionFromInput('dash', {})).toEqual({ type: 'dash' });
    expect(gmpcActionFromInput('disengage', {})).toEqual({ type: 'disengage' });
    expect(gmpcActionFromInput('hide', {})).toEqual({ type: 'hide' });
    expect(gmpcActionFromInput('endTurn', {})).toEqual({ type: 'endTurn' });
  });

  it('maps target-bearing and tile actions', () => {
    expect(gmpcActionFromInput('attack', { target: 'enemy_A' })).toEqual({ type: 'attack', targetId: 'enemy_A' });
    expect(gmpcActionFromInput('offhandAttack', { target: 'enemy_A' })).toEqual({ type: 'offhandAttack', targetId: 'enemy_A' });
    expect(gmpcActionFromInput('moveTo', { tile_x: 3, tile_y: 4 })).toEqual({ type: 'moveTo', tileX: 3, tileY: 4 });
    expect(gmpcActionFromInput('useFeature', { feature_id: 'second-wind' })).toEqual({ type: 'useFeature', featureId: 'second-wind', targetId: undefined });
  });

  it('falls back to a single `target` when `targets` is absent for a spell', () => {
    expect(gmpcActionFromInput('castSpell', { spell_id: 'fire-bolt', slot_level: 0, target: 'enemy_B' }))
      .toEqual({ type: 'castSpell', spellId: 'fire-bolt', slotLevel: 0, targetIds: ['enemy_B'], tile: undefined });
  });

  it('rejects unknown or incomplete actions', () => {
    expect(gmpcActionFromInput('nonsense', {})).toBeUndefined();
    expect(gmpcActionFromInput('moveTo', { tile_x: 3 })).toBeUndefined();           // missing tile_y
    expect(gmpcActionFromInput('castSpell', { spell_id: 'x' })).toBeUndefined();    // missing slot_level
    expect(gmpcActionFromInput('useFeature', {})).toBeUndefined();                  // missing feature_id
  });
});
