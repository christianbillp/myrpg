/**
 * Spell-gap Bucket 3 — Spirit Guardians (caster-anchored damaging aura) and
 * Spiritual Weapon (directable spectral attacker). These exercise the new
 * recurring-effect systems directly (the test harness stubs `spawnSummon`, so
 * Spiritual Weapon is driven via a hand-placed summon NPC rather than the full
 * cast path).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import {
  castSpiritGuardians, recenterSpiritGuardians, runSpiritGuardiansEndOfTurnSaves,
} from './SpiritGuardiansSystem.js';
import { resolveSpiritualWeaponAttack, doCommandSummon } from './SummonSystem.js';
import { endConcentration } from './ConcentrationSystem.js';
import type { MonsterDef, SpellDef, NpcState } from './types.js';

const SPELLS_DIR = join(__dirname, '../../data/spells');
const MONSTERS_DIR = join(__dirname, '../../data/monsters');
const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(SPELLS_DIR, `${id}.json`), 'utf-8')) as SpellDef;
const loadMonster = (id: string): MonsterDef =>
  JSON.parse(readFileSync(join(MONSTERS_DIR, `${id}.json`), 'utf-8')) as MonsterDef;

/** A weak target: WIS 1 (−5 save) so Spirit Guardians' high-DC save always
 *  fails, AC 10 so a mid-roll Spiritual Weapon attack always lands. */
const GOBLIN: MonsterDef = {
  id: 'goblin', name: 'Goblin', type: 'Small Humanoid', tokenAsset: '',
  maxHp: 30, ac: 10, str: 8, dex: 14, con: 10, int: 8, wis: 1, cha: 8,
  proficiencyBonus: 2, savingThrows: {}, initiativeBonus: 0, stealthBonus: 0,
  passivePerception: 9, speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0, immunities: [],
} as MonsterDef;

/** Caster with a DC-19 save (8 + PB 6 + WIS mod 5) and a +11 spell attack. */
const CASTER = { spellcastingAbility: 'wis' as const, wis: 20, proficiencyBonus: 6 };

afterEach(() => vi.restoreAllMocks());

describe('Spirit Guardians', () => {
  function setup(goblinTile: { x: number; y: number }) {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 5, tileY: 5 },
      playerDef: CASTER,
      monsters: [GOBLIN],
      npcs: [makeNpc({ id: 'gob', defId: 'goblin', disposition: 'enemy', hp: 30, maxHp: 30, tileX: goblinTile.x, tileY: goblinTile.y })],
    });
    r.ctx.defs.spells.push(loadSpell('spirit-guardians'));
    return r;
  }

  it('damages and slows an enemy inside the aura on cast', () => {
    const { ctx, state } = setup({ x: 6, y: 5 });  // adjacent → inside 15-ft (3-tile) aura
    castSpiritGuardians(ctx, 3);
    const gob = state.npcs[0];
    expect(gob.hp).toBeLessThan(30);          // failed the DC-19 WIS save → took radiant
    expect(gob.hp).toBeGreaterThanOrEqual(6); // 3d8 max is 24
    expect(gob.conditions).toContain('slowed');
    expect(state.player.concentratingOn).toBe('spirit-guardians');
    expect((state.activeZones ?? []).some((z) => z.spellId === 'spirit-guardians')).toBe(true);
  });

  it('leaves enemies outside the aura untouched', () => {
    const { ctx, state } = setup({ x: 15, y: 15 });  // far outside the 3-tile radius
    castSpiritGuardians(ctx, 3);
    const gob = state.npcs[0];
    expect(gob.hp).toBe(30);
    expect(gob.conditions).not.toContain('slowed');
  });

  it('drops the slow when the enemy leaves the aura (recenter)', () => {
    const { ctx, state } = setup({ x: 6, y: 5 });
    castSpiritGuardians(ctx, 3);
    expect(state.npcs[0].conditions).toContain('slowed');
    state.npcs[0].tileX = 15;  // walk out of range
    recenterSpiritGuardians(ctx);
    expect(state.npcs[0].conditions).not.toContain('slowed');
  });

  it('scales damage with slot level on the recurring end-of-turn save', () => {
    const { ctx, state } = setup({ x: 6, y: 5 });
    castSpiritGuardians(ctx, 5);  // 3d8 + 2d8 = 5d8 (5..40)
    state.npcs[0].hp = 100;       // reset so the recurring hit is isolated
    runSpiritGuardiansEndOfTurnSaves(ctx, 'gob');
    expect(state.npcs[0].hp).toBeLessThanOrEqual(95);  // at least 5 from 5d8
    expect(state.npcs[0].hp).toBeGreaterThanOrEqual(60);
  });

  it('strips the aura and its slow when concentration ends', () => {
    const { ctx, state } = setup({ x: 6, y: 5 });
    castSpiritGuardians(ctx, 3);
    endConcentration(ctx, 'test');
    expect(state.npcs[0].conditions).not.toContain('slowed');
    expect((state.activeZones ?? []).some((z) => z.spellId === 'spirit-guardians')).toBe(false);
    expect(state.player.concentratingOn).toBeNull();
  });
});

describe('Spiritual Weapon', () => {
  function setup() {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 0, tileY: 0 },
      playerDef: CASTER,
      monsters: [GOBLIN, loadMonster('spiritual_weapon')],
      npcs: [
        makeNpc({ id: 'gob', defId: 'goblin', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 8, tileY: 5 }),
      ],
    });
    r.ctx.defs.spells.push(loadSpell('spiritual-weapon'));
    return r;
  }

  function placeWeapon(state: { npcs: NpcState[] }, x: number, y: number): NpcState {
    const w = makeNpc({
      id: 'sw', defId: 'spiritual_weapon', disposition: 'ally',
      hp: 1000, maxHp: 1000, tileX: x, tileY: y,
      summonSpellId: 'spiritual-weapon', summonOwnerId: 'player', summonSlotLevel: 2,
    });
    state.npcs.push(w);
    return w;
  }

  it('makes a melee spell attack that hits and deals 1d8 + mod force', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);  // d20→11 (hit), d8→5
    const { ctx, state } = setup();
    const weapon = placeWeapon(state, 7, 5);  // adjacent to the goblin at (8,5)
    resolveSpiritualWeaponAttack(ctx, weapon, state.npcs[0], []);
    // 11 + 11 = 22 vs AC 10 → hit; 1d8(5) + WIS mod 5 = 10 force
    expect(state.npcs[0].hp).toBe(10);
  });

  it('scales the strike by +1d8 per slot level above 2', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ctx, state } = setup();
    const weapon = placeWeapon(state, 7, 5);
    weapon.summonSlotLevel = 4;  // 1d8 + 2d8 = 3d8
    state.npcs[0].hp = 40;
    resolveSpiritualWeaponAttack(ctx, weapon, state.npcs[0], []);
    // 3d8 (3×5=15) + mod 5 = 20 → 40 − 20 = 20
    expect(state.npcs[0].hp).toBe(20);
  });

  it('flits beside the target and strikes via commandSummon (Bonus Action)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { ctx, state } = setup();
    const weapon = placeWeapon(state, 5, 5);  // 3 tiles from the goblin (≤ 20 ft)
    const events: never[] = [];
    doCommandSummon(ctx, 'sw', { x: 8, y: 5 }, events);
    expect(state.npcs[0].hp).toBe(10);                 // struck for 10
    expect(state.player.bonusActionUsed).toBe(true);   // spent a Bonus Action
    // The weapon repositioned adjacent to the target.
    const w = state.npcs.find((n) => n.id === 'sw')!;
    expect(Math.max(Math.abs(w.tileX - 8), Math.abs(w.tileY - 5))).toBeLessThanOrEqual(1);
  });
});
