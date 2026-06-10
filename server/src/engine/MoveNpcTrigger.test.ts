/**
 * `move_npc` trigger action (ch3-into-hiding-redesign.md) — the
 * authored-content twin of the AIGM `move_entity` tool. `walk` emits the BFS
 * path as `entity_move` steps so the client animates a visible approach
 * (Vane's pursuit stages); `teleport` snaps; blocked/occupied destinations
 * bump to the nearest free tile; a sealed-off walk falls back to snapping.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { registerTriggers } from './TriggerSystem.js';
import type { EncounterTrigger } from './types.js';

function scenario(action: Record<string, unknown>, opts?: { wallRow?: number }) {
  const r = buildTestContext({
    phase: 'exploring',
    player: { tileX: 0, tileY: 0 },
    npcs: [makeNpc({ id: 'hunter', defId: 'mage', tileX: 2, tileY: 2, disposition: 'neutral', hp: 81, maxHp: 81 })],
  });
  if (opts?.wallRow !== undefined) {
    for (let x = 0; x < r.state.map.cols; x++) r.state.map.blocksMovement[opts.wallRow][x] = true;
  }
  const trigger: EncounterTrigger = {
    id: 'stage',
    when: { event: 'flag_set', name: 'go' },
    then: [action as EncounterTrigger['then'][number]],
    once: true,
  };
  r.state.triggers = [trigger];
  registerTriggers(r.ctx);
  return r;
}

describe('move_npc trigger action', () => {
  it('walk mode relocates the NPC and emits the path as entity_move steps', () => {
    const { ctx, state, events } = scenario({ type: 'move_npc', defId: 'mage', x: 8, y: 2, mode: 'walk' });
    ctx.eventSink = events;
    ctx.bus.publish({ type: 'flag_set', name: 'go', value: true });
    expect([state.npcs[0].tileX, state.npcs[0].tileY]).toEqual([8, 2]);
    const steps = events.filter((e) => e.type === 'entity_move');
    expect(steps.length).toBe(6); // (2,2)→(8,2), start tile excluded
    expect(steps[steps.length - 1]).toMatchObject({ entityId: 'hunter', toX: 8, toY: 2 });
  });

  it('teleport mode snaps with a single move event', () => {
    const { ctx, state, events } = scenario({ type: 'move_npc', defId: 'mage', x: 10, y: 10, mode: 'teleport' });
    ctx.eventSink = events;
    ctx.bus.publish({ type: 'flag_set', name: 'go', value: true });
    expect([state.npcs[0].tileX, state.npcs[0].tileY]).toEqual([10, 10]);
    expect(events.filter((e) => e.type === 'entity_move')).toHaveLength(1);
  });

  it('a blocked destination bumps to the nearest free tile', () => {
    const { ctx, state } = scenario({ type: 'move_npc', defId: 'mage', x: 5, y: 6 }, { wallRow: 6 });
    ctx.bus.publish({ type: 'flag_set', name: 'go', value: true });
    const npc = state.npcs[0];
    expect(npc.tileY).not.toBe(6); // row 6 is solid — bumped off it
    expect(Math.max(Math.abs(npc.tileX - 5), Math.abs(npc.tileY - 6))).toBe(1);
  });

  it('a sealed-off walk destination still relocates (snap fallback)', () => {
    // Wall row 6 seals the map's south half from the hunter at (2,2).
    const { ctx, state, events } = scenario({ type: 'move_npc', defId: 'mage', x: 5, y: 10, mode: 'walk' }, { wallRow: 6 });
    ctx.eventSink = events;
    ctx.bus.publish({ type: 'flag_set', name: 'go', value: true });
    expect([state.npcs[0].tileX, state.npcs[0].tileY]).toEqual([5, 10]);
  });
});
