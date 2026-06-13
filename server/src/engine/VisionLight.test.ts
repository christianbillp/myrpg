/**
 * US-127 — light & vision SRD pass: effective carried light, darkvision in
 * dim light, unseen-attacker/target resolution through ambient darkness, and
 * the enemy-only / sense-piercing Hide-spotting rules.
 */
import { describe, it, expect } from 'vitest';
import { canSee, effectiveLightAt, mutualAttackVision, runPerceptionSweep } from './Vision.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef } from './types.js';

function monster(id: string, senses?: MonsterDef['senses']): MonsterDef {
  return {
    id, name: id, type: 'Medium Humanoid, Neutral', maxHp: 10, ac: 10,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 12,
    senses, speed: 30,
    attacks: [{ name: 'Club', attackType: 'melee', bonus: 2, reach: 5, damageDice: 1, damageSides: 4, damageBonus: 0, damageType: 'bludgeoning' }],
    xp: 10, cr: '0', color: 0, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

describe('effectiveLightAt (US-127)', () => {
  it('carried light upgrades darkness: bright within brightFt, dim to brightFt+dimFt', () => {
    const { state } = buildTestContext({ player: { tileX: 0, tileY: 0 } });
    state.environment = { lightLevel: 'dark' };
    state.player.lightSource = { brightFt: 20, dimFt: 20, source: 'torch' };
    expect(effectiveLightAt(state, 2, 0)).toBe('bright');   // 10 ft
    expect(effectiveLightAt(state, 4, 0)).toBe('bright');   // 20 ft
    expect(effectiveLightAt(state, 6, 0)).toBe('dim');      // 30 ft
    expect(effectiveLightAt(state, 12, 0)).toBe('dark');    // 60 ft
  });

  it('light only improves: a bright zone stays bright, a doused player changes nothing', () => {
    const { state } = buildTestContext({ player: { tileX: 0, tileY: 0 } });
    state.environment = { lightLevel: 'bright' };
    state.player.lightSource = { brightFt: 20, dimFt: 20, source: 'torch' };
    expect(effectiveLightAt(state, 10, 0)).toBe('bright');
    state.player.lightSource = undefined;
    state.environment = { lightLevel: 'dark' };
    expect(effectiveLightAt(state, 10, 0)).toBe('dark');
  });
});

describe('darkvision vs ambient light (SRD)', () => {
  it('sees Dim Light as Bright within range — no obscurance', () => {
    const { state } = buildTestContext({});
    state.environment = { lightLevel: 'dim' };
    const target = { tileX: 5, tileY: 0, conditions: [] as string[] };
    const withDv = canSee(state, { tileX: 0, tileY: 0, senses: { darkvision: 60 } }, target);
    expect(withDv.sees).toBe(true);
    expect(withDv.obscurance).toBe('none');
    const without = canSee(state, { tileX: 0, tileY: 0, senses: {} }, target);
    expect(without.sees).toBe(true);
    expect(without.obscurance).toBe('lightly');
  });

  it('steps Darkness to Dim within range; no darkvision means blind', () => {
    const { state } = buildTestContext({});
    state.environment = { lightLevel: 'dark' };
    const target = { tileX: 5, tileY: 0, conditions: [] as string[] };
    expect(canSee(state, { tileX: 0, tileY: 0, senses: { darkvision: 60 } }, target).obscurance).toBe('lightly');
    expect(canSee(state, { tileX: 0, tileY: 0, senses: {} }, target).sees).toBe(false);
  });
});

describe('Unseen Attackers and Targets (US-127)', () => {
  it('in darkness a sightless attacker cannot see; a darkvision target still sees back', () => {
    const { state } = buildTestContext({});
    state.environment = { lightLevel: 'dark' };
    const v = mutualAttackVision(state,
      { tileX: 0, tileY: 0, senses: {}, conditions: [], id: 'attacker' },
      { tileX: 3, tileY: 0, senses: { darkvision: 60 }, conditions: [], id: 'target' });
    expect(v.seesTarget).toBe(false);   // attacker swings blind → Disadvantage
    expect(v.seenByTarget).toBe(true);  // target sees the attacker → no unseen-attacker Advantage
  });

  it('a lit torch restores mutual sight in a dark area', () => {
    const { state } = buildTestContext({ player: { tileX: 0, tileY: 0 } });
    state.environment = { lightLevel: 'dark' };
    state.player.lightSource = { brightFt: 20, dimFt: 20, source: 'torch' };
    const v = mutualAttackVision(state,
      { tileX: 0, tileY: 0, senses: {}, conditions: [], id: 'player' },
      { tileX: 3, tileY: 0, senses: {}, conditions: [], id: 'target' });
    expect(v.seesTarget).toBe(true);
    expect(v.seenByTarget).toBe(true);
  });
});

describe('Hide spotting rules (US-127 fixes)', () => {
  it('allies never break the player\'s Hide; enemies can', () => {
    const ally = makeNpc({ id: 'friend', defId: 'watcher', disposition: 'ally', tileX: 1, tileY: 0 });
    const { ctx, state } = buildTestContext({
      npcs: [ally],
      monsters: [monster('watcher')],
      player: { tileX: 0, tileY: 0 },
    });
    state.player.conditions.push('hidden');
    state.player.hideDC = 1;  // anyone allowed to roll would spot instantly
    expect(runPerceptionSweep(ctx, 'player')).toBe(false);
    expect(state.player.conditions).toContain('hidden');

    ally.disposition = 'enemy';
    expect(runPerceptionSweep(ctx, 'player')).toBe(true);
    expect(state.player.conditions).not.toContain('hidden');
  });

  it('blindsight inside range defeats hiding automatically', () => {
    const seer = makeNpc({ id: 'seer', defId: 'bat', disposition: 'enemy', tileX: 2, tileY: 0 });
    const { ctx, state } = buildTestContext({
      npcs: [seer],
      monsters: [monster('bat', { blindsight: 60 })],
      player: { tileX: 0, tileY: 0 },
    });
    state.player.conditions.push('hidden');
    state.player.hideDC = 999;  // unspottable by any roll — only the sense finds them
    expect(runPerceptionSweep(ctx, 'player')).toBe(true);
    expect(state.player.conditions).not.toContain('hidden');
  });
});
