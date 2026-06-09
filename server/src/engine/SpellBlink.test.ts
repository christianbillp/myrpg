/**
 * Spell-gap tail — Blink. A self-buff that, at the end of each of the caster's
 * turns, rolls 1d6; on a 4-6 the caster phases out (`ethereal` condition →
 * untargetable by enemy attacks) until the start of their next turn.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doCastSpell } from './SpellSystem.js';
import { endPlayerTurn } from './CombatFlow.js';
import { pickEnemyAttackTarget } from './NpcTurnRunners.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';
import type { SpellDef, MonsterDef } from './types.js';

const loadSpell = (id: string): SpellDef =>
  JSON.parse(readFileSync(join(__dirname, '../../data/spells', `${id}.json`), 'utf-8')) as SpellDef;

const GOBLIN: MonsterDef = {
  id: 'gob', name: 'Goblin', type: 'Small Humanoid', tokenAsset: '',
  maxHp: 20, ac: 12, str: 10, dex: 10, con: 10, int: 8, wis: 8, cha: 8,
  proficiencyBonus: 2, savingThrows: {}, initiativeBonus: 0, stealthBonus: 0,
  passivePerception: 9, speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0, immunities: [],
} as MonsterDef;

afterEach(() => vi.restoreAllMocks());

describe('Blink', () => {
  it('records the blink self-buff on cast', () => {
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 5, tileY: 5, spellSlots: [4, 4, 4], preparedSpellIds: ['blink'] },
      playerDef: { spellcastingAbility: 'int', int: 16 },
    });
    r.ctx.defs.spells.push(loadSpell('blink'));
    doCastSpell(r.ctx, 'blink', 3, undefined, undefined, false, r.events);
    expect((r.state.player.activeBuffs ?? []).some((b) => b.spellId === 'blink')).toBe(true);
  });

  it('phases out (ethereal) on an end-of-turn 1d6 of 4-6', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);  // d6 → 6
    const r = buildTestContext({
      phase: 'player_turn',
      player: { tileX: 5, tileY: 5, activeBuffs: [{ spellId: 'blink', modifiers: [{ type: 'flag', name: 'blink' }] }] },
      npcs: [makeNpc({ id: 'gob', defId: 'gob', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 6, tileY: 5 })],
    });
    endPlayerTurn(r.ctx, r.events);
    expect(r.state.player.conditions).toContain('ethereal');
  });

  it('an ethereal caster can\'t be targeted by an enemy', () => {
    const r = buildTestContext({
      phase: 'enemy_turn',
      player: { tileX: 5, tileY: 4, conditions: ['ethereal'] },  // dist 1 from atk (ties with friend)
      monsters: [GOBLIN],
      npcs: [
        makeNpc({ id: 'atk', defId: 'gob', disposition: 'enemy', hp: 20, maxHp: 20, tileX: 5, tileY: 5 }),
        makeNpc({ id: 'friend', defId: 'gob', disposition: 'ally', factionId: PLAYER_FACTION_ID, hp: 20, maxHp: 20, tileX: 5, tileY: 6 }),
      ],
    });
    const atk = r.state.npcs[0];
    expect(pickEnemyAttackTarget(r.ctx, atk).id).toBe('friend');  // player phased out → ally taken
    r.state.player.conditions = [];
    expect(pickEnemyAttackTarget(r.ctx, atk).id).toBe('player');  // back on plane → targetable
  });
});
