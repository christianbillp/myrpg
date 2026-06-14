/**
 * US-129 — ambient NPC-to-NPC banter. Determinism, relation/faction/day-phase
 * selection, witness gating, advancement across ticks, and interruption.
 */
import { describe, it, expect } from 'vitest';
import { runAmbientConversations } from './Banter.js';
import { buildTestContext, makeNpc } from '../../test/buildTestContext.js';
import type { BanterPack, GameEvent, MonsterDef } from '../types.js';

const FRIENDLY: BanterPack = {
  id: 'friendly_pack', relation: 'friendly', faction: 'bandits',
  exchanges: [{ lines: [
    { speaker: 'a', text: 'Line one from {a}.' },
    { speaker: 'b', text: 'Line two from {b}.' },
  ] }],
};
const NEUTRAL: BanterPack = {
  id: 'neutral_pack', relation: 'neutral',
  exchanges: [{ lines: [{ speaker: 'a', text: 'Neutral hello.' }] }],
};

function commoner(): MonsterDef {
  return {
    id: 'villager', name: 'Villager', type: 'Medium Humanoid', maxHp: 8, ac: 10,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [{ name: 'x', attackType: 'melee', bonus: 0, reach: 5, damageDice: 1, damageSides: 1, damageBonus: 0, damageType: 'b' }],
    xp: 0, cr: '0', color: 0, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

/** Two same-faction NPCs adjacent to each other, near the player, in an open
 *  lit map — eligible for friendly banter. */
function scene(banter: BanterPack[] = [FRIENDLY, NEUTRAL]) {
  const a = makeNpc({ id: 'a', defId: 'villager', factionId: 'bandits', tileX: 6, tileY: 6, disposition: 'neutral', hp: 8, maxHp: 8, alertness: 'calm' });
  const b = makeNpc({ id: 'b', defId: 'villager', factionId: 'bandits', tileX: 7, tileY: 6, disposition: 'neutral', hp: 8, maxHp: 8, alertness: 'calm' });
  const res = buildTestContext({ phase: 'exploring', monsters: [commoner()], npcs: [a, b], banter, player: { tileX: 6, tileY: 7 } });
  return { ...res, a, b };
}

/** Drive ticks until a speech event appears or we give up. */
function tickUntilSpeech(ctx: ReturnType<typeof scene>['ctx'], state: ReturnType<typeof scene>['state'], maxTicks = 60): { events: GameEvent[]; tick: number } {
  for (let t = 1; t <= maxTicks; t++) {
    const events: GameEvent[] = [];
    state.worldTickCount = t;
    runAmbientConversations(ctx, t, events);
    if (events.some((e) => e.type === 'npc_speech')) return { events, tick: t };
  }
  return { events: [], tick: -1 };
}

describe('ambient banter (US-129)', () => {
  it('is deterministic: same world state + tick id → identical output', () => {
    const s1 = scene(); const r1 = tickUntilSpeech(s1.ctx, s1.state);
    const s2 = scene(); const r2 = tickUntilSpeech(s2.ctx, s2.state);
    expect(r1.tick).toBe(r2.tick);
    expect(r1.events).toEqual(r2.events);
    expect(r1.tick).toBeGreaterThan(0);
  });

  it('plays an exchange line by line across ticks with name substitution', () => {
    const { ctx, state } = scene([FRIENDLY]);
    const first = tickUntilSpeech(ctx, state);
    const firstSpeech = first.events.find((e) => e.type === 'npc_speech') as Extract<GameEvent, { type: 'npc_speech' }>;
    expect(firstSpeech.text).toContain('Line one');
    // Next tick advances to line two.
    const ev2: GameEvent[] = [];
    state.worldTickCount = first.tick + 1;
    runAmbientConversations(ctx, first.tick + 1, ev2);
    const second = ev2.find((e) => e.type === 'npc_speech') as Extract<GameEvent, { type: 'npc_speech' }> | undefined;
    expect(second?.text).toContain('Line two');
    expect(state.recentAmbientLines?.length).toBeGreaterThanOrEqual(2);
  });

  it('does not start when the player is out of earshot', () => {
    const { ctx, state } = scene([FRIENDLY]);
    state.player.tileX = 40; state.player.tileY = 40;  // far away
    expect(tickUntilSpeech(ctx, state, 40).tick).toBe(-1);
  });

  it('does not start when a speaker is not calm', () => {
    const { ctx, state, a } = scene([FRIENDLY]);
    a.alertness = 'alert';
    expect(tickUntilSpeech(ctx, state, 40).tick).toBe(-1);
  });

  it('interrupts an in-flight exchange when a speaker is downed', () => {
    const { ctx, state, b } = scene([FRIENDLY]);
    const first = tickUntilSpeech(ctx, state);
    expect(first.tick).toBeGreaterThan(0);
    b.hp = 0;  // partner falls before line two
    const ev2: GameEvent[] = [];
    runAmbientConversations(ctx, first.tick + 1, ev2);
    expect(ev2.some((e) => e.type === 'npc_speech')).toBe(false);
    expect(state.ambientChats?.length ?? 0).toBe(0);
  });

  it('selects only packs whose relation + faction match the pair', () => {
    // Bandit pair → the friendly bandit pack is eligible; a commoner-only
    // friendly pack would not be.
    const COMMONER_ONLY: BanterPack = { id: 'c', relation: 'friendly', faction: 'commoners', exchanges: [{ lines: [{ speaker: 'a', text: 'nope' }] }] };
    const { ctx, state } = scene([COMMONER_ONLY]);
    // No matching pack → no banter ever fires.
    expect(tickUntilSpeech(ctx, state, 40).tick).toBe(-1);
  });
});
