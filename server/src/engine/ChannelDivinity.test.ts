/**
 * US-120 Slice D — Life Domain + Channel Divinity actives.
 *
 * The three Channel Divinity options share one pool (`resources['channel-divinity']`):
 *  • Turn Undead — undead in range save vs WIS or are Frightened+Incapacitated.
 *  • Divine Spark — heal the selected ally/self, or radiant-damage the selected enemy.
 *  • Preserve Life — restore 5×level HP among bloodied creatures, capped at half max.
 * Plus Disciple of Life adds 2+slot to leveled healing spells.
 */
import { describe, it, expect } from 'vitest';
import { doUseFeature } from './FeatureRegistry.js';
import { doCastSpell } from './SpellSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, FeatureDef, SpellDef } from './types.js';

function skeleton(): MonsterDef {
  return {
    id: 'skeleton', name: 'Skeleton', type: 'Medium Undead', maxHp: 13, ac: 13,
    str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5,
    proficiencyBonus: 2, initiativeBonus: 2, stealthBonus: 0, passivePerception: 9,
    speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0xcccccc, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}
function commoner(): MonsterDef {
  return {
    id: 'commoner', name: 'Commoner', type: 'Medium Humanoid', maxHp: 30, ac: 10,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [], xp: 0, cr: '0', color: 0x888888, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

const FEATURES: FeatureDef[] = [
  { id: 'channel-divinity', name: 'Channel Divinity', classId: 'cleric', minLevel: 2, description: '', cost: { kind: 'passive' }, resource: { kind: 'uses-per-short-rest', max: 2 } } as FeatureDef,
  { id: 'turn-undead', name: 'Turn Undead', classId: 'cleric', minLevel: 2, description: '', cost: { kind: 'action' }, handler: 'turn-undead' } as FeatureDef,
  { id: 'divine-spark', name: 'Divine Spark', classId: 'cleric', minLevel: 2, description: '', cost: { kind: 'action' }, handler: 'divine-spark' } as FeatureDef,
  { id: 'preserve-life', name: 'Preserve Life', classId: 'cleric', minLevel: 3, description: '', cost: { kind: 'action' }, handler: 'preserve-life' } as FeatureDef,
];

function ctx(overrides: { npcs?: ReturnType<typeof makeNpc>[]; monsters?: MonsterDef[]; hp?: number } = {}) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 0, tileY: 0, hp: overrides.hp ?? 30, resources: { 'channel-divinity': 2 } },
    playerDef: {
      spellcastingAbility: 'wis', wis: 16, level: 3, maxHp: 30, proficiencyBonus: 2,
      defaultFeatureIds: ['channel-divinity', 'turn-undead', 'divine-spark', 'preserve-life'],
    },
    monsters: overrides.monsters ?? [],
    npcs: overrides.npcs ?? [],
  });
  r.ctx.defs.features.push(...FEATURES);
  return r;
}

describe('Channel Divinity (US-120 Slice D)', () => {
  it('Turn Undead frightens an undead in range and spends a use', () => {
    const { ctx: c, state, events } = ctx({
      monsters: [skeleton()],
      npcs: [makeNpc({ id: 'enemy_s', defId: 'skeleton', tileX: 2, tileY: 0, disposition: 'enemy', hp: 13, maxHp: 13 })],
    });
    // DC = 8 + 2 + 3 = 13; skeleton WIS save = d20 + (-1) → fails vs 13 almost always.
    // Loop until a fail lands (resists are possible on a nat-high).
    let turned = false;
    for (let i = 0; i < 40 && !turned; i++) {
      const cc = ctx({ monsters: [skeleton()], npcs: [makeNpc({ id: 'enemy_s', defId: 'skeleton', tileX: 2, tileY: 0, disposition: 'enemy', hp: 13, maxHp: 13 })] });
      doUseFeature(cc.ctx, 'turn-undead', {}, cc.events);
      if (cc.state.npcs[0].conditions.includes('frightened')) {
        turned = true;
        expect(cc.state.npcs[0].conditions).toContain('incapacitated');
        expect(cc.state.player.resources['channel-divinity']).toBe(1);
      }
    }
    expect(turned).toBe(true);
    void state; void events; void c;
  });

  it('Turn Undead does nothing (and spends no use) with no undead in range', () => {
    const { ctx: c, events } = ctx({
      monsters: [commoner()],
      npcs: [makeNpc({ id: 'enemy_c', defId: 'commoner', tileX: 1, tileY: 0, disposition: 'enemy', hp: 30, maxHp: 30 })],
    });
    doUseFeature(c, 'turn-undead', {}, events);
    expect(c.state.player.resources['channel-divinity']).toBe(2);  // not spent
  });

  it('Divine Spark heals a selected ally and spends a use', () => {
    const { ctx: c, state, events } = ctx({
      monsters: [commoner()],
      npcs: [makeNpc({ id: 'ally_1', defId: 'commoner', tileX: 1, tileY: 0, disposition: 'ally', hp: 5, maxHp: 30 })],
    });
    state.selectedTargetId = 'ally_1';
    doUseFeature(c, 'divine-spark', {}, events);
    expect(state.npcs[0].hp).toBeGreaterThan(5);
    expect(state.player.resources['channel-divinity']).toBe(1);
  });

  it('Divine Spark damages a selected enemy', () => {
    const { ctx: c, state, events } = ctx({
      monsters: [commoner()],
      npcs: [makeNpc({ id: 'enemy_c', defId: 'commoner', tileX: 1, tileY: 0, disposition: 'enemy', hp: 30, maxHp: 30 })],
    });
    state.selectedTargetId = 'enemy_c';
    doUseFeature(c, 'divine-spark', {}, events);
    expect(state.npcs[0].hp).toBeLessThan(30);
    expect(state.player.resources['channel-divinity']).toBe(1);
  });

  it('Preserve Life heals a bloodied caster up to half max', () => {
    const { ctx: c, state, events } = ctx({ hp: 4 });  // L3 → pool 15, half of 30 = 15
    doUseFeature(c, 'preserve-life', {}, events);
    expect(state.player.hp).toBe(15);  // capped at half max
    expect(state.player.resources['channel-divinity']).toBe(1);
  });

  it('Disciple of Life adds 2 + slot level to a healing spell', () => {
    const CURE: SpellDef = {
      id: 'cure-wounds', name: 'Cure Wounds', level: 1, school: 'abjuration', classes: ['cleric'],
      castingTime: 'action', range: 'Touch', rangeFeet: 5,
      components: { verbal: true, somatic: true, material: null }, duration: 'Instantaneous',
      concentration: false, ritual: false, heal: { dice: 2, sides: 8 },
    } as SpellDef;
    const r = buildTestContext({
      phase: 'player_turn',
      player: { hp: 1, spellSlots: [2], preparedSpellIds: ['cure-wounds'] },
      playerDef: { spellcastingAbility: 'wis', wis: 16, maxHp: 99, modifiers: [{ type: 'flag', name: 'disciple-of-life' }] },
    });
    r.ctx.defs.spells.push(CURE);
    doCastSpell(r.ctx, 'cure-wounds', 1, ['player'], undefined, false, r.events);
    // 2d8 (2..16) + WIS 3 + Disciple (2 + slot 1 = 3) = 7..22, from 1 → 8..23.
    expect(r.state.player.hp).toBeGreaterThanOrEqual(8);
    expect(r.state.player.hp).toBeLessThanOrEqual(23);
  });
});
