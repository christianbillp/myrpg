/**
 * In-combat barks — flavorful NPC one-liners on combat events.
 *
 * Forced (impactful) triggers always fire; selectors scope packs to the right
 * creatures; frequent barks are throttled to one per round per NPC; the dead
 * stay silent except for their own death line.
 */
import { describe, it, expect } from 'vitest';
import { emitCombatBark } from './CombatBarks.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, CombatBarkPack } from './types.js';

function def(type: string): MonsterDef {
  return {
    id: 'm', name: 'M', type, maxHp: 10, ac: 12, str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10, speed: 30,
    attacks: [], xp: 10, cr: '1/4', color: 0x999, tokenAsset: 'm.svg', size: 'medium',
  } as MonsterDef;
}

const PACKS: CombatBarkPack[] = [
  { id: 'bandit_surrender', trigger: 'surrender', factions: ['bandits'], lines: ['I yield!'] },
  { id: 'bandit_attack', trigger: 'attack', factions: ['bandits'], lines: ['Hold still!'] },
  { id: 'undead_death', trigger: 'death', types: ['undead'], lines: ['*the bones fall still*'] },
];

function ctxWith(npcOverrides: Parameters<typeof makeNpc>[0], monster: MonsterDef) {
  const r = buildTestContext({
    combatBarks: PACKS,
    monsters: [monster],
    npcs: [makeNpc({ defId: 'm', tileX: 1, tileY: 0, disposition: 'enemy', ...npcOverrides })],
  });
  return { ...r, npc: r.state.npcs[0] };
}

describe('combat barks', () => {
  it('a forced trigger emits a speech bubble + log line from a matching pack', () => {
    const { ctx, events, logs, npc } = ctxWith({ id: 'b1', factionId: 'bandits', hp: 5, maxHp: 10 }, def('Medium Humanoid'));
    emitCombatBark(ctx, npc, 'surrender', { force: true });
    expect(events.some((e) => e.type === 'npc_speech' && (e as { text: string }).text === 'I yield!')).toBe(true);
    expect(logs.some((l) => l.left.includes('I yield!'))).toBe(true);
  });

  it('respects faction + type selectors', () => {
    // A non-bandit gets no bandit surrender line.
    const a = ctxWith({ id: 'c1', factionId: 'commoners', hp: 5, maxHp: 10 }, def('Medium Humanoid'));
    emitCombatBark(a.ctx, a.npc, 'surrender', { force: true });
    expect(a.events.some((e) => e.type === 'npc_speech')).toBe(false);
    // A type-scoped undead death line fires for an undead.
    const u = ctxWith({ id: 'u1', factionId: 'undead', hp: 0, maxHp: 10 }, def('Medium Undead'));
    emitCombatBark(u.ctx, u.npc, 'death', { force: true });
    expect(u.events.some((e) => e.type === 'npc_speech')).toBe(true);
  });

  it('throttles frequent barks to one per round per NPC', () => {
    const { ctx, state, events, npc } = ctxWith({ id: 'b1', factionId: 'bandits', hp: 8, maxHp: 10 }, def('Medium Humanoid'));
    state.combatRound = 1;
    emitCombatBark(ctx, npc, 'attack', { force: true });  // forced → fires, stamps lastBarkRound = 1
    const after = events.filter((e) => e.type === 'npc_speech').length;
    emitCombatBark(ctx, npc, 'attack');                   // same round, not forced → suppressed by cooldown
    expect(events.filter((e) => e.type === 'npc_speech').length).toBe(after);
    expect(npc.lastBarkRound).toBe(1);
  });

  it('the dead stay silent except for their death line', () => {
    const { ctx, events, npc } = ctxWith({ id: 'b1', factionId: 'bandits', hp: 0, maxHp: 10 }, def('Medium Humanoid'));
    emitCombatBark(ctx, npc, 'attack', { force: true });  // hp 0, not a death trigger → nothing
    expect(events.some((e) => e.type === 'npc_speech')).toBe(false);
  });

  it('no-ops when no bark packs are loaded', () => {
    const r = buildTestContext({ monsters: [def('Medium Humanoid')], npcs: [makeNpc({ id: 'b1', defId: 'm', disposition: 'enemy' })] });
    emitCombatBark(r.ctx, r.state.npcs[0], 'surrender', { force: true });
    expect(r.events.some((e) => e.type === 'npc_speech')).toBe(false);
  });
});
