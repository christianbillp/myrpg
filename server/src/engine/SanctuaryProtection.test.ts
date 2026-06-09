/**
 * Spell-gap Bucket 4 (reader spells) — Sanctuary (enemy must save to target the
 * warded creature) and Protection from Poison (cure Poisoned + poison
 * resistance). Sanctuary's reader is tested through the real enemy
 * target-picker; the cast/cure paths run through `doCastSpell`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doCastSpell } from './SpellSystem.js';
import { pickEnemyAttackTarget } from './NpcTurnRunners.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';
import type { SpellDef, MonsterDef, NpcState } from './types.js';

const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(__dirname, '../../data/spells', `${id}.json`), 'utf-8')) as SpellDef;

const monster = (id: string, wis: number, disposition = 'enemy'): MonsterDef => ({
  id, name: id, type: 'Small Humanoid', tokenAsset: '',
  maxHp: 20, ac: 12, str: 10, dex: 10, con: 10, int: 8, wis, cha: 8,
  proficiencyBonus: 2, savingThrows: {}, initiativeBonus: 0, stealthBonus: 0,
  passivePerception: 9, speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0, immunities: [],
} as MonsterDef);

describe('Sanctuary — enemy target-picker reader', () => {
  // attacker (low WIS) + a player-ally both adjacent; the warded player is the
  // tie-break preference, so if the ward blocks the attacker it must fall to
  // the ally instead.
  function setup(playerWis: number, playerPb: number, attackerWis: number) {
    return buildTestContext({
      phase: 'enemy_turn',
      player: { tileX: 5, tileY: 5, conditions: ['sanctuary'] },
      playerDef: { spellcastingAbility: 'wis', wis: playerWis, proficiencyBonus: playerPb },
      monsters: [monster('atk', attackerWis), monster('friend_def', 10, 'ally')],
      npcs: [
        makeNpc({ id: 'atk', defId: 'atk', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 5, tileY: 6 }),
        makeNpc({ id: 'friend', defId: 'friend_def', disposition: 'ally', factionId: PLAYER_FACTION_ID, hp: 20, maxHp: 20, tileX: 5, tileY: 7 }),
      ],
    });
  }

  it('turns the attacker aside from the warded player (failed save → omits player)', () => {
    // Caster DC 19 (8 + PB 6 + WIS 5); attacker WIS 1 (−5) can never make it.
    const { ctx } = setup(20, 6, 1);
    const chosen = pickEnemyAttackTarget(ctx, ctx.state.npcs[0]);
    expect(chosen.id).toBe('friend');  // player was warded off, ally taken instead
  });

  it('lets the attacker through on a successful save', () => {
    // Caster DC 3 (8 + PB 0 + WIS −5); attacker WIS 20 (+5) always makes it.
    const { ctx } = setup(1, 0, 20);
    const chosen = pickEnemyAttackTarget(ctx, ctx.state.npcs[0]);
    expect(chosen.id).toBe('player');  // ward pierced → player is the nearest/preferred target
  });
});

describe('Sanctuary — cast + end-on-attack', () => {
  function castCtx() {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 5, tileY: 5, spellSlots: [4, 4, 4], preparedSpellIds: ['sanctuary', 'protection-from-poison'] },
      playerDef: { spellcastingAbility: 'wis', wis: 16 },
      monsters: [monster('gob', 8)],
      npcs: [makeNpc({ id: 'gob', defId: 'gob', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 6, tileY: 5 })],
    });
    r.ctx.defs.spells.push(loadSpell('sanctuary'), loadSpell('protection-from-poison'));
    return r;
  }

  it('wards the caster on a self-cast', () => {
    const { ctx, state, events } = castCtx();
    doCastSpell(ctx, 'sanctuary', 1, ['player'], undefined, false, events);
    expect(state.player.conditions).toContain('sanctuary');
  });
});

describe('Protection from Poison', () => {
  function ctxWith(npcs: NpcState[] = []) {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 5, tileY: 5, spellSlots: [4, 4, 4], preparedSpellIds: ['protection-from-poison'], conditions: ['poisoned'] },
      playerDef: { spellcastingAbility: 'wis', wis: 16 },
      npcs,
    });
    r.ctx.defs.spells.push(loadSpell('protection-from-poison'));
    return r;
  }

  it('ends Poisoned on the caster and grants a poison-resistance buff', () => {
    const { ctx, state, events } = ctxWith();
    doCastSpell(ctx, 'protection-from-poison', 2, ['player'], undefined, false, events);
    expect(state.player.conditions).not.toContain('poisoned');
    expect((state.player.activeBuffs ?? []).some((b) => b.spellId === 'protection-from-poison')).toBe(true);
  });
});
