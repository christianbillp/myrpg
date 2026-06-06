/**
 * Goliath Giant Ancestry on-hit boons (US-122). The chosen gift is read
 * data-driven from the option's `effect`; all gifts share one PB/Long-Rest pool
 * (`resources['giant-gift']`). These tests drive `applyGiantGiftOnHit` directly.
 */
import { describe, it, expect } from 'vitest';
import { applyGiantGiftOnHit, applyStoneEndurance, applyStormsThunder, giantGiftPoolMax, GIANT_GIFT_ID } from './GiantGifts.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, PlayerDef, SpeciesDef } from './types.js';

function goliath(): SpeciesDef {
  return {
    id: 'goliath', name: 'Goliath', creatureType: 'humanoid', size: 'medium', speed: 35,
    traits: [{
      name: 'Giant Ancestry', description: '',
      effects: {
        ancestryChoice: {
          usesPerLongRest: 'proficiencyBonus',
          options: [
            { id: 'fires-burn', effect: { bonusDamageOnHit: { dice: '1d10', damageType: 'fire' } } },
            { id: 'frosts-chill', effect: { bonusDamageOnHit: { dice: '1d6', damageType: 'cold' }, speedReduction: { feet: 10, duration: 'until-start-of-next-turn' } } },
            { id: 'hills-tumble', effect: { conditionOnHit: { condition: 'prone', targetSizeMax: 'large' } } },
            { id: 'stones-endurance', effect: { damageReduction: { trigger: 'take-damage', action: 'reaction', roll: '1d12+con' } } },
            { id: 'storms-thunder', effect: { retaliationDamage: { trigger: 'take-damage-from-creature-within-60ft', action: 'reaction', dice: '1d8', damageType: 'thunder' } } },
          ],
        },
      },
    }],
  } as unknown as SpeciesDef;
}

function ogre(size = 'large'): MonsterDef {
  return { id: 'ogre', name: 'Ogre', type: `${size} Giant`, maxHp: 30, ac: 11, size } as unknown as MonsterDef;
}

function ctx(lineage: string, uses = 2, targetSize = 'large') {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { resources: { [GIANT_GIFT_ID]: uses } },
    playerDef: { speciesId: 'goliath', speciesLineage: lineage, proficiencyBonus: 2, con: 14 } as Partial<PlayerDef>,
    monsters: [ogre(targetSize)],
  });
  r.defs.species.push(goliath());
  const target = makeNpc({ id: 'e1', defId: 'ogre', hp: 30, maxHp: 30, disposition: 'enemy', size: targetSize as never });
  r.state.npcs.push(target);
  return { ...r, target, def: ogre(targetSize) };
}

describe('giantGiftPoolMax', () => {
  it('is the Proficiency Bonus for a Goliath with a chosen gift', () => {
    expect(giantGiftPoolMax({ speciesId: 'goliath', speciesLineage: 'fires-burn', proficiencyBonus: 3 } as PlayerDef, [goliath()])).toBe(3);
  });
  it('is null without a chosen ancestry', () => {
    expect(giantGiftPoolMax({ speciesId: 'goliath', speciesLineage: null, proficiencyBonus: 2 } as unknown as PlayerDef, [goliath()])).toBeNull();
  });
});

describe('applyGiantGiftOnHit', () => {
  it("Fire's Burn deals bonus fire damage and spends a use", () => {
    const { ctx: c, target, def } = ctx('fires-burn');
    applyGiantGiftOnHit(c, target, def);
    expect(target.hp).toBeLessThan(30);
    expect(target.hp).toBeGreaterThanOrEqual(20);   // ≤ 1d10
    expect(c.state.player.resources[GIANT_GIFT_ID]).toBe(1);
  });

  it("Frost's Chill deals cold damage and slows the target", () => {
    const { ctx: c, target, def } = ctx('frosts-chill');
    applyGiantGiftOnHit(c, target, def);
    expect(target.hp).toBeLessThan(30);
    expect(target.conditions).toContain('slowed');
  });

  it("Hill's Tumble knocks a Large-or-smaller target Prone", () => {
    const { ctx: c, target, def } = ctx('hills-tumble', 2, 'large');
    applyGiantGiftOnHit(c, target, def);
    expect(target.conditions).toContain('prone');
    expect(c.state.player.resources[GIANT_GIFT_ID]).toBe(1);
  });

  it("Hill's Tumble does NOT fire (or spend a use) against a Huge target", () => {
    const { ctx: c, target, def } = ctx('hills-tumble', 2, 'huge');
    applyGiantGiftOnHit(c, target, def);
    expect(target.conditions).not.toContain('prone');
    expect(c.state.player.resources[GIANT_GIFT_ID]).toBe(2);   // unspent
  });

  it('does nothing when the pool is empty', () => {
    const { ctx: c, target, def } = ctx('fires-burn', 0);
    applyGiantGiftOnHit(c, target, def);
    expect(target.hp).toBe(30);
  });
});

describe("Stone's Endurance (reaction)", () => {
  it('reduces incoming damage by 1d12 + CON, spending a use and the reaction', () => {
    const { ctx: c } = ctx('stones-endurance');
    const reduced = applyStoneEndurance(c, 20);
    expect(reduced).toBeLessThan(20);                 // 20 − (1d12 + 2)
    expect(reduced).toBeGreaterThanOrEqual(20 - 14);  // max reduction 12+2
    expect(c.state.player.resources[GIANT_GIFT_ID]).toBe(1);
    expect(c.state.player.reactionUsed).toBe(true);
  });

  it('does not fire when the reaction is already spent', () => {
    const { ctx: c } = ctx('stones-endurance');
    c.state.player.reactionUsed = true;
    expect(applyStoneEndurance(c, 20)).toBe(20);
    expect(c.state.player.resources[GIANT_GIFT_ID]).toBe(2);
  });
});

describe("Storm's Thunder (reaction)", () => {
  it('deals thunder damage to an attacker within 60 ft, spending a use and the reaction', () => {
    const { ctx: c, target } = ctx('storms-thunder');
    target.tileX = 2; target.tileY = 0;   // 10 ft away
    applyStormsThunder(c, target);
    expect(target.hp).toBeLessThan(30);
    expect(c.state.player.resources[GIANT_GIFT_ID]).toBe(1);
    expect(c.state.player.reactionUsed).toBe(true);
  });

  it('does not fire against an attacker beyond 60 ft', () => {
    const { ctx: c, target } = ctx('storms-thunder');
    target.tileX = 15; target.tileY = 0;  // 75 ft away
    applyStormsThunder(c, target);
    expect(target.hp).toBe(30);
    expect(c.state.player.resources[GIANT_GIFT_ID]).toBe(2);
  });
});
