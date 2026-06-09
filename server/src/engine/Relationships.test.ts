/**
 * Individual relationship layer — the per-creature scope in front of the faction
 * matrix. Verifies the capability the refactor unlocks: same-faction members can
 * be enemies, opposing-faction members can be friends, and an individual link to
 * the player overrides a hostile faction baseline.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { isHostileTo, isFriendlyTo, setRelation } from './FactionRelations.js';
import {
  setIndividualRelation, relation, projectDisposition, aggroOnAttack, reprojectAllDispositions,
} from './Relationships.js';
import { PLAYER_ID, PLAYER_FACTION_ID } from '../../../shared/types.js';

const view = (id: string, factionId: string) => ({ id, factionId });

function ctxWith(npcs: ReturnType<typeof makeNpc>[]) {
  return buildTestContext({ npcs });
}

describe('Individual relationship layer', () => {
  it('resolves individual override → faction baseline → 0', () => {
    const { state } = ctxWith([
      makeNpc({ id: 'a', defId: 'x', factionId: 'bandits', tileX: 1, tileY: 1, hp: 10, maxHp: 10 }),
      makeNpc({ id: 'b', defId: 'x', factionId: 'guards', tileX: 2, tileY: 1, hp: 10, maxHp: 10 }),
    ]);
    // No links, no faction cell → 0.
    expect(relation(state, 'a', 'b')).toBe(0);
    // Faction baseline applies when no individual override.
    setRelation(state, 'bandits', 'guards', -60);
    expect(relation(state, 'a', 'b')).toBe(-60);
    // Individual override wins over the faction baseline.
    setIndividualRelation(state, 'a', 'b', 75);
    expect(relation(state, 'a', 'b')).toBe(75);
  });

  it('same-faction members are friendly by default but can be made enemies', () => {
    const { state } = ctxWith([
      makeNpc({ id: 'a', defId: 'x', factionId: 'bandits', tileX: 1, tileY: 1, hp: 10, maxHp: 10 }),
      makeNpc({ id: 'b', defId: 'x', factionId: 'bandits', tileX: 2, tileY: 1, hp: 10, maxHp: 10 }),
    ]);
    expect(isHostileTo(state, view('a', 'bandits'), view('b', 'bandits'))).toBe(false);
    expect(isFriendlyTo(state, view('a', 'bandits'), view('b', 'bandits'))).toBe(true);

    // An intra-faction grudge — one −link makes them mutually hostile (worse direction).
    setIndividualRelation(state, 'a', 'b', -100);
    expect(isHostileTo(state, view('a', 'bandits'), view('b', 'bandits'))).toBe(true);
    expect(isHostileTo(state, view('b', 'bandits'), view('a', 'bandits'))).toBe(true);
  });

  it('opposing-faction members can be individual friends', () => {
    const { state } = ctxWith([
      makeNpc({ id: 'a', defId: 'x', factionId: 'bandits', tileX: 1, tileY: 1, hp: 10, maxHp: 10 }),
      makeNpc({ id: 'g', defId: 'x', factionId: 'guards', tileX: 2, tileY: 1, hp: 10, maxHp: 10 }),
    ]);
    setRelation(state, 'bandits', 'guards', -80);
    expect(isHostileTo(state, view('a', 'bandits'), view('g', 'guards'))).toBe(true);

    // A personal loyalty overrides the faction feud.
    setIndividualRelation(state, 'a', 'g', 80, { mirror: true });
    expect(isHostileTo(state, view('a', 'bandits'), view('g', 'guards'))).toBe(false);
    expect(isFriendlyTo(state, view('a', 'bandits'), view('g', 'guards'))).toBe(true);
  });

  it('an individual friendly to the player projects neutral despite a hostile faction', () => {
    const { state } = ctxWith([
      makeNpc({ id: 'orc', defId: 'x', factionId: 'monsters', tileX: 1, tileY: 1, hp: 10, maxHp: 10 }),
    ]);
    setRelation(state, 'monsters', PLAYER_FACTION_ID, -100);
    expect(projectDisposition(state, state.npcs[0])).toBe('enemy');

    // This particular orc owes the player a life-debt.
    setIndividualRelation(state, 'orc', PLAYER_ID, 100, { mirror: true });
    expect(projectDisposition(state, state.npcs[0])).toBe('neutral');
  });

  it('aggro on attack rallies the victim\'s friends but not its intra-faction enemies', () => {
    const { state } = ctxWith([
      makeNpc({ id: 'victim', defId: 'x', factionId: 'townsfolk', tileX: 1, tileY: 1, hp: 10, maxHp: 10 }),
      makeNpc({ id: 'friend', defId: 'x', factionId: 'townsfolk', tileX: 2, tileY: 1, hp: 10, maxHp: 10 }),
      makeNpc({ id: 'rival', defId: 'x', factionId: 'townsfolk', tileX: 3, tileY: 1, hp: 10, maxHp: 10 }),
    ]);
    // 'rival' hates the victim despite sharing a faction.
    setIndividualRelation(state, 'rival', 'victim', -100, { mirror: true });
    reprojectAllDispositions(state);

    aggroOnAttack(state, state.npcs.find((n) => n.id === 'victim')!);

    const disp = (id: string) => state.npcs.find((n) => n.id === id)!.disposition;
    expect(disp('victim')).toBe('enemy');  // the attacked creature
    expect(disp('friend')).toBe('enemy');  // a faction-mate who likes the victim rallies
    expect(disp('rival')).toBe('neutral'); // the victim's enemy stays out of it
  });
});
