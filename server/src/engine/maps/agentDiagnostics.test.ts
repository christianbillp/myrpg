/**
 * Continuous AI-build diagnostics (Roadmap v2 · M5/#9). The per-op feedback line
 * flags disconnected regions so the agent self-corrects before finishing.
 */
import { describe, it, expect } from 'vitest';
import { MapCanvas } from './MapCanvas.js';
import { stampRoom } from './mapOps.js';
import { buildDiagnostics } from './mapAgent.js';

describe('buildDiagnostics', () => {
  it('reports a single connected space for one room', () => {
    const c = new MapCanvas({ width: 16, height: 12, seed: 1 });
    stampRoom(c, { x: 2, y: 2, w: 6, h: 6, floor: 'stone_floor', doorways: [{ x: 4, y: 7 }] });
    const d = buildDiagnostics(c);
    expect(d).toContain('one connected space');
    expect(d).toContain('cover');
  });

  it('warns when two rooms are sealed off from each other', () => {
    const c = new MapCanvas({ width: 24, height: 12, seed: 1 });
    stampRoom(c, { x: 2, y: 2, w: 5, h: 6, floor: 'stone_floor' }); // no doorway
    stampRoom(c, { x: 14, y: 2, w: 5, h: 6, floor: 'stone_floor' });
    expect(buildDiagnostics(c)).toContain('DISCONNECTED');
  });

  it('says so when there is no floor yet', () => {
    const c = new MapCanvas({ width: 10, height: 10, seed: 1 });
    expect(buildDiagnostics(c)).toContain('no walkable floor');
  });
});
