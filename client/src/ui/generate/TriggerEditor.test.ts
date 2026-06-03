/**
 * Cross-check the four data structures the TriggerEditor relies on:
 * `ALL_KINDS` (the chip-strip render list), `KIND_LABEL` (chip text),
 * `KIND_SWATCH` (chip colour), and `KIND_TOOLTIP` (chip hover text).
 *
 * Why this test exists: the editor's chip strip historically used an
 * inline `allKinds` array literal, separate from the three `Record`
 * tables. Adding a new action required editing 4 places; forgetting
 * the inline array was the failure mode (the `set_companion` chip
 * silently missed from the strip until a user noticed it wasn't
 * available in the editor). The literal is now `ALL_KINDS` (single
 * source of truth) and this test pins the synchronisation.
 *
 * TypeScript's `Record<TriggerActionKind, string>` already enforces
 * exhaustiveness on the three Record tables at compile time; this
 * test extends the guarantee to `ALL_KINDS` (an array, not a Record)
 * which isn't type-checked the same way.
 */
import { describe, it, expect } from 'vitest';
import { ALL_KINDS, KIND_LABEL, KIND_SWATCH, KIND_TOOLTIP } from './TriggerEditor.js';

describe('TriggerEditor kind tables stay in sync', () => {
  it('ALL_KINDS lists every key from KIND_LABEL', () => {
    expect([...ALL_KINDS].sort()).toEqual(Object.keys(KIND_LABEL).sort());
  });

  it('ALL_KINDS lists every key from KIND_SWATCH', () => {
    expect([...ALL_KINDS].sort()).toEqual(Object.keys(KIND_SWATCH).sort());
  });

  it('ALL_KINDS lists every key from KIND_TOOLTIP', () => {
    expect([...ALL_KINDS].sort()).toEqual(Object.keys(KIND_TOOLTIP).sort());
  });

  it('ALL_KINDS has no duplicates', () => {
    expect(new Set(ALL_KINDS).size).toBe(ALL_KINDS.length);
  });

  it('every kind has a non-empty label', () => {
    for (const k of ALL_KINDS) {
      expect(KIND_LABEL[k]?.length, `${k} has empty label`).toBeGreaterThan(0);
    }
  });

  it('every kind has a non-empty tooltip', () => {
    for (const k of ALL_KINDS) {
      expect(KIND_TOOLTIP[k]?.length, `${k} has empty tooltip`).toBeGreaterThan(0);
    }
  });

  it('every kind has a valid hex-colour swatch', () => {
    for (const k of ALL_KINDS) {
      expect(KIND_SWATCH[k], `${k} swatch missing`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
