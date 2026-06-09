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
  // ── Combat beats (the ordered animation timeline) ────────────────────────
  // These make the visible sequence of an action first-class and ordered, so
  // the client renders move → swing → hit → damage → death in the exact order
  // the engine resolved them, applying the matching state slice at each beat
  // instead of snapping the final GameState at the end.
  /** An attack swing/cast directed at a target. Drives a brief lunge of the
   *  attacker toward the target; `outcome` lets the client pick the flavour
   *  (whiff vs. impact). Emitted just before the damage beat (if any). */
  | { type: 'attack'; attackerId: string; targetId: string; kind: 'melee' | 'ranged' | 'spell'; outcome: 'hit' | 'miss' | 'crit' }
  /** A creature took `amount` damage, leaving it at `newHp`. The client
   *  animates that token's HP bar down to `newHp`, flashes it, and floats a
   *  damage number — at this beat, not at queue end. */
  | { type: 'damage'; entityId: string; amount: number; newHp: number; damageType?: string }
  /** A creature regained HP, leaving it at `newHp`. Mirror of `damage`. */
  | { type: 'heal'; entityId: string; amount: number; newHp: number }
  /** A creature dropped to 0 HP. The client runs its death fade at this beat
   *  and frees the tile, rather than the token snapping to 40% alpha at end. */
  | { type: 'death'; entityId: string }
  /** A condition was applied to / removed from a creature — drives a condition
   *  pip toggle at this beat. */
  | { type: 'condition_changed'; entityId: string; condition: string; change: 'applied' | 'removed' }
  /** Turn-order boundaries surfaced to the client so the Turn Order Bar
   *  highlight tracks the animation timeline rather than the final state. */
  | { type: 'turn_started'; combatantId: string }
  | { type: 'turn_ended'; combatantId: string }
  /** A spell cast visual — the projectile / beam / burst / glow that plays
   *  *before* the damage / heal / condition beats it precedes. Data-driven
   *  from `SpellDef.vfx`; the client dispatches on `style` and tints by
   *  `palette`. `fromId` is the caster; the target is a creature (`toId`)
   *  and/or a tile (`toX`,`toY`). See `client/src/ui/SpellVfx.ts`. */
  | { type: 'spell_vfx'; style: VfxStyle; palette: string;
      fromId: string; toId?: string; toX?: number; toY?: number;
      shape?: 'sphere' | 'cone' | 'cube' | 'line'; radiusFeet?: number; count?: number }
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

/** The reusable visual primitives every spell maps onto. */
export type VfxStyle =
  | 'projectile'    // a travelling mote (Fire Bolt, Magic Missile×N, hex bolts)
  | 'beam'          // an instant line (Ray of Frost, Lightning Bolt)
  | 'touch-burst'   // a melee-spell crackle/grasp at an adjacent target
  | 'target-burst'  // a burst that appears on the target with no travel
  | 'area-burst'    // an AoE flash at a centre tile (Fireball, Thunderwave)
  | 'zone-spawn'    // a one-shot settle over a persistent zone's tiles
  | 'self-glow'     // a buff aura on the caster
  | 'target-glow'   // a buff/utility glow on a chosen creature
  | 'summon-appear' // a spawn shimmer on a new summon token
  | 'vanish'        // a teleport/phase fade (Misty Step, Blink, Invisibility)
  | 'ambient';      // a faint cast acknowledgement for pure-utility spells
