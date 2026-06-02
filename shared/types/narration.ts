/**
 * Narration variants for AIGM-flavoured strings.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

//
// One JSON file per narratable moment in server/data/narration/. The
// `narrate(narrationId)` trigger action picks a variant — avoiding the
// last-used index when more than one exists — so ordinary deterministic
// prose feels different on each play without invoking the generative GM.

export interface NarrationDef {
  id: string;
  variants: string[];
  /** Optional per-variant weight (parallel array to `variants`). When omitted, picks are uniform. */
  weights?: number[];
}
