/**
 * Pure randomization helpers for the Adjudicator's RANDOMIZE encounter flow.
 *
 * The module deliberately knows nothing about the network layer or the scene —
 * it converts an `EncounterArchetype` plus a composed map (with its
 * `anchors`) into the concrete parameters the existing `composeMap` /
 * `composeEncounter` endpoints already accept: feature list, monster ids,
 * starting-zone grid, story text.
 *
 * Starting-zone placement is **anchor-driven**: archetypes declare an ordered
 * list of `PlacementAnchor` preferences (e.g. `['entrance', 'edge:south']`),
 * and the randomizer paints a small cluster of cells around the first anchor
 * present on the rolled map. This keeps random encounters story-suitable —
 * dungeon parties spawn at the entrance, bandits spawn at the campfire — and
 * the fallback `edge:*` anchors guarantee placement even when a feature
 * placer didn't fire.
 */
import {
  STARTING_ZONE_PLAYER,
  STARTING_ZONE_NEUTRAL,
} from "../../shared/startingZones";
import type {
  EncounterArchetype, Feature, PlacementAnchor, TriggerTemplate,
} from "./data/encounterArchetypes";
import type { ComposedMapAnchors } from "./net/GameClient";
import type { ComposedTrigger } from "./ui/generate/TriggerEditor";

export interface RolledEncounter {
  archetypeId: string;
  features: Feature[];
  title: string;
  introduction: string;
  description: string;
  objective: string;
  completionFlag?: string;
  enemyIds: string[];
  allyIds: string[];
  /** Inclusive range used. Surfaced for status messaging. */
  enemyCountRange: [number, number];
  /** Rolled triggers — set later by `rollTriggersFromAnchors`. */
  triggers: ComposedTrigger[];
}

/** Roll archetype-level fields. Does NOT depend on a specific map yet. */
export function rollArchetype(arch: EncounterArchetype): RolledEncounter {
  const features = arch.features
    ? [...arch.features]
    : arch.featurePicks
      ? pickN(arch.featurePicks.from, rollRange(arch.featurePicks.count))
      : [];

  const enemyN = rollRange(arch.enemyCount);
  const enemyIds = Array.from({ length: enemyN }, () => pickRandom(arch.enemyPool));

  let allyIds: string[] = [];
  if (arch.allyPool && arch.allyCount) {
    const allyN = rollRange(arch.allyCount);
    allyIds = Array.from({ length: allyN }, () => pickRandom(arch.allyPool!));
  }

  return {
    archetypeId: arch.id,
    features,
    title: pickRandom(arch.titles),
    introduction: arch.introductions ? pickRandom(arch.introductions) : "",
    description: pickRandom(arch.descriptions),
    objective: pickRandom(arch.objectives),
    completionFlag: arch.completionFlag,
    enemyIds, allyIds,
    enemyCountRange: arch.enemyCount,
    triggers: [],
  };
}

/**
 * Resolve each `TriggerTemplate` against the rolled map's anchors into a
 * concrete `ComposedTrigger` with a clamped `{x,y,w,h}` region. Templates
 * whose anchor doesn't resolve on this map are silently dropped — that's the
 * archetype's permission for variety (some rolls will skip the perception
 * trigger because the path didn't land, etc.). Returns at most
 * `MAX_TRIGGERS` triggers since the TriggerEditor visualises at most that
 * many.
 */
export function rollTriggersFromAnchors(
  width: number, height: number,
  anchors: ComposedMapAnchors,
  templates: TriggerTemplate[] | undefined,
  rolledHostileDefIds: string[],
): ComposedTrigger[] {
  if (!templates || templates.length === 0) return [];
  // De-duplicated list of every rolled hostile-intent monster type, fed to
  // combat-kind triggers so they flip every rolled creature at fire time.
  // (Rolled monsters are spawned `neutral`; without this list a combat
  // trigger would call `trigger_combat` while nobody is yet enemy and the
  // engine would no-op.)
  const uniqueDefIds = Array.from(new Set(rolledHostileDefIds));
  const out: ComposedTrigger[] = [];
  for (let i = 0; i < templates.length && out.length < MAX_TRIGGERS; i++) {
    const t = templates[i];
    const region = regionFromAnchor(width, height, anchors, t.anchor, t.radius ?? DEFAULT_RADIUS);
    if (!region) continue;
    out.push({
      id: `gen_trigger_${i + 1}`,
      region,
      kind: t.kind,
      dc: t.dc ?? 10,
      passMessage: t.passMessage ?? "",
      message: t.message ?? "",
      defId: t.defId ?? "",
      defIds: t.kind === 'combat' ? uniqueDefIds : undefined,
    });
  }
  return out;
}

const MAX_TRIGGERS = 2;
const DEFAULT_RADIUS = 2;

/**
 * Convert a `PlacementAnchor` into a `{x, y, w, h}` region rectangle on the
 * rolled map. Point anchors produce a `(radius*2 + 1)` square around the
 * point; rect anchors return the rect's interior; edge fallbacks return a
 * narrow band along the named edge; `away_from:*` doesn't resolve here (it's
 * used for spawn placement only, not triggers).
 */
function regionFromAnchor(
  W: number, H: number,
  anchors: ComposedMapAnchors,
  anchor: PlacementAnchor,
  radius: number,
): { x: number; y: number; w: number; h: number } | null {
  const point = (p: { x: number; y: number }): { x: number; y: number; w: number; h: number } => {
    const x = clamp(p.x - radius, 0, W - 1);
    const y = clamp(p.y - radius, 0, H - 1);
    const x2 = clamp(p.x + radius, 0, W - 1);
    const y2 = clamp(p.y + radius, 0, H - 1);
    return { x, y, w: x2 - x + 1, h: y2 - y + 1 };
  };

  if (anchor === "entrance" && anchors.entrance) return point(anchors.entrance);
  if (anchor === "vault"    && anchors.vault)    return point(anchors.vault);
  if (anchor === "campfire" && anchors.campfires?.[0]) return point(anchors.campfires[0]);

  if (anchor === "far_room" && anchors.rooms && anchors.entrance) {
    const ent = anchors.entrance;
    let best: { cx: number; cy: number } | null = null;
    let bestDist = -1;
    for (const r of anchors.rooms) {
      const d = Math.abs(r.cx - ent.x) + Math.abs(r.cy - ent.y);
      if (d > bestDist) { bestDist = d; best = r; }
    }
    if (best) return point({ x: best.cx, y: best.cy });
  }

  if (anchor === "building" && anchors.buildings?.[0]) {
    const r = anchors.buildings[0];
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  if (anchor === "ruin" && anchors.ruins?.[0]) {
    const r = anchors.ruins[0];
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  if (anchor === "path_endpoint" && anchors.pathEndpoints && anchors.pathEndpoints.length > 0) {
    // Pick the LAST endpoint so the trigger is at the far end of the trail
    // (the player walks IN at the first endpoint per the placement logic).
    return point(anchors.pathEndpoints[anchors.pathEndpoints.length - 1]);
  }

  if (anchor === "inland" && anchors.inlandBand && anchors.inlandBand.length > 0) {
    // Use the inland band's bounding box.
    const xs = anchors.inlandBand.map((p) => p.x);
    const ys = anchors.inlandBand.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
  }

  if (anchor.startsWith("edge:")) {
    const dir = anchor.slice(5);
    if (dir === "south") return { x: 0, y: H - 3, w: W, h: 3 };
    if (dir === "north") return { x: 0, y: 0,     w: W, h: 3 };
    if (dir === "west")  return { x: 0,     y: 0, w: 3, h: H };
    if (dir === "east")  return { x: W - 3, y: 0, w: 3, h: H };
  }

  // `away_from:*` is spawn-only; trigger templates shouldn't use it (no
  // single rectangle conveys "everywhere far from X"). Drop the template.
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Build the flat row-major starting-zone grid from the archetype's anchor
 * preferences + the composed map's anchors. The first anchor present in each
 * list wins; the archetype is expected to end with an `edge:*` fallback so
 * placement is always defined.
 *
 * Cells are painted generously (cluster around point anchors, full interior
 * for rect anchors, a 3-row band for edge anchors). The server's
 * `parseStartingZones` filters down to passable cells anyway, so a sprinkling
 * of non-passable cells is harmless.
 */
export function buildStartingZonesFromAnchors(
  width: number, height: number,
  anchors: ComposedMapAnchors,
  playerAnchors: PlacementAnchor[],
  enemyAnchors: PlacementAnchor[],
): number[] {
  const cells = width * height;
  const zones = new Array<number>(cells).fill(0);
  const idx = (x: number, y: number): number => y * width + x;

  // Player cells go down first; the would-be "enemy" cells (semantically
  // "things hostile-intent NPCs are clustered around") then claim whatever
  // the player band didn't.
  //
  // **The painter writes NEUTRAL cells here**, not enemy: rolled monsters
  // spawn with `disposition: 'neutral'` to keep the encounter in exploration
  // phase at start. A combat trigger (or the player attacking one of them)
  // flips them to enemy and starts combat.
  const playerCells = resolveAnchors(width, height, anchors, playerAnchors);
  for (const [x, y] of playerCells) {
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (zones[idx(x, y)] !== 0) continue;
    zones[idx(x, y)] = STARTING_ZONE_PLAYER;
  }

  const hostileCells = resolveAnchors(width, height, anchors, enemyAnchors, /* avoid */ zones);
  for (const [x, y] of hostileCells) {
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (zones[idx(x, y)] !== 0) continue;
    zones[idx(x, y)] = STARTING_ZONE_NEUTRAL;
  }

  return zones;
}

/** Pick a single archetype from the registry using each entry's `weight` (default 1). */
export function pickArchetype(archetypes: EncounterArchetype[]): EncounterArchetype {
  if (archetypes.length === 0) throw new Error("encounterArchetypes registry is empty");
  const totalWeight = archetypes.reduce((s, a) => s + (a.weight ?? 1), 0);
  let roll = Math.random() * totalWeight;
  for (const a of archetypes) {
    roll -= a.weight ?? 1;
    if (roll <= 0) return a;
  }
  return archetypes[archetypes.length - 1];
}

// ── Anchor resolution ───────────────────────────────────────────────────────

/**
 * Walk the archetype's anchor list and return cells for the FIRST anchor that
 * resolves on the composed map. Returns `[x, y]` pairs ready to paint into
 * the zone grid; each pair may be out-of-bounds (the caller clamps).
 *
 * `avoid` (optional) is the zones grid built so far — used by `away_from:*`
 * to keep enemy spawns away from the player band.
 */
function resolveAnchors(
  W: number, H: number,
  anchors: ComposedMapAnchors,
  preferences: PlacementAnchor[],
  avoid?: number[],
): Array<[number, number]> {
  for (const pref of preferences) {
    const cells = resolveOne(W, H, anchors, pref, avoid);
    if (cells.length > 0) return cells;
  }
  return [];
}

const CLUSTER_RADIUS = 2;       // 5×5 footprint around point anchors
const EDGE_BAND = 3;            // 3-row band along edge fallbacks

function resolveOne(
  W: number, H: number,
  anchors: ComposedMapAnchors,
  anchor: PlacementAnchor,
  avoid?: number[],
): Array<[number, number]> {
  // Point anchors → 5×5 cluster around the point.
  if (anchor === "entrance" && anchors.entrance) return cluster(anchors.entrance, CLUSTER_RADIUS);
  if (anchor === "vault"    && anchors.vault)    return cluster(anchors.vault,    CLUSTER_RADIUS);
  if (anchor === "campfire" && anchors.campfires?.[0]) return cluster(anchors.campfires[0], CLUSTER_RADIUS);

  // far_room — first room that isn't the entrance.
  if (anchor === "far_room" && anchors.rooms && anchors.entrance) {
    const ent = anchors.entrance;
    let best: { cx: number; cy: number } | null = null;
    let bestDist = -1;
    for (const r of anchors.rooms) {
      const d = Math.abs(r.cx - ent.x) + Math.abs(r.cy - ent.y);
      if (d > bestDist) { bestDist = d; best = r; }
    }
    if (best) return cluster({ x: best.cx, y: best.cy }, CLUSTER_RADIUS);
  }

  // Rect anchors → entire interior of the first stamped feature.
  if (anchor === "building" && anchors.buildings?.[0]) return rect(anchors.buildings[0]);
  if (anchor === "ruin"     && anchors.ruins?.[0])     return rect(anchors.ruins[0]);

  // Path endpoint — prefer the one farthest from the avoid set (so player and
  // enemy can each end up at a different endpoint).
  if (anchor === "path_endpoint" && anchors.pathEndpoints && anchors.pathEndpoints.length > 0) {
    const candidate = pickFarthestFrom(anchors.pathEndpoints, avoid, W);
    return cluster(candidate, CLUSTER_RADIUS);
  }

  // Inland band — pre-baked list of dry-side cells.
  if (anchor === "inland" && anchors.inlandBand) {
    return anchors.inlandBand.map((p) => [p.x, p.y]);
  }

  // Edge fallback — paint a `EDGE_BAND`-row band along the named side.
  if (anchor.startsWith("edge:")) {
    return edgeBand(W, H, anchor.slice(5) as "south" | "north" | "west" | "east");
  }

  // away_from:<name> — return open cells far from the named anchor center.
  if (anchor.startsWith("away_from:")) {
    const target = anchor.slice("away_from:".length);
    const center = anchorCenter(anchors, target);
    if (!center) return [];
    return openCellsFar(W, H, center, avoid);
  }

  return [];
}

function cluster(p: { x: number; y: number }, r: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++)
      out.push([p.x + dx, p.y + dy]);
  return out;
}

function rect(r: { x: number; y: number; w: number; h: number }): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let dy = 0; dy < r.h; dy++)
    for (let dx = 0; dx < r.w; dx++)
      out.push([r.x + dx, r.y + dy]);
  return out;
}

function edgeBand(W: number, H: number, side: "south" | "north" | "west" | "east"): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (side === "south") for (let y = H - EDGE_BAND; y < H; y++) for (let x = 0; x < W; x++) out.push([x, y]);
  else if (side === "north") for (let y = 0; y < EDGE_BAND; y++) for (let x = 0; x < W; x++) out.push([x, y]);
  else if (side === "west") for (let x = 0; x < EDGE_BAND; x++) for (let y = 0; y < H; y++) out.push([x, y]);
  else for (let x = W - EDGE_BAND; x < W; x++) for (let y = 0; y < H; y++) out.push([x, y]);
  return out;
}

function anchorCenter(anchors: ComposedMapAnchors, name: string): { x: number; y: number } | null {
  if (name === "campfire" && anchors.campfires?.[0]) return anchors.campfires[0];
  if (name === "ruin"     && anchors.ruins?.[0])     return rectCenter(anchors.ruins[0]);
  if (name === "building" && anchors.buildings?.[0]) return rectCenter(anchors.buildings[0]);
  if (name === "entrance" && anchors.entrance)       return anchors.entrance;
  return null;
}

function rectCenter(r: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) };
}

/** Pick the endpoint whose center is farthest from any cell currently in `avoid`. */
function pickFarthestFrom(
  pts: Array<{ x: number; y: number }>,
  avoid: number[] | undefined,
  W: number,
): { x: number; y: number } {
  if (!avoid || pts.length === 1) return pts[0];
  let best = pts[0];
  let bestDist = -1;
  for (const p of pts) {
    let nearest = Infinity;
    for (let i = 0; i < avoid.length; i++) {
      if (avoid[i] === 0) continue;
      const x = i % W;
      const y = Math.floor(i / W);
      const d = Math.abs(p.x - x) + Math.abs(p.y - y);
      if (d < nearest) nearest = d;
    }
    if (nearest > bestDist) { bestDist = nearest; best = p; }
  }
  return best;
}

/**
 * Return cells at least MIN_AWAY tiles away from `center`. Used by the
 * `away_from:*` fallback so enemy spawns end up on the opposite side of the
 * map from the named feature (player approaches from outside the camp /
 * ruins).
 */
const MIN_AWAY_FROM = 6;
function openCellsFar(
  W: number, H: number,
  center: { x: number; y: number },
  avoid?: number[],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x - center.x) + Math.abs(y - center.y);
      if (d < MIN_AWAY_FROM) continue;
      if (avoid && avoid[y * W + x] !== 0) continue;
      out.push([x, y]);
    }
  }
  return out;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function rollRange([min, max]: [number, number]): number {
  if (max < min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Pick `n` items from `pool` with replacement. */
function pickN<T>(pool: readonly T[], n: number): T[] {
  return Array.from({ length: n }, () => pickRandom(pool));
}
