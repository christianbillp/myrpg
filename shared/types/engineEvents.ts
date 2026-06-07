/**
 * Engine-side event-bus payloads.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */

//
// The deterministic substrate the rest of the living-world layer subscribes
// to. Engine systems publish events at well-defined moments; TriggerSystem,
// NPC brains, the Director, and rumor/faction systems all subscribe. The bus
// is synchronous with priority bands — subscribers run in the publisher's
// call stack, can mutate state, and may publish further events (bounded by
// a depth limit in EventBus.ts to catch malformed loops).

export type EngineEvent =
  | { type: 'player_moved'; x: number; y: number }
  /** Published by the Study player-action when the player studies a feature
   *  tile from within reach. Encounter authors hang a `study_feature` trigger
   *  on the tile to resolve the deliberate examination (vs an auto-fire on
   *  movement). The (x,y) is the studied feature's tile. */
  | { type: 'study_feature'; x: number; y: number }
  /** Published by the Magic player-action (the SRD Magic action) when the player
   *  channels magic into a feature tile from within reach — e.g. performing the
   *  binding rite at the keystone. Authors hang a `magic_feature` trigger on the
   *  tile to resolve the rite. */
  | { type: 'magic_feature'; x: number; y: number }
  | { type: 'npc_killed'; npcId: string; defId: string; killerId?: string }
  | { type: 'item_picked_up'; defId: string }
  | { type: 'turn_started'; combatantId: 'player' | string }
  | { type: 'turn_ended'; combatantId: 'player' | string }
  | { type: 'combat_started' }
  | { type: 'combat_ended' }
  /** Published once at session start AFTER triggers register, so encounter authors
   *  can attach lifecycle reactions (intro supertitles, scripted lines, etc.).
   *  The events emitted by these triggers are buffered into the engine's
   *  startup event sink and flushed on the first WS state_update. */
  | { type: 'encounter_started' }
  /** Published once when the encounter resolves — combat ends with no enemies
   *  left alive, OR the encounter's `completionFlag` is set. Authors can hook
   *  closing cinematics, awards, or summary announcements off this. */
  | { type: 'encounter_completed' }
  | { type: 'flag_set'; name: string; value: WorldFlagValue }
  /** Published whenever an entity takes damage. `target` is 'player' or an NPC id. */
  | { type: 'damage_dealt'; target: 'player' | string; amount: number; sourceId?: string }
  /** Published once per crossing direction when an entity's HP ratio drops below or rises above a threshold (defaults: 0.5, 0.25). Listeners can author "boss enrages at 50%" triggers without re-checking each turn. */
  | { type: 'hp_threshold_crossed'; target: 'player' | string; ratio: number; direction: 'below' | 'above' }
  /** A faction's standing with the player changed. */
  | { type: 'faction_changed'; factionId: string; oldValue: number; newValue: number }
  /** A rumor was recorded into world memory. */
  | { type: 'rumor_propagated'; rumorId: string }
  /** Trigger-authored custom event. Lets authors chain triggers via `emit_event` without touching engine code. */
  | { type: 'custom'; name: string; payload?: Record<string, unknown> }
  /** A noise was emitted at a tile (footstep, attack, spell with V component,
   *  shout). `intensity` is the audible radius in tiles; SRD-rough
   *  conversion: whisper=1, footstep=2, normal speech=3, attack/cast=5.
   *  Sound subscribers use this to break Hide on the source and alert
   *  hostile NPCs within the radius. */
  | { type: 'noise'; x: number; y: number; intensity: number; sourceId?: string };

export type WorldFlagValue = number | string | boolean;
