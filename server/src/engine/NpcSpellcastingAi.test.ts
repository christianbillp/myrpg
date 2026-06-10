/**
 * Stat-block monster spellcasting (US-117, mage-monster-plan.md slices 4–6):
 * enemy AoE vs the party (cluster targeting, friendly-fire avoidance, the
 * player's Cover bonus to DEX saves), Misty Step / self-Invisibility + NPC
 * concentration, and SRD 5.2.1 Counterspell (slot preserved on a counter).
 * Uses the real spell JSONs so dice/areas/saves stay single-sourced.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestContext, makeNpc, type TestContextResult } from '../test/buildTestContext.js';
import {
  tryNpcOffensiveSpell, tryNpcBonusTeleport, tryNpcSelfBuff,
  tryNpcCounterspell, playerSaveVsDc,
} from './NpcSpellcasting.js';
import { breakNpcConcentrationOnDamage, dropNpcConcentration } from './NpcConcentration.js';
import { doCastSpell } from './SpellSystem.js';
import type { MonsterDef, SpellDef, NpcState } from './types.js';

const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(__dirname, '../../data/spells', `${id}.json`), 'utf-8')) as SpellDef;

function mageDef(overrides: Partial<MonsterDef> = {}): MonsterDef {
  return {
    id: 'test_mage', name: 'Test Mage', type: 'Medium Humanoid (Wizard), Neutral',
    maxHp: 81, ac: 15, str: 9, dex: 14, con: 11, int: 17, wis: 12, cha: 11,
    proficiencyBonus: 3, savingThrows: { con: 0 }, initiativeBonus: 2, stealthBonus: 2,
    passivePerception: 14, speed: 30, attacks: [], xp: 2300, cr: '6', color: 0,
    tokenAsset: 'x.svg', size: 'medium',
    spellcasting: {
      ability: 'int', saveDC: 14,
      perDay: [
        { spellId: 'fireball', uses: 2, castLevel: 4 },
        { spellId: 'invisibility', uses: 2 },
        { spellId: 'cone-of-cold', uses: 1 },
      ],
      bonusAction: [{ spellId: 'misty-step', uses: 3 }],
    },
    reactions: [{ kind: 'protective-magic', usesPerDay: 3 }],
    ...overrides,
  } as MonsterDef;
}

/** Mage at (10,10), hostile to the party + to the `victims` faction. */
function scenario(opts: {
  mage?: Partial<NpcState>; extraNpcs?: NpcState[]; player?: Record<string, unknown>;
  def?: Partial<MonsterDef>;
}): TestContextResult {
  const r = buildTestContext({
    phase: 'enemy_turn',
    player: { tileX: 2, tileY: 2, ...(opts.player ?? {}) },
    playerDef: { con: 11, maxHp: 100, savingThrowProficiencies: [], spellcastingAbility: 'wis', wis: 16 },
    monsters: [mageDef(opts.def)],
    npcs: [
      makeNpc({
        id: 'mage_1', defId: 'test_mage', factionId: 'white_capes',
        tileX: 10, tileY: 10, disposition: 'enemy', hp: 81, maxHp: 81,
        spellUses: { fireball: 2, invisibility: 2, 'cone-of-cold': 1, 'misty-step': 3 },
        reactionUses: { 'protective-magic': 3 },
        ...(opts.mage ?? {}),
      }),
      ...(opts.extraNpcs ?? []),
    ],
  });
  for (const sp of ['fireball', 'invisibility', 'cone-of-cold', 'misty-step']) {
    r.ctx.defs.spells.push(loadSpell(sp));
  }
  r.state.factionRelations = {
    white_capes: { party: -100, victims: -100, friends: 100 },
    party: { white_capes: -100 },
    victims: { white_capes: -100 },
    friends: { white_capes: 100 },
  };
  r.state.relationships = {};
  r.state.environment = { lightLevel: 'bright' };
  return r;
}

const victim = (id: string, x: number, y: number): NpcState =>
  makeNpc({ id, defId: 'commoner', factionId: 'victims', tileX: x, tileY: y, disposition: 'ally', hp: 8, maxHp: 8 });

describe('enemy AoE casting (slice 4)', () => {
  it('fireballs a hostile cluster: one roll, per-creature saves, use decremented, 9d6 at level 4', () => {
    const { ctx, state, events, logs } = scenario({
      extraNpcs: [victim('v1', 2, 3), victim('v2', 3, 2)], // clustered on the player
    });
    const cast = tryNpcOffensiveSpell(ctx, state.npcs[0], mageDef(), events);
    expect(cast).toBe(true);
    expect(state.npcs[0].spellUses?.fireball).toBe(1);
    const text = logs.map((l) => l.left).join('\n');
    expect(text).toContain('casts Fireball (level 4)!');
    expect(text).toMatch(/9d6 fire/);
    // Every creature in the blast rolled a save (player + both victims).
    expect(text).toMatch(/Player (saves|fails)/);
    expect(events.some((e) => e.type === 'spell_vfx' && (e as { style: string }).style === 'area-burst')).toBe(true);
    // The player took fireball damage (full or half — 9d6 min 9, half-min 4).
    expect(state.player.hp).toBeLessThan(100);
  });

  it('never fireballs its own allies — a friendly inside every template suppresses the cast', () => {
    const friend = makeNpc({ id: 'f1', defId: 'commoner', factionId: 'friends', tileX: 3, tileY: 3, disposition: 'neutral', hp: 8, maxHp: 8 });
    const { ctx, state, events } = scenario({ extraNpcs: [friend] });
    // Player at (2,2), friend at (3,3): any sphere centred near the player
    // catches the friend; the cone from (10,10) toward the player does too.
    const cast = tryNpcOffensiveSpell(ctx, state.npcs[0], mageDef(), events);
    expect(cast).toBe(false);
    expect(state.npcs[0].spellUses?.fireball).toBe(2);
  });

  it('does not spend a per-day slot on a single CR-0 chaff target (threat weighting)', () => {
    // Mage hostile only to `victims`; the party is neutral here, one victim in range.
    const { ctx, state, events } = scenario({ extraNpcs: [victim('v1', 8, 8)] });
    state.factionRelations = {
      white_capes: { party: 0, victims: -100 },
      party: { white_capes: 0 },
      victims: { white_capes: -100 },
    };
    const cast = tryNpcOffensiveSpell(ctx, state.npcs[0], mageDef(), events);
    expect(cast).toBe(false);
  });

  it('the player alone IS worth a fireball (threat weight 2)', () => {
    const { ctx, state, events } = scenario({});
    const cast = tryNpcOffensiveSpell(ctx, state.npcs[0], mageDef(), events);
    expect(cast).toBe(true);
    expect(state.player.hp).toBeLessThan(100);
  });
});

describe('playerSaveVsDc — Cover → DEX saves (US-113 closeout)', () => {
  it('adds the cover bonus to the save and notes it in the log', () => {
    const { ctx, events, logs } = scenario({});
    playerSaveVsDc(ctx, 'dex', 14, 20, 'fire', true, events, 2);
    const line = logs.find((l) => l.right?.includes('vs DC 14'));
    expect(line).toBeTruthy();
    expect(line!.right).toContain('(+2 cover)');
  });
});

describe('Misty Step + self-buffs + NPC concentration (slice 5)', () => {
  it('bloodied and cornered, the mage misty-steps away (bonus action, use spent)', () => {
    const { ctx, state, events } = scenario({
      mage: { hp: 30, tileX: 3, tileY: 2 }, // adjacent to the player, bloodied
    });
    const moved = tryNpcBonusTeleport(ctx, state.npcs[0], mageDef(), events);
    expect(moved).toBe(true);
    expect(state.npcs[0].spellUses?.['misty-step']).toBe(2);
    const dist = Math.max(Math.abs(state.npcs[0].tileX - 2), Math.abs(state.npcs[0].tileY - 2));
    expect(dist).toBeGreaterThan(1);
  });

  it('does not misty-step at full hp', () => {
    const { ctx, state, events } = scenario({ mage: { tileX: 3, tileY: 2 } });
    expect(tryNpcBonusTeleport(ctx, state.npcs[0], mageDef(), events)).toBe(false);
  });

  it('surrounded and bloodied, casts Invisibility (concentration) — broken by its own attack', () => {
    const { ctx, state, events } = scenario({
      mage: { hp: 30, tileX: 5, tileY: 5 },
      extraNpcs: [victim('v1', 4, 5), victim('v2', 6, 5), victim('v3', 5, 4)],
    });
    const mage = state.npcs[0];
    expect(tryNpcSelfBuff(ctx, mage, mageDef(), events)).toBe(true);
    expect(mage.conditions).toContain('invisible');
    expect(mage.concentratingOn).toBe('invisibility');
    expect(mage.spellUses?.invisibility).toBe(1);
    dropNpcConcentration(ctx, mage);
    expect(mage.conditions).not.toContain('invisible');
    expect(mage.concentratingOn).toBeUndefined();
  });

  it('a big hit breaks concentration on a failed CON save (DC = half damage)', () => {
    const { ctx, state } = scenario({ mage: { concentratingOn: 'invisibility', conditions: ['invisible'] } });
    const mage = state.npcs[0];
    // CON save +0 vs DC 25 (50 damage): max roll 20 — always fails.
    breakNpcConcentrationOnDamage(ctx, mage, 50);
    expect(mage.concentratingOn).toBeUndefined();
    expect(mage.conditions).not.toContain('invisible');
  });
});

describe('Counterspell (slice 6, SRD 5.2.1)', () => {
  it('counters a cast the player cannot save against, spending the shared pool', () => {
    const { ctx, state, events } = scenario({ def: { spellcasting: { ability: 'int', saveDC: 30, perDay: [] } } });
    const spell = loadSpell('fireball');
    const countered = tryNpcCounterspell(ctx, spell, events);
    expect(countered).toBe(true); // CON +0 can never reach DC 30
    expect(state.npcs[0].reactionUses?.['protective-magic']).toBe(2);
    expect(state.npcs[0].reactionUsed).toBe(true);
  });

  it('a guaranteed save pushes the cast through (reaction still spent)', () => {
    const { ctx, state, events } = scenario({ def: { spellcasting: { ability: 'int', saveDC: 1, perDay: [] } } });
    const countered = tryNpcCounterspell(ctx, loadSpell('fireball'), events);
    expect(countered).toBe(false);
    expect(state.npcs[0].reactionUses?.['protective-magic']).toBe(2); // attempted — pool spent per SRD reaction
  });

  it('out of range (>60 ft) — no attempt at all', () => {
    const { ctx, state, events } = scenario({
      mage: { tileX: 19, tileY: 19 }, player: { tileX: 0, tileY: 0 },
      def: { spellcasting: { ability: 'int', saveDC: 30, perDay: [] } },
    });
    expect(tryNpcCounterspell(ctx, loadSpell('fireball'), events)).toBe(false);
    expect(state.npcs[0].reactionUses?.['protective-magic']).toBe(3);
  });

  it('through doCastSpell: a countered cast wastes the action but keeps the slot', () => {
    const { ctx, state, events } = scenario({
      def: { spellcasting: { ability: 'int', saveDC: 30, perDay: [] } },
      player: { spellSlots: [4, 4, 4], preparedSpellIds: ['bless'] },
    });
    state.phase = 'player_turn';
    ctx.defs.spells.push(loadSpell('bless'));
    doCastSpell(ctx, 'bless', 1, undefined, undefined, false, events);
    expect(state.player.spellSlots[0]).toBe(4);   // slot NOT expended (SRD 5.2.1)
    expect(state.player.actionUsed).toBe(true);   // the action IS wasted
    expect(state.player.concentratingOn).not.toBe('bless'); // the spell never resolved
  });
});
