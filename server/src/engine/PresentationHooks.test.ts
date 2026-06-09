/**
 * PresentationHooks — the bridge that projects internal engine events
 * (`damage_dealt`, `npc_killed`) into the ordered client animation timeline
 * (`damage` / `death` GameEvents on `eventSink`), so the client renders combat
 * beats in resolution order with the correct post-damage HP.
 */
import { describe, it, expect } from 'vitest';
import { registerPresentationHooks } from './PresentationHooks.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';

describe('PresentationHooks bridge', () => {
  it('projects damage_dealt → a damage beat carrying the target post-damage HP', () => {
    const { ctx, state, events } = buildTestContext({
      npcs: [makeNpc({ id: 'gob', tileX: 1, tileY: 0, hp: 12, maxHp: 20 })],
    });
    registerPresentationHooks(ctx);
    // damage_dealt fires AFTER hp is applied, so the npc already sits at 12.
    ctx.publish({ type: 'damage_dealt', target: 'gob', amount: 8 });
    const beat = events.find((e) => e.type === 'damage');
    expect(beat).toEqual({ type: 'damage', entityId: 'gob', amount: 8, newHp: 12 });
    void state;
  });

  it('projects a player damage_dealt → a player damage beat', () => {
    const { ctx, events } = buildTestContext({ player: { hp: 5 } });
    registerPresentationHooks(ctx);
    ctx.publish({ type: 'damage_dealt', target: 'player', amount: 3 });
    expect(events.find((e) => e.type === 'damage')).toEqual({ type: 'damage', entityId: 'player', amount: 3, newHp: 5 });
  });

  it('projects npc_killed → a death beat', () => {
    const { ctx, events } = buildTestContext({
      npcs: [makeNpc({ id: 'gob', tileX: 1, tileY: 0, hp: 0, maxHp: 20 })],
    });
    registerPresentationHooks(ctx);
    ctx.publish({ type: 'npc_killed', npcId: 'gob', defId: 'goblin' });
    expect(events.find((e) => e.type === 'death')).toEqual({ type: 'death', entityId: 'gob' });
  });

  it('preserves order: a move pushed before damage stays before the damage beat', () => {
    const { ctx, events } = buildTestContext({
      npcs: [makeNpc({ id: 'gob', tileX: 1, tileY: 0, hp: 4, maxHp: 20 })],
    });
    registerPresentationHooks(ctx);
    // Simulate the resolution order: the mover writes entity_move directly to
    // the sink, then damage is applied and damage_dealt publishes.
    ctx.eventSink!.push({ type: 'entity_move', entityId: 'gob', toX: 1, toY: 0 });
    ctx.publish({ type: 'damage_dealt', target: 'gob', amount: 16 });
    const types = events.map((e) => e.type);
    expect(types.indexOf('entity_move')).toBeLessThan(types.indexOf('damage'));
  });
});
