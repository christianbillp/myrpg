/**
 * Tactical analysis (Roadmap v2 · G1). Proves the fighting-shape metrics read a
 * map correctly: corridors are chokepoint-dense and fully covered, open fields
 * are not; pockets register as hold-zones; ring layouts show loops.
 */
import { describe, it, expect } from 'vitest';
import { tacticalAnalysis, type TacticalGrid } from './tactical.js';
import { objectGid, groundGid } from './materials.js';

const GRASS = groundGid('grass')!;
const WALL = objectGid('tree')!; // any blocking object

/** Build a TacticalGrid from an ASCII map: '#' = blocking, anything else open. */
function grid(rows: string[]): TacticalGrid {
  const height = rows.length, width = rows[0].length;
  return {
    width, height,
    getGround: () => GRASS,
    getObject: (x, y) => (rows[y][x] === '#' ? WALL : 0),
  };
}

const FIELD = grid(Array.from({ length: 8 }, () => '........'));
const CORRIDOR = grid(['#######', '#.....#', '#######']);

describe('tacticalAnalysis', () => {
  it('a corridor is chokepoint-dense and fully covered; an open field is neither', () => {
    const field = tacticalAnalysis(FIELD);
    const corridor = tacticalAnalysis(CORRIDOR);

    expect(corridor.chokepoints.length).toBeGreaterThan(field.chokepoints.length);
    expect(field.chokepoints.length).toBe(0);
    expect(corridor.coverRatio).toBeGreaterThan(field.coverRatio);
    expect(corridor.coverRatio).toBe(1);          // every corridor cell hugs a wall
    expect(field.openness).toBeGreaterThan(corridor.openness);
  });

  it('is deterministic for a given grid', () => {
    expect(tacticalAnalysis(CORRIDOR)).toEqual(tacticalAnalysis(CORRIDOR));
  });

  it('flags defensible pockets reached through 1–2 chokepoints as hold zones', () => {
    // Two rooms joined by a one-tile corridor — each room is a hold zone.
    const m = grid([
      '#########',
      '#...#...#',
      '#...#...#',
      '#.......#',  // the gap at col 4 is the connecting chokepoint
      '#...#...#',
      '#########',
    ]);
    const t = tacticalAnalysis(m);
    expect(t.holdZones.length).toBeGreaterThanOrEqual(2);
    for (const z of t.holdZones) expect(z.entrances).toBeLessThanOrEqual(2);
  });

  it('counts loops — a ring has an alternate route, a dead-end corridor does not', () => {
    const ring = grid([
      '#####',
      '#...#',
      '#.#.#',
      '#...#',
      '#####',
    ]);
    const deadEnd = grid(['#####', '#...#', '###.#', '###.#', '#####']);
    expect(tacticalAnalysis(ring).loops).toBeGreaterThanOrEqual(1);
    expect(tacticalAnalysis(deadEnd).loops).toBe(0);
  });
});
