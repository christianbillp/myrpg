/**
 * Map feature recipe layer (Phase A) — registry dispatch + the watchtower
 * exemplar. Proves a recipe composes a coherent, connected set-piece purely
 * from the op toolbox and emits the zones the encounter layer targets.
 */
import { describe, it, expect } from 'vitest';
import { MapCanvas } from './MapCanvas.js';
import { fillTerrain, passableRegions } from './mapOps.js';
import { placeFeature, composeFeatureMap, stampFeatureOnto, stampExtrasOnto, restampPlaceable, applyBigMapRoads, FEATURE_REGISTRY, FEATURE_IDS } from './mapFeatures.js';
import { composeMap, composeRegions, composeTerrainWithFeature, composeRegionsWithExtras, isDegenerateLayout } from '../MapComposer.js';
import { WALL_RING, objectGid, groundGid } from './materials.js';

function grassCanvas(w = 20, h = 16, seed = 1): MapCanvas {
  const c = new MapCanvas({ width: w, height: h, seed });
  fillTerrain(c, { material: 'grass' });
  return c;
}

describe('feature registry', () => {
  it('exposes ids derived from the registry', () => {
    expect(FEATURE_IDS).toEqual(Object.keys(FEATURE_REGISTRY));
    expect(FEATURE_IDS).toEqual(expect.arrayContaining(['watchtower', 'cemetery', 'town_square']));
  });

  it('rejects an unknown feature id', () => {
    const c = grassCanvas();
    const res = placeFeature(c, 'castle', { x: 2, y: 2, w: 7, h: 7 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('unknown placeable');
  });

  it('rejects a footprint below the recipe minimum', () => {
    const c = grassCanvas();
    const res = placeFeature(c, 'watchtower', { x: 2, y: 2, w: 4, h: 4 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('at least 5×5');
  });

  it('rejects a footprint out of bounds', () => {
    const c = grassCanvas(20, 16);
    const res = placeFeature(c, 'watchtower', { x: 16, y: 12, w: 7, h: 7 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('out of bounds');
  });
});

describe('watchtower recipe', () => {
  it('stamps an enclosed tower, a crate fence with a gate, a courtyard zone — all connected', () => {
    const c = grassCanvas(20, 16, 7);
    const res = placeFeature(c, 'watchtower', { x: 6, y: 4, w: 7, h: 7 });
    expect(res.ok).toBe(true);

    // Tower walls present (centre of footprint is the 3×3 tower).
    const tx = 6 + ((7 - 3) >> 1), ty = 4 + ((7 - 3) >> 1);
    expect(c.getObject(tx, ty)).toBe(WALL_RING.CORNER_TL);
    expect(c.getObject(tx + 2, ty)).toBe(WALL_RING.CORNER_TR);

    // Crate fence on the footprint perimeter, with a south gate gap.
    const crate = objectGid('crate')!;
    expect(c.getObject(6, 4)).toBe(crate);            // NW fence corner
    const gateX = 6 + (7 >> 1);
    expect(c.getObject(gateX, 4 + 7 - 1)).toBe(0);    // gate gap (no crate)

    // Zones: the building zone + the courtyard zone.
    expect(c.zones.some((z) => z.name === 'watchtower')).toBe(true);
    expect(c.zones.some((z) => z.name === 'watchtower courtyard')).toBe(true);

    // Connectivity: the tower interior is reachable from outside the footprint
    // (through the south gate, across the courtyard, through the tower door).
    const { labels } = passableRegions(c);
    const outside = labels[0][0];
    expect(labels[ty + 1][tx + 1]).toBe(outside); // tower interior centre
  });

  it('is deterministic for a given seed', () => {
    const a = grassCanvas(18, 14, 42);
    const b = grassCanvas(18, 14, 42);
    placeFeature(a, 'watchtower', { x: 5, y: 3, w: 5, h: 5 });
    placeFeature(b, 'watchtower', { x: 5, y: 3, w: 5, h: 5 });
    expect(a.objects).toEqual(b.objects);
    expect(a.zones).toEqual(b.zones);
  });
});

describe('cemetery recipe', () => {
  it('stamps a crypt, a fenced plot with grave markers, and stays walkable', () => {
    const c = grassCanvas(20, 16, 3);
    const res = placeFeature(c, 'cemetery', { x: 4, y: 3, w: 9, h: 9 });
    expect(res.ok).toBe(true);

    // Crypt building zone + cemetery zone.
    expect(c.zones.some((z) => z.name === 'crypt')).toBe(true);
    expect(c.zones.some((z) => z.name === 'cemetery')).toBe(true);

    // Grave markers (crates) were placed in the yard.
    const crate = objectGid('crate')!;
    const graves = c.objects.flat().filter((g) => g === crate).length;
    expect(graves).toBeGreaterThan(4); // fence + markers, well over a handful

    // Connectivity: the crypt interior is reachable from outside the plot
    // (through the south gate, up the lanes between graves, through the door).
    const { labels } = passableRegions(c);
    const outside = labels[0][0];
    const cryptX = 4 + ((9 - 3) >> 1);
    expect(labels[3 + 1][cryptX + 1]).toBe(outside); // crypt interior centre
  });
});

describe('town square recipe', () => {
  it('paves a plaza with a central fountain and stays connected around it', () => {
    const c = grassCanvas(20, 16, 9);
    const res = placeFeature(c, 'town_square', { x: 5, y: 4, w: 9, h: 9 });
    expect(res.ok).toBe(true);

    // Plaza paving on the ground layer.
    const plaza = groundGid('plaza')!;
    expect(c.getGround(5, 4)).toBe(plaza);

    // Central fountain pool + zones.
    const pool = groundGid('pool')!;
    const fx = 5 + (9 >> 1) - 1, fy = 4 + (9 >> 1) - 1;
    expect(c.getGround(fx, fy)).toBe(pool);
    expect(c.zones.some((z) => z.name === 'fountain')).toBe(true);
    expect(c.zones.some((z) => z.name === 'town square')).toBe(true);

    // You can walk from the west side of the fountain to the east side (around it).
    const { labels } = passableRegions(c);
    expect(labels[fy][fx - 1]).toBe(labels[fy][fx + 2]);
    expect(labels[fy][fx - 1]).toBeGreaterThanOrEqual(0);
  });
});

describe('composeFeatureMap (set-piece preview)', () => {
  it('produces a flat field with the feature centred, for every registered recipe', () => {
    for (const id of FEATURE_IDS) {
      const m = composeFeatureMap({ width: 24, height: 18, seed: 5, feature: id });
      expect(m.terrainData.length).toBe(24 * 18);
      expect(m.objectData.length).toBe(24 * 18);
      expect(m.name).toBe(FEATURE_REGISTRY[id].label);
      // The recipe ran (it emits at least one zone).
      expect((m.zones ?? []).length, id).toBeGreaterThan(0);
    }
  });

  it('is deterministic per seed and varies the stamp by seed only where the recipe uses rng', () => {
    const a = composeFeatureMap({ width: 20, height: 16, seed: 11, feature: 'watchtower' });
    const b = composeFeatureMap({ width: 20, height: 16, seed: 11, feature: 'watchtower' });
    expect(a.objectData).toEqual(b.objectData);
    expect(a.terrainData).toEqual(b.terrainData);
  });

  it('throws when the map is too small for the feature', () => {
    expect(() => composeFeatureMap({ width: 12, height: 8, seed: 1, feature: 'town_square' })).toThrow(/too small/);
  });

  it('rejects an unknown feature', () => {
    expect(() => composeFeatureMap({ width: 20, height: 16, seed: 1, feature: 'palace' })).toThrow(/unknown placeable/);
  });
});

describe('stampFeatureOnto (combine a set-piece WITH a terrain)', () => {
  it('stamps a watchtower onto a forest, keeping the forest around it and staying connected', () => {
    const base = composeMap({ terrain: 'forest', features: [], width: 26, height: 20, seed: 4 });
    const treeGid = objectGid('tree')!;
    const treesBefore = base.objectData.filter((g) => g === treeGid).length;
    expect(treesBefore).toBeGreaterThan(0); // forest really has trees

    const { map: m } = stampFeatureOnto(base, 'watchtower', 4);
    expect(m.width).toBe(26);
    expect(m.name).toContain('Watchtower');
    // The tower's zones came through alongside whatever the forest emitted.
    expect((m.zones ?? []).some((z) => z.name === 'watchtower')).toBe(true);
    // Forest trees survive OUTSIDE the stamped footprint.
    const treesAfter = m.objectData.filter((g) => g === treeGid).length;
    expect(treesAfter).toBeGreaterThan(0);

    // The stamped tower interior is reachable across the (forested) field.
    const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      c.setGround(x, y, m.terrainData[y * m.width + x]);
      c.setObject(x, y, m.objectData[y * m.width + x]);
    }
    const { sizes } = passableRegions(c);
    // The dominant passable region covers the bulk of the map (tower + field joined).
    expect(Math.max(...sizes)).toBeGreaterThan(m.width * m.height * 0.4);
  });

  it('places the structure consciously so it never collides with terrain', () => {
    // Forest with paths + a coastline = trees, path tiles, and water to collide with.
    const base = composeMap({ terrain: 'forest', features: ['path', 'coastline'], width: 26, height: 20, seed: 8 });
    const { map: m } = stampFeatureOnto(base, 'watchtower', 8);

    // The structure lands wherever conscious placement found a clear spot — read
    // the actual footprint from the recipe's courtyard zone (rect of cells).
    const zone = (m.zones ?? []).find((z) => z.name === 'watchtower courtyard');
    expect(zone, 'courtyard zone emitted').toBeDefined();
    const xs = zone!.cells.map((c) => +c.split(',')[0]);
    const ys = zone!.cells.map((c) => +c.split(',')[1]);
    const [fx0, fx1, fy0, fy1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];

    const tree = objectGid('tree')! & 0x1fffffff;
    const PATH_BASE = 23, PATH_INTERSECTION = 37; // path straight/corner share base 23
    for (let y = fy0; y <= fy1; y++) {
      for (let x = fx0; x <= fx1; x++) {
        const obj = m.objectData[y * m.width + x] & 0x1fffffff; // strip rotation bits
        // No tree or stray path tile survives inside the footprint — the spot was
        // chosen clear and clearFootprint tidied the rest before the recipe stamped.
        expect(obj, `object at (${x},${y})`).not.toBe(tree);
        expect(obj === PATH_BASE || obj === PATH_INTERSECTION, `path at (${x},${y})`).toBe(false);
        // And no blocking water ground remains under the structure.
        const g = m.terrainData[y * m.width + x] & 0x1fffffff;
        expect(g >= 200 && g < 216, `water ground at (${x},${y})`).toBe(false);
      }
    }
  });
});

describe('composeTerrainWithFeature (re-roll until a clean fit)', () => {
  it('returns a map where the set-piece fits cleanly — no terrain overwritten', () => {
    // A path+coastline forest is busy; the re-roll loop should find a seed where
    // the watchtower lands on a clear spot with NOTHING overwritten.
    const m = composeTerrainWithFeature({
      terrain: 'forest', feature: 'watchtower',
      features: ['path', 'coastline'], width: 26, height: 20, seed: 1,
    });
    const zone = (m.zones ?? []).find((z) => z.name === 'watchtower courtyard')!;
    expect(zone).toBeDefined();
    const xs = zone.cells.map((c) => +c.split(',')[0]);
    const ys = zone.cells.map((c) => +c.split(',')[1]);
    const [fx0, fx1, fy0, fy1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];

    const tree = objectGid('tree')! & 0x1fffffff;
    for (let y = fy0; y <= fy1; y++) {
      for (let x = fx0; x <= fx1; x++) {
        const obj = m.objectData[y * m.width + x] & 0x1fffffff;
        const g = m.terrainData[y * m.width + x] & 0x1fffffff;
        expect(obj === tree || obj === 23 || obj === 37, `obstacle at (${x},${y})`).toBe(false);
        expect(g >= 200 && g < 216, `water at (${x},${y})`).toBe(false);
      }
    }
  });

  it('is deterministic per seed', () => {
    const a = composeTerrainWithFeature({ terrain: 'grassland', feature: 'cemetery', features: ['path'], width: 24, height: 18, seed: 7 });
    const b = composeTerrainWithFeature({ terrain: 'grassland', feature: 'cemetery', features: ['path'], width: 24, height: 18, seed: 7 });
    expect(a.terrainData).toEqual(b.terrainData);
    expect(a.objectData).toEqual(b.objectData);
  });

  it('also stamps a set-piece onto a BIG MAP (multi-region), cleanly', () => {
    const m = composeRegionsWithExtras({
      width: 48, height: 24,
      regions: [{ terrain: 'grassland' }, { terrain: 'forest' }, { terrain: 'cave' }],
      feature: 'watchtower', seed: 2,
    });
    expect(m.width).toBe(48);
    // Multiple region zones AND the stamped tower's zones are present.
    expect((m.zones ?? []).some((z) => z.name === 'watchtower')).toBe(true);
    expect((m.zones ?? []).length).toBeGreaterThan(3);

    // The tower footprint holds no tree/path/water — it found an open band.
    const zone = (m.zones ?? []).find((z) => z.name === 'watchtower courtyard')!;
    const xs = zone.cells.map((c) => +c.split(',')[0]);
    const ys = zone.cells.map((c) => +c.split(',')[1]);
    const [fx0, fx1, fy0, fy1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const tree = objectGid('tree')! & 0x1fffffff;
    for (let y = fy0; y <= fy1; y++) {
      for (let x = fx0; x <= fx1; x++) {
        const obj = m.objectData[y * m.width + x] & 0x1fffffff;
        const g = m.terrainData[y * m.width + x] & 0x1fffffff;
        expect(obj === tree || obj === 23 || obj === 37, `obstacle at (${x},${y})`).toBe(false);
        expect(g >= 200 && g < 216, `water at (${x},${y})`).toBe(false);
      }
    }
  });

  it('lays path / intersection ROADS on a big map (across the open bands)', () => {
    const path = composeRegionsWithExtras({
      width: 44, height: 18, regions: [{ terrain: 'grassland' }, { terrain: 'forest' }],
      features: ['path'], seed: 3,
    });
    expect((path.zones ?? []).some((z) => z.name === 'path')).toBe(true);
    const pathTiles = path.objectData.filter((g) => (g & 0x1fffffff) === 23 || (g & 0x1fffffff) === 37).length;
    expect(pathTiles).toBeGreaterThan(10); // a road across the map

    // `intersection` adds the perpendicular cross-road → more road + a 4-way tile.
    const cross = composeRegionsWithExtras({
      width: 44, height: 18, regions: [{ terrain: 'grassland' }, { terrain: 'forest' }],
      features: ['intersection'], seed: 3,
    });
    const crossTiles = cross.objectData.filter((g) => (g & 0x1fffffff) === 23 || (g & 0x1fffffff) === 37).length;
    expect(crossTiles).toBeGreaterThan(pathTiles);
    expect(cross.objectData.some((g) => (g & 0x1fffffff) === 37)).toBe(true); // a 4-way crossing
  });

  it('never lays a road inside a cave or dungeon region', () => {
    const m = composeRegionsWithExtras({
      width: 44, height: 18,
      regions: [{ terrain: 'grassland' }, { terrain: 'forest' }, { terrain: 'cave' }],
      features: ['intersection'], seed: 3,
    });
    // Cave region cells come from its dark zone; none may carry a path tile.
    const caveZone = (m.zones ?? []).find((z) => z.name === 'cave')!;
    expect(caveZone).toBeDefined();
    const isPath = (gid: number) => { const g = gid & 0x1fffffff; return g === 23 || g === 37 || g === 9; };
    for (const cell of caveZone.cells) {
      const [x, y] = cell.split(',').map(Number);
      expect(isPath(m.objectData[y * m.width + x]), `road inside cave at ${cell}`).toBe(false);
    }
    // And a road WAS laid (in the open bands), so this isn't vacuous.
    expect(m.objectData.some((g) => isPath(g))).toBe(true);
  });

  it('stamps STRUCTURES (buildings/ruins) onto a big map too — full creation parity', () => {
    const m = composeRegionsWithExtras({
      width: 48, height: 24,
      regions: [{ terrain: 'grassland' }, { terrain: 'forest' }],
      structures: [{ type: 'building', rooms: 2 }, { type: 'ruin', rooms: 1 }],
      feature: 'town_square', seed: 5,
    });
    // A building zone, a ruin zone, and the town-square zone all landed.
    const names = (m.zones ?? []).map((z) => z.name);
    expect(names).toContain('building');
    expect(names).toContain('ruin');
    expect(names).toContain('town square');

    // Everything stays reachable (conscious placement + clearing keep it walkable).
    const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      c.setGround(x, y, m.terrainData[y * m.width + x]);
      c.setObject(x, y, m.objectData[y * m.width + x]);
    }
    const { sizes } = passableRegions(c);
    expect(Math.max(...sizes)).toBeGreaterThan(m.width * m.height * 0.3);
  });

  it('a multi-room structure emits ONE zone covering the entire structure', () => {
    const base = composeRegions({ width: 36, height: 18, regions: [{ terrain: 'grassland' }, { terrain: 'forest' }], seed: 8 });
    const { map } = stampExtrasOnto(base, [{ id: 'building', params: { rooms: 4 } }], 8);
    const zones = (map.zones ?? []).filter((z) => z.name === 'building');
    expect(zones.length).toBe(1);
    // The zone covers the WHOLE structure: more than a single room, and exactly the
    // footprint bounding box (varied-size rooms tile it via shared walls).
    const cells = zones[0].cells.map((k) => k.split(',').map(Number));
    const xs = cells.map((p) => p[0]), ys = cells.map((p) => p[1]);
    const bbox = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
    expect(zones[0].cells.length).toBeGreaterThan(16); // bigger than one min room
    expect(zones[0].cells.length).toBe(bbox);          // contiguous, full coverage
  });

  it('multi-room structures stay connected — never seal off an isolated pocket', () => {
    // Regression: a multi-room building must link its rooms with shared-wall
    // doorways AND keep an OUTER external entrance, so stamping it onto a
    // connected base never increases the isolated-region count.
    const canvasOf = (m: { width: number; height: number; terrainData: number[]; objectData: number[] }) => {
      const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
      for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
        c.setGround(x, y, m.terrainData[y * m.width + x]);
        c.setObject(x, y, m.objectData[y * m.width + x]);
      }
      return c;
    };
    for (let seed = 1; seed <= 6; seed++) {
      const base = composeRegions({ width: 40, height: 20, regions: [{ terrain: 'grassland' }, { terrain: 'forest' }], seed });
      const baseRegions = passableRegions(canvasOf(base)).sizes.length;
      for (const rooms of [2, 3, 4, 5]) {
        const { map } = stampExtrasOnto(base, [{ id: 'building', params: { rooms } }], seed);
        const after = passableRegions(canvasOf(map)).sizes.length;
        expect(after, `seed ${seed} rooms ${rooms}: building added an isolated pocket`).toBeLessThanOrEqual(baseRegions);
      }
    }
  });
});

// ── Phase B ──────────────────────────────────────────────────────────────────

function canvasFrom(m: { width: number; height: number; terrainData: number[]; objectData: number[] }): MapCanvas {
  const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    c.setGround(x, y, m.terrainData[y * m.width + x]);
    c.setObject(x, y, m.objectData[y * m.width + x]);
  }
  return c;
}

describe('tavern placeable (Phase B → v2)', () => {
  it('is a MULTI-ROOM establishment — a taproom + back rooms, a bar, NO campfire, all connected', () => {
    const m = composeFeatureMap({ width: 30, height: 22, seed: 3, feature: 'tavern', params: { rooms: 4 } });
    const names = (m.zones ?? []).map((z) => z.name);
    expect(names).toContain('tavern');   // overall structure zone
    expect(names).toContain('taproom');  // the common room (room 0)
    // A back room from the role pool came through (more than just taproom + tavern).
    expect(names.filter((n) => ['kitchen', 'cellar', 'snug', 'parlour', 'guest'].includes(n)).length).toBeGreaterThan(0);

    // A bar (barrel bookend) dresses the interior — but never an open-flame campfire.
    const barrels = objectGid('barrels_tall')! & 0x1fffffff; // BARRELS_THREE = bar bookend
    const campfire = objectGid('campfire')! & 0x1fffffff;
    expect(m.objectData.some((g) => (g & 0x1fffffff) === barrels)).toBe(true);
    expect(m.objectData.some((g) => (g & 0x1fffffff) === campfire)).toBe(false);

    // Every room reachable from outside — one passable region across the field.
    expect(passableRegions(canvasFrom(m)).sizes.length).toBe(1);
  });

  it('never places a campfire inside a tavern, across seeds and room counts', () => {
    const campfire = objectGid('campfire')! & 0x1fffffff;
    for (let seed = 1; seed <= 6; seed++) for (const rooms of [1, 2, 3, 4, 5]) {
      const m = composeFeatureMap({ width: 30, height: 22, seed, feature: 'tavern', params: { rooms } });
      expect(m.objectData.some((g) => (g & 0x1fffffff) === campfire), `seed ${seed} rooms ${rooms}`).toBe(false);
    }
  });

  it('stays connected for 1–5 rooms across seeds — never seals an isolated pocket', () => {
    for (let seed = 1; seed <= 6; seed++) {
      for (const rooms of [1, 2, 3, 4, 5]) {
        const m = composeFeatureMap({ width: 30, height: 22, seed, feature: 'tavern', params: { rooms } });
        expect(passableRegions(canvasFrom(m)).sizes.length, `seed ${seed} rooms ${rooms}`).toBe(1);
        expect((m.zones ?? []).some((z) => z.name === 'taproom'), `seed ${seed} rooms ${rooms} taproom`).toBe(true);
      }
    }
  });

  it('the taproom is at least 50% larger than every side room', () => {
    const SIDE = ['kitchen', 'cellar', 'snug', 'parlour', 'guest'];
    for (let seed = 1; seed <= 6; seed++) {
      for (const rooms of [2, 3, 4, 5]) {
        const m = composeFeatureMap({ width: 36, height: 26, seed, feature: 'tavern', params: { rooms } });
        const zones = m.zones ?? [];
        const taproom = zones.find((z) => z.name === 'taproom')!;
        const sides = zones.filter((z) => SIDE.includes(z.name));
        expect(sides.length, `seed ${seed} rooms ${rooms} has side rooms`).toBeGreaterThan(0);
        for (const s of sides) {
          expect(taproom.cells.length, `seed ${seed} rooms ${rooms}: taproom ${taproom.cells.length} vs ${s.name} ${s.cells.length}`)
            .toBeGreaterThanOrEqual(1.5 * s.cells.length);
        }
      }
    }
  });

  it('the rooms param scales the footprint', () => {
    const bbox = (rooms: number): number => {
      const m = composeFeatureMap({ width: 36, height: 26, seed: 5, feature: 'tavern', params: { rooms } });
      const z = (m.zones ?? []).find((zo) => zo.name === 'tavern')!;
      const xs = z.cells.map((k) => +k.split(',')[0]); const ys = z.cells.map((k) => +k.split(',')[1]);
      return (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
    };
    expect(bbox(5)).toBeGreaterThan(bbox(1));
  });
});

describe('building variety (Phase B)', () => {
  it('a ruin uses cracked-stone floor and is connected', () => {
    const m = composeFeatureMap({ width: 24, height: 18, seed: 6, feature: 'ruin', params: { rooms: 3 } });
    expect((m.zones ?? []).some((z) => z.name === 'ruin')).toBe(true);
    const cracked = groundGid('cracked_stone')! & 0x1fffffff;
    expect(m.terrainData.some((g) => (g & 0x1fffffff) === cracked)).toBe(true);
    expect(passableRegions(canvasFrom(m)).sizes.length).toBe(1);
  });

  it('a multi-room building has VARIED room sizes and furnished interiors, still connected', () => {
    const m = composeFeatureMap({ width: 26, height: 18, seed: 1, feature: 'building', params: { rooms: 5 } });
    // Furniture (barrels/chairs/planks) dresses the larger rooms — interior interest.
    const FURNITURE = new Set([14, 28, 55, 41].map((g) => g)); // plank, chair, barrels3, barrels2
    expect(m.objectData.some((g) => FURNITURE.has(g & 0x1fffffff))).toBe(true);
    // Footprint is NOT the old uniform 7×7 grid — varied column/row sizes make it
    // wider/taller. (A uniform 5-room building was exactly 10×7 = bbox 70.)
    const bz = (m.zones ?? []).find((z) => z.name === 'building')!;
    const xs = bz.cells.map((k) => +k.split(',')[0]); const ys = bz.cells.map((k) => +k.split(',')[1]);
    const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
    expect(w).toBeGreaterThan(10); // wider than the old uniform 3-col grid (10)
    expect(passableRegions(canvasFrom(m)).sizes.length).toBe(1);
  });
});

describe('region targeting (Phase B #3)', () => {
  it('places a structure INSIDE the chosen region band', () => {
    // Region 1 (forest) is the middle band; the building must land in its cells.
    const m = composeRegionsWithExtras({
      width: 48, height: 18,
      regions: [{ terrain: 'grassland' }, { terrain: 'forest' }, { terrain: 'grassland' }],
      structures: [{ type: 'building', rooms: 2, region: 1 }], seed: 4,
    });
    const forestZone = (m.zones ?? []).filter((z) => z.id.includes('_region_'))[1];
    const buildingZone = (m.zones ?? []).find((z) => z.name === 'building')!;
    expect(buildingZone).toBeDefined();
    const forestCells = new Set(forestZone.cells);
    // Every building footprint cell lies within the forest region.
    for (const cell of buildingZone.cells) expect(forestCells.has(cell), `building cell ${cell} outside forest`).toBe(true);
  });
});

describe('in-place interior re-roll (Phase B item 0)', () => {
  it('regenerates one placeable interior without changing the rest of the map', () => {
    const base = composeRegionsWithExtras({
      width: 40, height: 18, regions: [{ terrain: 'grassland' }, { terrain: 'forest' }],
      feature: 'tavern', seed: 5,
    });
    expect((base.placements ?? []).length).toBe(1);
    const p = (base.placements ?? [])[0];
    const rerolled = restampPlaceable(base, 0, (p.interiorSeed ^ 0x9e3779b1) >>> 0);

    // The footprint changed (different furniture); OUTSIDE the footprint, identical.
    let insideChanged = false, outsideChanged = false;
    for (let y = 0; y < base.height; y++) for (let x = 0; x < base.width; x++) {
      const i = y * base.width + x;
      const inFoot = x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
      const diff = base.objectData[i] !== rerolled.objectData[i] || base.terrainData[i] !== rerolled.terrainData[i];
      if (diff && inFoot) insideChanged = true;
      if (diff && !inFoot) outsideChanged = true;
    }
    expect(outsideChanged, 'cells outside the footprint must be untouched').toBe(false);
    expect(insideChanged, 'the interior should actually change').toBe(true);
    expect(passableRegions(canvasFrom(rerolled)).sizes.length).toBe(passableRegions(canvasFrom(base)).sizes.length);
  });
});

describe('winding roads (Phase B #2)', () => {
  it('a road bends — it is not a single straight line', () => {
    const base = composeRegions({ width: 50, height: 20, regions: [{ terrain: 'grassland' }, { terrain: 'forest' }], seed: 7 });
    const m = applyBigMapRoads(base, ['path']);
    // Collect the y of every path tile; a straight road occupies ONE row, a
    // winding one spans several.
    const isPath = (g: number) => { const lo = g & 0x1fffffff; return lo === 23 || lo === 37 || lo === 9; };
    const rows = new Set<number>();
    let intersections = 0;
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
      const g = m.objectData[y * m.width + x];
      if (isPath(g)) rows.add(y);
      if ((g & 0x1fffffff) === 37) intersections++;
    }
    expect(rows.size).toBeGreaterThan(1);   // it bends
    expect(intersections).toBe(0);          // a single road never uses the 4-way tile
  });

  it('a road never collides with a structure — no placeable cell sits on a path tile', () => {
    const m = composeRegionsWithExtras({
      width: 48, height: 20, regions: [{ terrain: 'grassland' }, { terrain: 'forest' }],
      features: ['intersection'], structures: [{ type: 'building', rooms: 3 }, { type: 'ruin', rooms: 2 }],
      feature: 'tavern', seed: 2,
    });
    const isPath = (g: number) => { const lo = g & 0x1fffffff; return lo === 23 || lo === 37 || lo === 9; };
    const placeableZones = (m.zones ?? []).filter((z) => ['building', 'ruin', 'tavern'].includes(z.name));
    expect(placeableZones.length).toBeGreaterThan(0);
    for (const z of placeableZones) {
      for (const cell of z.cells) {
        const [x, y] = cell.split(',').map(Number);
        expect(isPath(m.objectData[y * m.width + x]), `road tile under structure at ${cell}`).toBe(false);
      }
    }
  });
});

describe('tactical metrics (Roadmap v2 · M1)', () => {
  it('attaches tactical metrics when requested, and they read a forest as non-degenerate', () => {
    const m = composeTerrainWithFeature({ width: 30, height: 22, terrain: 'forest', feature: 'watchtower', seed: 3, tactical: true });
    expect(m.tactical).toBeDefined();
    expect(m.tactical!.openCells).toBeGreaterThan(0);
    // A forest with a walled watchtower has cover and chokepoints — not degenerate.
    expect(isDegenerateLayout(m.tactical!)).toBe(false);
  });

  it('omits metrics by default (additive, golden-safe)', () => {
    const m = composeTerrainWithFeature({ width: 30, height: 22, terrain: 'forest', feature: 'watchtower', seed: 3 });
    expect(m.tactical).toBeUndefined();
  });

  it('flags a no-cover open blob as degenerate, but not a map with cover + chokepoints', () => {
    expect(isDegenerateLayout({ openCells: 600, coverRatio: 0, openness: 1, chokepoints: [], holdZones: [], loops: 0 })).toBe(true);
    expect(isDegenerateLayout({ openCells: 600, coverRatio: 0.3, openness: 0.6, chokepoints: [{ x: 1, y: 1 }], holdZones: [], loops: 2 })).toBe(false);
  });
});

describe('unified placeable catalog (Phase B 4a)', () => {
  it('stamps a MIXED list of structures + set-pieces in one compose', () => {
    const m = composeTerrainWithFeature({
      width: 36, height: 24, terrain: 'forest',
      placeables: [{ id: 'building', rooms: 2 }, { id: 'tavern' }, { id: 'watchtower' }], seed: 3,
    });
    const ids = (m.placements ?? []).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['building', 'tavern', 'watchtower']));
    // Every placeable is a registry id (structures + set-pieces are one concept).
    for (const id of ids) expect(FEATURE_IDS).toContain(id);
  });
});
