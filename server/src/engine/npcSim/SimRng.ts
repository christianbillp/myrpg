/**
 * Deterministic RNG for NPC simulation decisions.
 *
 * Every NPC decision pulls from a seeded stream keyed by `(tickId, npcId)`
 * so the same world state + the same tick produces the same outcome — a
 * hard requirement for replays, tests, and bisecting "why did the baker
 * walk off a cliff on tick 12489."
 *
 * The seed combine fn is `mulberry32` (already used by `MapComposer`).
 * It's fast, ~2³² period, and good enough for game-style randomness — we
 * do NOT need cryptographic quality.
 *
 * USAGE
 * -----
 * ```ts
 * const rng = SimRng.forNpcTick(tickId, npc.id);
 * const dmg = rng.roll(2, 6);                          // 2d6
 * const target = rng.pick(candidateTargets);           // uniform pick
 * const success = rng.chance(0.7);                     // 70% bool
 * ```
 *
 * Call sites must NEVER reach for `Math.random()`. Any NPC-decision code
 * path that does is non-deterministic by definition; the lint rule (TODO)
 * will catch new occurrences. Existing `Math.random` in EnemyAI / NpcBrain
 * stay until those modules are migrated onto the new engine — they don't
 * affect the determinism of the new sim until they're called from inside it.
 */

/** Internal — mulberry32 step. Returns the next [0, 1) float and mutates
 *  the seed in place via the closure. */
function mulberryStep(state: { s: number }): number {
  state.s = (state.s + 0x6D2B79F5) >>> 0;
  let t = state.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0)) / 4294967296;
}

/** Cheap string → uint32 hash. FNV-1a 32-bit. Deterministic across runs. */
function hashStringToUint32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class SimRng {
  private readonly state: { s: number };

  /** Constructed from a raw 32-bit seed. Most callers prefer the static
   *  `forNpcTick` factory which derives the seed deterministically. */
  constructor(seed: number) {
    this.state = { s: seed >>> 0 };
  }

  /**
   * Derive a per-NPC, per-tick RNG. Same tickId + same npcId → same
   * stream every time. Different NPCs on the same tick get independent
   * streams (so a goblin's decision doesn't depend on the wolf's).
   */
  static forNpcTick(tickId: number, npcId: string): SimRng {
    // Combine the two so different (tick, npc) pairs collide pseudo-
    // randomly rather than by simple addition.
    const npcHash = hashStringToUint32(npcId);
    const seed = (tickId * 0x9E3779B1) ^ npcHash;
    return new SimRng(seed >>> 0);
  }

  /** Returns a uniform float in `[0, 1)`. */
  next(): number {
    return mulberryStep(this.state);
  }

  /** Integer in `[0, n)`. Returns 0 if `n <= 0`. */
  intBelow(n: number): number {
    if (n <= 0) return 0;
    return Math.floor(this.next() * n);
  }

  /** Roll `dice` dice with `sides` sides. Same conventions as `Dice.d()`. */
  roll(dice: number, sides: number): number {
    let total = 0;
    for (let i = 0; i < dice; i++) total += 1 + this.intBelow(sides);
    return total;
  }

  /** Uniform pick from a non-empty array. Returns the first element if the
   *  array is empty (defensive — call sites should check length). */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) return items[0];
    return items[this.intBelow(items.length)];
  }

  /** Weighted pick. Each entry's `weight` is its relative chance; weights
   *  need not sum to 1. Returns `null` only when the array is empty. */
  pickWeighted<T>(items: ReadonlyArray<{ value: T; weight: number }>): T | null {
    if (items.length === 0) return null;
    let total = 0;
    for (const e of items) total += Math.max(0, e.weight);
    if (total <= 0) return items[0].value;
    let roll = this.next() * total;
    for (const e of items) {
      roll -= Math.max(0, e.weight);
      if (roll <= 0) return e.value;
    }
    return items[items.length - 1].value;
  }

  /** True with probability `p` (clamped to [0, 1]). */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }
}
