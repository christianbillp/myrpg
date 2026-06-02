/**
 * Animation events (server → client).
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

// Cross-domain imports — keep these explicit so the dependency graph is visible.
import type { EngineEvent } from "./engineEvents.js";

export type GameEvent =
  | { type: 'entity_move'; entityId: string; toX: number; toY: number }
  | { type: 'log'; lines: string[] }
  /** Show a speech-bubble above the named entity for a few seconds. Pushed by
   *  the AIGM `npc_speaks` tool (and future trigger actions); the client
   *  resolves the entity ref (`player` / `enemy_A` / `npc_<id>`) to a token
   *  position and renders an absolutely-positioned bubble. `speakerName` is
   *  the display name as the player knows it (revealed name when set,
   *  otherwise the def's generic label) so the client can also mirror the
   *  line into the GM chat as a scrollable record of the conversation. */
  | { type: 'npc_speech'; entityId: string; text: string; speakerName: string }
  /** A noise was emitted at the given tile. The client renders a brief
   *  expanding circle (a "sound ring") at the source so the player gets
   *  visual feedback of audible events — useful when the noise came from
   *  outside the player's line of sight. `intensity` is in tiles (matches
   *  the server-side EngineEvent radius). */
  | { type: 'sound_ring'; x: number; y: number; intensity: number }
  /** Play a one-off sound effect. The `sound` field is a logical id the
   *  client maps to an audio file (see `SoundLibrary` in
   *  `client/src/ui/SoundLibrary.ts`). Reserved for cinematic SFX cues
   *  (physical-attack hit, spell impact, …) — NOT for the per-tile noise
   *  events fed into the Hide/Perception model, which use `sound_ring`
   *  plus the engine-side `noise` event. */
  | { type: 'play_sound'; sound: string }
  /** Black-out fade overlay covering the entire canvas + every UI panel.
   *  `mode: 'out'` runs opacity → 1 (full black); `mode: 'in'` runs → 0
   *  (fully clear); `mode: 'dim'` runs → 0.5 (50% black — atmospheric dim
   *  where the world remains visible underneath). The event blocks the
   *  event queue for `durationMs` so subsequent events (e.g. a supertitle
   *  during a fade-out hold) play in sequence. */
  | { type: 'screen_fade'; mode: 'in' | 'out' | 'dim'; durationMs: number }
  /** Movie-style location title — huge centred white text holding the screen
   *  for `durationMs` (defaults applied client-side). Blocks the event queue
   *  for the duration so callers can chain fade_out → supertitle → fade_in. */
  | { type: 'supertitle'; text: string; durationMs?: number }
  /** Centre-screen announcement intended to mirror the event log. The server
   *  is responsible for also appending the text to `state.eventLog` so the
   *  message persists after the announcement fades.
   *
   *  `mode` controls how the announcement integrates with the live game:
   *    - `focused` (default for cinematic beats): orange-bordered card; the
   *      Player Panel, Target Panel, and HUD are hidden; player movement /
   *      actions are locked; world-tick is paused for the duration.
   *    - `unfocused`: borderless card with a soft edge-fade gradient. The UI
   *      stays visible, the world keeps ticking, the player can keep playing. */
  | { type: 'announcement'; text: string; durationMs?: number; mode?: 'focused' | 'unfocused' };
