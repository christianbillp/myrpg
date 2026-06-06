/**
 * US-109a — Heroic Inspiration reroll prompt (attack site).
 *
 * Locks in the pause/resume contract:
 *   • a player attack while holding Heroic Inspiration PAUSES on `pendingReroll`
 *     and applies NO consequence yet (no damage, no action spend);
 *   • `resolveReroll(false)` applies the deferred outcome and keeps the
 *     inspiration;
 *   • `resolveReroll(true)` spends the inspiration and applies a (re-resolved)
 *     outcome;
 *   • without inspiration, an attack resolves immediately (no pause).
 */
import { describe, it, expect } from 'vitest';
import { doAttack, doResolveReroll } from './CombatActions.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, PlayerAttack } from './types.js';

const SWORD: PlayerAttack = {
  name: 'Sword', statKey: 'str', damageDice: 1, damageSides: 8, damageType: 'slashing',
  savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false,
  push: false, topple: false,
};

function goblin(): MonsterDef {
  return {
    id: 'goblin', name: 'Goblin', type: 'Small Humanoid', maxHp: 100, ac: 1,
    str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8,
    proficiencyBonus: 2, initiativeBonus: 2, stealthBonus: 0, passivePerception: 9,
    speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0x884400, tokenAsset: 'x.svg',
  } as MonsterDef;
}

function scenario(heroicInspiration: boolean) {
  const result = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 0, tileY: 0, heroicInspiration },
    playerDef: { mainAttack: SWORD },
    monsters: [goblin()],
    npcs: [makeNpc({ id: 'enemy_x', defId: 'goblin', tileX: 1, tileY: 0, disposition: 'enemy', hp: 100, maxHp: 100 })],
  });
  // Vision reads state.environment.lightLevel; the bare test state omits it.
  result.state.environment = { lightLevel: 'bright' };
  return result;
}

describe('Heroic Inspiration reroll — attack pause/resume (US-109a)', () => {
  it('pauses on pendingReroll before any consequence when inspiration is held', () => {
    const { ctx, state, events } = scenario(true);
    doAttack(ctx, 'enemy_x', events);
    expect(state.pendingReroll).not.toBeNull();
    expect(state.pendingReroll!.kind).toBe('attack');
    expect(state.pendingReroll!.targetId).toBe('enemy_x');
    // No consequence applied yet: full HP, action unspent, inspiration intact.
    expect(state.npcs[0].hp).toBe(100);
    expect(state.player.actionUsed).toBe(false);
    expect(state.player.heroicInspiration).toBe(true);
  });

  it('decline applies the deferred outcome and keeps the inspiration', () => {
    const { ctx, state, events } = scenario(true);
    doAttack(ctx, 'enemy_x', events);
    doResolveReroll(ctx, false, events);
    expect(state.pendingReroll).toBeNull();
    expect(state.player.actionUsed).toBe(true);
    expect(state.player.heroicInspiration).toBe(true);  // not spent on decline
  });

  it('accept spends the inspiration and clears the prompt', () => {
    const { ctx, state, events } = scenario(true);
    doAttack(ctx, 'enemy_x', events);
    doResolveReroll(ctx, true, events);
    expect(state.pendingReroll).toBeNull();
    expect(state.player.actionUsed).toBe(true);
    expect(state.player.heroicInspiration).toBe(false);  // expended on accept
  });

  it('does not pause when the player has no inspiration', () => {
    const { ctx, state, events } = scenario(false);
    doAttack(ctx, 'enemy_x', events);
    expect(state.pendingReroll).toBeNull();
    expect(state.player.actionUsed).toBe(true);
  });

  it('resolveReroll is a no-op when nothing is pending', () => {
    const { ctx, state, events } = scenario(false);
    doResolveReroll(ctx, true, events);
    expect(state.pendingReroll).toBeNull();
  });
});
