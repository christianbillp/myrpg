import type {
  GameState, GameEvent, PlayerAction, ServerWSMessage, CreateSessionRequest, StorylogEntry, AdventureSave,
  LevelUpPreview, LevelUpChoices, PlayerDef,
  LongRestPreview, LongRestChoices,
} from '../../../shared/types';
import { DevMode } from '../devMode';

const API_URL = 'http://localhost:3000';
const WS_URL  = 'ws://localhost:3000';

/**
 * Named regions of interest returned by `POST /generate/map/composed`. Every
 * field is optional — only features the composer actually placed are populated.
 * Consumed by the encounter randomizer for story-suitable spawn placement.
 * Mirrors the server-side `MapAnchors` shape.
 */
export interface ComposedMapAnchors {
  campfires?: Array<{ x: number; y: number }>;
  inlandBand?: Array<{ x: number; y: number }>;
  /** Cells where a path emerges at the map edge (2 for a straight, 3 for an
   *  intersection or T-junction). */
  pathEndpoints?: Array<{ x: number; y: number }>;
  /** The crossing cell of two paths, populated only when the `intersection`
   *  feature is on. */
  pathIntersection?: { x: number; y: number };
  /** Building footprints (full rectangle, stone-floor interior). */
  buildings?: Array<{ x: number; y: number; w: number; h: number }>;
  /** Dungeon rooms (rect + centre). Populated when terrain is `dungeon`. */
  rooms?: Array<{ x: number; y: number; w: number; h: number; cx: number; cy: number }>;
  /** Centre of the southernmost dungeon room — the entry corridor lands here. */
  entrance?: { x: number; y: number };
  /** Centre of the dungeon room farthest from the entrance. */
  vault?: { x: number; y: number };
}

/** Compact exact-tile spawn shape used in both the refine request (current
 *  state) and the response (the AI's proposal). */
export interface SpawnTile {
  /** Slot index into the role's id array — e.g. `{ index: 1, x, y }` binds
   *  the second entry of `enemyIds`. Omitted on the player spawn. */
  index?: number;
  x: number;
  y: number;
}

export type TriggerActionKindWire =
  | 'perception' | 'log' | 'aigm' | 'combat' | 'xp'
  | 'announcement' | 'speech' | 'fade' | 'set_flag'
  | 'enable_long_rest' | 'disable_long_rest'
  | 'hide_npc' | 'kill_npc' | 'open_conversation'
  | 'set_companion';

/** One author-facing action — used both for a trigger's primary action and
 *  for entries in `extraActions`. Every per-kind field is optional. */
export interface ComposedActionWire {
  kind: TriggerActionKindWire;
  dc?: number;
  passMessage?: string;
  message?: string;
  defId?: string;
  defIds?: string[];
  xpAmount?: number;
  durationMs?: number;
  entityRef?: string;
  fadeMode?: 'in' | 'out' | 'dim';
  announcementMode?: 'focused' | 'unfocused';
  setFlagName?: string;
  hidden?: boolean;
  hideDC?: number;
  revealedBy?: 'perception' | 'trigger';
  dropInventory?: boolean;
  corpseSearchDc?: number;
  corpseSearchSuccess?: string;
  corpseSearchFail?: string;
  npcRef?: string;
  conversationId?: string;
  isCompanion?: boolean;
  followMode?: 'tight' | 'loose';
  returnDisposition?: 'neutral' | 'ally' | 'enemy';
}

/** Subset of the editor's `ComposedTrigger` carried over the wire. */
export interface RefinerTrigger {
  id: string;
  whenEvent?: 'player_moved' | 'encounter_started' | 'encounter_completed' | 'flag_set';
  region: { x: number; y: number; w: number; h: number };
  kind: TriggerActionKindWire;
  dc?: number;
  passMessage?: string;
  message: string;
  defId?: string;
  defIds?: string[];
  xpAmount?: number;
  durationMs?: number;
  entityRef?: string;
  fadeMode?: 'in' | 'out' | 'dim';
  announcementMode?: 'focused' | 'unfocused';
  whenFlagName?: string;
  setFlagName?: string;
  hidden?: boolean;
  hideDC?: number;
  revealedBy?: 'perception' | 'trigger';
  dropInventory?: boolean;
  corpseSearchDc?: number;
  corpseSearchSuccess?: string;
  corpseSearchFail?: string;
  npcRef?: string;
  conversationId?: string;
  isCompanion?: boolean;
  followMode?: 'tight' | 'loose';
  returnDisposition?: 'neutral' | 'ally' | 'enemy';
  /** Additional consequences appended to this trigger's `then` array
   *  after the primary action. Each entry is the same shape as the
   *  primary action; the server expansion walks them in order. */
  extraActions?: ComposedActionWire[];
}

/** Shape of the encounter draft sent to `/generate/encounter/refine`. Mirrors
 *  `EncounterDraftForRefine` on the server. The AI may modify any subset of
 *  text, rosters, spawn positions, and triggers. Read-only context (current
 *  trigger summaries) is included so its edits stay coherent. */
export interface EncounterRefineDraft {
  title: string;
  introduction: string;
  /** Long-form scene context the AIGM reads silently — maps to the
   *  encounter's `customContext` field on disk. */
  aigmContext: string;
  /** Player-facing card summary — maps to the encounter's `description`
   *  field on disk. Surfaced on the Single Encounter Setup screen. */
  description: string;
  objective: string;
  completionFlag: string;
  allyIds: string[];
  enemyIds: string[];
  neutralIds: string[];
  /** One-line summaries of the encounter's current triggers — read-only. */
  triggers: string[];
  /** Full trigger objects — the baseline the AI replaces wholesale when
   *  proposing `triggerObjects`. */
  triggerObjects: RefinerTrigger[];
  /** Map this draft is built on. Server reads it to build the passability
   *  grid the AI uses for spatial decisions. */
  mapId: string;
  /** Currently bound exact-mode placements. */
  playerPlacement: { x: number; y: number } | null;
  enemyPlacements: SpawnTile[];
  allyPlacements: SpawnTile[];
  neutralPlacements: SpawnTile[];
  /** Zone-based starts — `[x, y]` pairs per role. */
  playerZones: Array<[number, number]>;
  allyZones: Array<[number, number]>;
  enemyZones: Array<[number, number]>;
  neutralZones: Array<[number, number]>;
}

/** Subset of `EncounterRefineDraft` the AI is allowed to propose. */
export interface EncounterRefineProposed {
  title?: string;
  introduction?: string;
  /** Long-form AIGM scene context (writes to `customContext`). */
  aigmContext?: string;
  /** Player-facing card summary (writes to `description`). */
  description?: string;
  objective?: string;
  completionFlag?: string;
  allyIds?: string[];
  enemyIds?: string[];
  neutralIds?: string[];
  /** Single exact tile for the player. */
  playerSpawn?: { x: number; y: number };
  /** Per-slot exact tiles for each role. */
  enemySpawns?: SpawnTile[];
  allySpawns?: SpawnTile[];
  neutralSpawns?: SpawnTile[];
  /** Full trigger objects — replaces the existing trigger list wholesale. */
  triggerObjects?: RefinerTrigger[];
}

/** Response from `/generate/encounter/refine`. `proposed` is a partial — only
 *  fields the model wants to change are present. */
export interface EncounterRefineResponse {
  proposed: EncounterRefineProposed;
  rationale: string;
}

/** Shape of one adventure chapter sent to / proposed by the adventure
 *  refiner. Mirrors the `AdventureChapter` shape minus optional fields the
 *  AI doesn't author. */
export interface AdventureRefineChapter {
  id: string;
  title: string;
  encounterId: string;
  completionFlag?: string;
}

/** Shape of the adventure draft sent to `/generate/adventure/refine`. Mirrors
 *  `AdventureDraftForRefine` on the server. */
export interface AdventureRefineDraft {
  /** snake_case adventure id. The AI sees it for context but doesn't propose
   *  changes — the user owns the id. */
  id: string;
  title: string;
  description: string;
  introduction: string;
  aiContext: string;
  chapters: AdventureRefineChapter[];
  /** Empty string when no rest encounter is set. */
  restEncounterId: string;
}

/** Subset of the draft the AI is allowed to propose. `chapters` and
 *  `restEncounterId` replace the existing values wholesale when present. */
export interface AdventureRefineProposed {
  title?: string;
  description?: string;
  introduction?: string;
  aiContext?: string;
  chapters?: AdventureRefineChapter[];
  /** Empty string clears the rest encounter. */
  restEncounterId?: string;
}

export interface AdventureRefineResponse {
  proposed: AdventureRefineProposed;
  rationale: string;
}

/** Draft shape sent to `/generate/npc/refine`. Mirrors `NpcDraftForRefine`
 *  on the server: identity + persona + persistent / conversation. */
export interface NpcRefineDraft {
  id: string;
  name: string;
  monsterClass: string;
  factionId: string;
  color: string;
  tokenAsset: string;
  persona: string;
  persistent: boolean;
  conversationId: string;
}

/** Subset of the draft the AI is allowed to propose. */
export interface NpcRefineProposed {
  name?: string;
  monsterClass?: string;
  factionId?: string;
  color?: string;
  tokenAsset?: string;
  persona?: string;
  persistent?: boolean;
  conversationId?: string;
}

export interface NpcRefineResponse {
  proposed: NpcRefineProposed;
  rationale: string;
}

export type StateUpdateHandler = (state: GameState, events: GameEvent[]) => void;
export type AIGMReplyHandler   = (reply: string) => void;

// Streaming AIGM handlers — fed by aigm_start / aigm_chunk /
// aigm_speculative_discard / aigm_done WebSocket messages.
export interface AIGMStreamHandlers {
  onStart?: () => void;
  onChunk?: (text: string) => void;
  onCheckpoint?: () => void;
  onSpeculativeDiscard?: () => void;
  onDone?: (reply: string, rollResults: string[]) => void;
}

/** Thrown by `saveToken` when a token with the same id already exists on the
 *  server. The Token Creator catches this and prompts the user to confirm
 *  overwrite; on confirmation it retries `saveToken(spec, { overwrite: true })`. */
export class TokenExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenExistsError";
  }
}

/** One tileset's legend block as served by `GET /tilesets/legends`. */
export interface TileLegendBlock {
  tileset: string;
  image: string;
  notes: string;
  tiles: Record<string, import("../../../shared/types").TileLegendEntry>;
}

/** Tileset image-slicing metadata from `GET /tilesets`. */
export interface TilesetMeta {
  imageUrl: string;
  tilewidth: number;
  tileheight: number;
  margin: number;
  spacing: number;
  columns: number;
}


export class GameClient {
  private sessionId: string | null = null;
  private ws: WebSocket | null = null;
  private onStateUpdate: StateUpdateHandler | null = null;
  private onAIGMReply: AIGMReplyHandler | null = null;
  private aigmStreamHandlers: AIGMStreamHandlers | null = null;
  private onDisconnect: (() => void) | null = null;
  private intentionalClose = false;

  setStateUpdateHandler(fn: StateUpdateHandler): void { this.onStateUpdate = fn; }
  setAIGMReplyHandler(fn: AIGMReplyHandler): void { this.onAIGMReply = fn; }
  setAIGMStreamHandlers(handlers: AIGMStreamHandlers): void { this.aigmStreamHandlers = handlers; }
  setDisconnectHandler(fn: () => void): void { this.onDisconnect = fn; }

  resumeSession(sessionId: string): void { this.sessionId = sessionId; }
  getSessionId(): string | null { return this.sessionId; }

  async loadWorld(): Promise<{ sessionId: string; state: GameState; playerDef?: PlayerDef; gmHistory: { role: 'user' | 'assistant'; content: string }[] } | null> {
    try {
      const res = await fetch(`${API_URL}/world`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return res.json() as Promise<{ sessionId: string; state: GameState; playerDef?: PlayerDef; gmHistory: { role: 'user' | 'assistant'; content: string }[] }>;
    } catch {
      return null;
    }
  }

  async createSession(req: CreateSessionRequest): Promise<{ state: GameState; playerDef: PlayerDef }> {
    // Auto-attach the current Dev Mode toggles so every session-create call
    // site picks them up without having to thread DevMode through manually.
    // Caller-supplied `devFlags` (if any) win — explicit > implicit.
    const body: CreateSessionRequest = req.devFlags
      ? req
      : { ...req, devFlags: DevMode.snapshotDevFlags() };
    const res = await fetch(`${API_URL}/game/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const { sessionId, state, playerDef } = await res.json() as { sessionId: string; state: GameState; playerDef: PlayerDef };
    this.sessionId = sessionId;
    return { state, playerDef };
  }

  connectWebSocket(): void {
    if (!this.sessionId) { console.error('connectWebSocket: no sessionId'); return; }
    this.intentionalClose = false;
    this.ws = new WebSocket(`${WS_URL}/game/session/${this.sessionId}/ws`);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as ServerWSMessage;
      if (msg.type === 'state_update') {
        this.onStateUpdate?.(msg.state, msg.events);
      } else if (msg.type === 'aigm_reply') {
        this.onAIGMReply?.(msg.reply);
      } else if (msg.type === 'aigm_start') {
        this.aigmStreamHandlers?.onStart?.();
      } else if (msg.type === 'aigm_chunk') {
        this.aigmStreamHandlers?.onChunk?.(msg.text);
      } else if (msg.type === 'aigm_checkpoint') {
        this.aigmStreamHandlers?.onCheckpoint?.();
      } else if (msg.type === 'aigm_speculative_discard') {
        this.aigmStreamHandlers?.onSpeculativeDiscard?.();
      } else if (msg.type === 'aigm_done') {
        this.aigmStreamHandlers?.onDone?.(msg.reply, msg.rollResults);
      }
    };
    this.ws.onerror = (e) => console.error('WebSocket error:', e);
    this.ws.onclose = () => {
      if (!this.intentionalClose) this.onDisconnect?.();
    };
  }

  /** Close the WS and delete the server session. `keepWorldSave` preserves the
   *  on-disk world save (used when leaving an adventure) so the exact encounter
   *  state can be restored on return; otherwise the save is cleared. */
  async disconnect(keepWorldSave = false): Promise<void> {
    this.intentionalClose = true;
    this.detachAndClose(this.ws);
    this.ws = null;
    if (this.sessionId) {
      const q = keepWorldSave ? '?keepWorldSave=1' : '';
      await fetch(`${API_URL}/game/session/${this.sessionId}${q}`, { method: 'DELETE' }).catch(() => {});
      this.sessionId = null;
    }
  }

  /** Close the local WebSocket without deleting the server-side session. Used when transitioning between chapter sessions in adventure mode. */
  closeWebSocket(): void {
    this.intentionalClose = true;
    this.detachAndClose(this.ws);
    this.ws = null;
  }

  /**
   * Strip all listeners off an outgoing WebSocket BEFORE calling `close()`,
   * then close it. Critical for the chapter-advance flow: `ws.onclose` reads
   * `this.intentionalClose` *when it fires*, not when it was attached. If we
   * close the old WS, immediately wire up a new one (which sets
   * `intentionalClose = false`), and only then the old WS's pending close
   * event fires, the old handler sees `intentionalClose: false`, calls
   * `onDisconnect`, and ConnectionMonitor reloads the browser — silently
   * killing the chapter transition. Nulling the handlers first detaches
   * the old ws from the gameClient's state entirely.
   */
  private detachAndClose(ws: WebSocket | null): void {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch { /* already closing */ }
  }

  async sendAction(action: PlayerAction): Promise<void> {
    if (!this.sessionId) return;
    await fetch(`${API_URL}/game/session/${this.sessionId}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    // State update arrives via WebSocket
  }

  /**
   * Fetch the SRD level-up preview for the active session's character.
   * Returns `null` when the character isn't eligible yet — typically because
   * the XP threshold hasn't been reached. The Player Panel already guards
   * the LEVEL UP button on `availableActions.canLevelUp`, so a null return
   * here just means the server's view is stale (e.g. XP awarded between
   * frames).
   */
  async fetchLevelUpPreview(): Promise<LevelUpPreview | null> {
    if (!this.sessionId) return null;
    const res = await fetch(`${API_URL}/game/session/${this.sessionId}/level-up`);
    if (!res.ok) throw new Error(`level-up preview failed: ${res.status}`);
    const body = await res.json() as { preview: LevelUpPreview | null };
    return body.preview;
  }

  /**
   * Confirm a level-up. The server applies the changes, persists them to the
   * character save, and returns the post-level-up state + updated PlayerDef
   * so the client can refresh its cached copy.
   */
  async commitLevelUp(choices: LevelUpChoices): Promise<{ state: GameState; playerDef: PlayerDef; preview: LevelUpPreview }> {
    if (!this.sessionId) throw new Error('No active session.');
    const res = await fetch(`${API_URL}/game/session/${this.sessionId}/level-up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choices }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `level-up commit failed: ${res.status}`);
    }
    return res.json() as Promise<{ state: GameState; playerDef: PlayerDef; preview: LevelUpPreview }>;
  }

  /**
   * Fetch the SRD Long Rest preview for the active session. Returns `null`
   * when the encounter doesn't permit Long Rest or the player is in combat
   * — the PlayerPanel already gates the LONG REST button on
   * `availableActions.canLongRest`, so a null here usually indicates a race.
   */
  async fetchLongRestPreview(): Promise<LongRestPreview | null> {
    if (!this.sessionId) return null;
    const res = await fetch(`${API_URL}/game/session/${this.sessionId}/long-rest`);
    if (!res.ok) throw new Error(`long-rest preview failed: ${res.status}`);
    const body = await res.json() as { preview: LongRestPreview | null };
    return body.preview;
  }

  /** Confirm a Long Rest. Returns post-rest state + updated PlayerDef. */
  async commitLongRest(choices: LongRestChoices): Promise<{ state: GameState; playerDef: PlayerDef; preview: LongRestPreview }> {
    if (!this.sessionId) throw new Error('No active session.');
    const res = await fetch(`${API_URL}/game/session/${this.sessionId}/long-rest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choices }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `long-rest commit failed: ${res.status}`);
    }
    return res.json() as Promise<{ state: GameState; playerDef: PlayerDef; preview: LongRestPreview }>;
  }

  async sendAIGMMessage(
    playerMessage: string,
    gmPersona: 'story' | 'dev',
  ): Promise<{ reply: string; rollResults: string[] }> {
    if (!this.sessionId) return { reply: '', rollResults: [] };
    const res = await fetch(`${API_URL}/game/session/${this.sessionId}/aigm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerMessage, gmPersona }),
    });
    if (!res.ok) throw new Error(`AIGM request failed: ${res.status}`);
    const { reply, rollResults } = await res.json() as { reply: string; rollResults: string[] };
    // State update (if AIGM used tools) arrives via WebSocket
    return { reply, rollResults: rollResults ?? [] };
  }

  // Save / delete (kept for the setup screen)
  async loadSave(characterId: string): Promise<unknown> {
    const res = await fetch(`${API_URL}/save/${characterId}`);
    return res.ok ? res.json() : null;
  }

  async deleteSave(characterId: string): Promise<void> {
    await fetch(`${API_URL}/save/${characterId}`, { method: 'DELETE' });
  }

  async loadAdventureSave(characterId: string): Promise<AdventureSave | null> {
    const res = await fetch(`${API_URL}/adventure/${characterId}`);
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' && 'adventureId' in body ? (body as AdventureSave) : null;
  }

  async deleteAdventureSave(characterId: string): Promise<void> {
    await fetch(`${API_URL}/adventure/${characterId}`, { method: 'DELETE' });
  }

  /**
   * Request an AI-generated one-off encounter. The server validates the
   * Claude output, writes both map + encounter JSON files, refreshes its
   * in-memory `defs`, and returns the new encounterId. The caller then
   * starts a session against that encounter via `startGeneratedEncounter`.
   */
  async generateEncounter(req: {
    prompt: string;
    playerName?: string;
    playerClassName?: string;
  }): Promise<{ encounterId: string; mapId: string }> {
    const res = await fetch(`${API_URL}/generate/encounter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Generation failed: ${res.status}`);
    }
    return res.json() as Promise<{ encounterId: string; mapId: string }>;
  }

  /**
   * Ask the AI to refine an in-progress encounter draft. The server returns
   * a partial patch (only fields the model wants to change) plus a short
   * rationale. The caller computes the diff and shows Accept / Reject — the
   * server does NOT persist anything.
   */
  async refineEncounter(
    draft: EncounterRefineDraft,
    prompt: string,
  ): Promise<EncounterRefineResponse> {
    const res = await fetch(`${API_URL}/generate/encounter/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft, prompt }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Refine failed: ${res.status}`);
    }
    return res.json() as Promise<EncounterRefineResponse>;
  }

  /** Adventure counterpart to `refineEncounter`. The server picks the
   *  encounter pool fresh from disk so newly authored encounters are
   *  immediately available as chapter / rest picks. */
  async refineAdventure(
    draft: AdventureRefineDraft,
    prompt: string,
  ): Promise<AdventureRefineResponse> {
    const res = await fetch(`${API_URL}/generate/adventure/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft, prompt }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Refine failed: ${res.status}`);
    }
    return res.json() as Promise<AdventureRefineResponse>;
  }

  /** NPC counterpart to `refineEncounter` / `refineAdventure`. */
  async refineNpc(
    draft: NpcRefineDraft,
    prompt: string,
  ): Promise<NpcRefineResponse> {
    const res = await fetch(`${API_URL}/generate/npc/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft, prompt }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Refine failed: ${res.status}`);
    }
    return res.json() as Promise<NpcRefineResponse>;
  }

  /**
   * Compose a map deterministically from terrain + features toggles. Used
   * when the player has set any of the map-style toggles on
   * `MapEditorScene` — bypasses Claude entirely and returns a map built
   * by the rule-based composer in `engine/MapComposer.ts`.
   */
  async composeMap(args: {
    terrain: 'grassland' | 'forest' | 'dungeon' | 'tavern';
    features: Array<'campsites' | 'coastline' | 'path' | 'intersection' | 'buildings' | '3-room' | '5-room'>;
    seed?: number;
    /** When `features` includes `'buildings'`, this controls the count
     *  (1..5). Clamped server-side; defaults to 1 when omitted. */
    buildingsCount?: number;
  }): Promise<{
    /** Always null for /generate/map/composed — the preview is not persisted. Call `saveMap` to persist. */
    mapId: null;
    width: number;
    height: number;
    terrainData: number[];
    objectData: number[];
    name: string;
    description: string;
    tilesets: Array<{ firstgid: number; source: string }>;
    /** Story-suitable spawn anchors found / stamped by the composer (campfires, inlandBand, pathEndpoints, etc). */
    anchors: ComposedMapAnchors;
    /** Named tile regions emitted by feature placers (currently `path` and
     *  `intersection`). Empty array when the chosen features produced none. */
    zones: Array<{ id: string; name: string; color: string; cells: string[] }>;
  }> {
    const res = await fetch(`${API_URL}/generate/map/composed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Map compose failed: ${res.status}`);
    }
    return res.json() as Promise<{
      mapId: null; width: number; height: number;
      terrainData: number[]; objectData: number[];
      name: string; description: string;
      tilesets: Array<{ firstgid: number; source: string }>;
      anchors: ComposedMapAnchors;
      zones: Array<{ id: string; name: string; color: string; cells: string[] }>;
    }>;
  }

  /**
   * Persist a map. Returns the mapId. When `existingMapId` is set the
   * server overwrites that map in place (used by the Map Editor's LOAD MAP
   * → edit → SAVE flow); otherwise a fresh `gen_<stamp>_<slug>` id is
   * allocated.
   */
  async saveMap(args: {
    name: string;
    description: string;
    width: number;
    height: number;
    terrainData: number[];
    objectData: number[];
    tilesets?: Array<{ firstgid: number; source: string }>;
    /** Author-time named tile regions. Persists alongside the map; optional
     *  — omit if the map has none. */
    zones?: Array<{ id: string; name: string; color: string; cells: string[] }>;
    existingMapId?: string;
  }): Promise<{ mapId: string }> {
    const res = await fetch(`${API_URL}/generate/map/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Map save failed: ${res.status}`);
    }
    return res.json() as Promise<{ mapId: string }>;
  }

  /**
   * Compose a full encounter (map + encounter shell) deterministically. No
   * Claude call — the server writes both files directly from the toggles
   * and the optional player description. Returns the new encounterId so
   * the caller can hand the player off to the character-select screen with
   * the new encounter pre-selected.
   *
   * `existingMapId` reuses an already-saved map (e.g. one the user has
   * already accepted via the COMPOSE MAP preview) instead of composing a
   * new one. In that mode the `terrain` / `features` fields are ignored.
   * `startingZonesData` is a flat row-major zone array (1 = player, 2 =
   * ally, 4 = enemy); when omitted the server picks the first passable
   * cell as the lone player zone.
   */
  async composeEncounter(args: {
    existingMapId?: string;
    terrain?: 'grassland' | 'forest' | 'dungeon' | 'tavern';
    features?: Array<'campsites' | 'coastline' | 'path' | 'intersection' | 'buildings' | '3-room' | '5-room'>;
    buildingsCount?: number;
    /** Long-form AIGM scene context (writes to the encounter's `customContext`). */
    aigmContext?: string;
    /** Player-facing card summary (writes to the encounter's `description`). */
    description?: string;
    seed?: number;
    startingZonesData?: number[];
    allyIds?: string[];
    enemyIds?: string[];
    neutralIds?: string[];
    customTitle?: string;
    customIntroduction?: string;
    customObjective?: string;
    completionFlag?: string;
    /** Author-painted triggers: rectangular region + one of the action
     *  templates. Each entry may also carry `extraActions[]` so the
     *  server emits a single EncounterTrigger with multiple consequences. */
    triggers?: RefinerTrigger[];
  }): Promise<{
    mapId: string;
    encounterId: string;
    width: number;
    height: number;
    terrainData: number[];
    objectData: number[];
    name: string;
    description: string;
  }> {
    const res = await fetch(`${API_URL}/generate/encounter/composed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Compose encounter failed: ${res.status}`);
    }
    return res.json() as Promise<{
      mapId: string; encounterId: string;
      width: number; height: number;
      terrainData: number[]; objectData: number[];
      name: string; description: string;
    }>;
  }

  /**
   * Fetch the live encounters list from the server. Used by EncounterSetupScene
   * to refresh the cached registry after a new encounter has been generated.
   */
  async listEncounters(): Promise<unknown[]> {
    const res = await fetch(`${API_URL}/encounters`);
    if (!res.ok) throw new Error(`List encounters failed: ${res.status}`);
    return res.json() as Promise<unknown[]>;
  }

  /** Fetch all authored adventures from the active setting. Used by the
   *  Adventure Creator's LOAD button + by the player-side AdventureSetupScene
   *  refresh path. */
  async listAdventures(): Promise<unknown[]> {
    const res = await fetch(`${API_URL}/adventures`);
    if (!res.ok) throw new Error(`List adventures failed: ${res.status}`);
    return res.json() as Promise<unknown[]>;
  }

  /** Upsert an authored adventure. Body is an `AdventureDef`; the server
   *  writes `<active-setting>/adventures/<id>.json` and reloads defs.
   *  Returns the persisted id. */
  async saveAdventure(adventure: import("../../../shared/types").AdventureDef): Promise<{ adventureId: string }> {
    const res = await fetch(`${API_URL}/adventure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adventure),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Adventure save failed: ${res.status}`);
    }
    return res.json() as Promise<{ adventureId: string }>;
  }

  /** Fetch every NPC the active setting carries. Refresh path for the NPC
   *  Creator's LOAD overlay and for clients that want a fresh registry
   *  without a page reload after a SAVE. */
  async listNpcs(): Promise<unknown[]> {
    const res = await fetch(`${API_URL}/npcs`);
    if (!res.ok) throw new Error(`List NPCs failed: ${res.status}`);
    return res.json() as Promise<unknown[]>;
  }

  /** Fetch the full Token Creator parts library in a single payload — every
   *  slot's full part fragments + a flat catalog of slot → ids. Cached by
   *  the Token Creator scene at boot; subsequent slot picks don't hit the
   *  server again. The fragments still carry `{{COLOR}}` placeholders. */
  async listTokenParts(): Promise<{
    slots: Record<string, Record<string, string>>;
    catalog: Record<string, string[]>;
  }> {
    const res = await fetch(`${API_URL}/tokens/parts`);
    if (!res.ok) throw new Error(`List token parts failed: ${res.status}`);
    return res.json() as Promise<{ slots: Record<string, Record<string, string>>; catalog: Record<string, string[]> }>;
  }

  /** List every token SVG filename in `data/tokens/`. Used by the Token
   *  Creator's LOAD overlay to build its card grid. */
  async listTokens(): Promise<string[]> {
    const res = await fetch(`${API_URL}/tokens`);
    if (!res.ok) throw new Error(`List tokens failed: ${res.status}`);
    return res.json() as Promise<string[]>;
  }

  /** List every author-editable token spec id (filename stem). The LOAD
   *  overlay uses this to distinguish "editable via the Token Creator" from
   *  "legacy hand-authored" tokens. */
  async listTokenSpecs(): Promise<string[]> {
    const res = await fetch(`${API_URL}/token-specs`);
    if (!res.ok) throw new Error(`List token specs failed: ${res.status}`);
    return res.json() as Promise<string[]>;
  }

  /** Fetch a saved spec by id for re-editing in the Token Creator. Returns
   *  null when no spec exists for that id (the SVG may still exist as a
   *  legacy hand-authored token). */
  async loadTokenSpec(id: string): Promise<import("../../../shared/types").TokenSpec | null> {
    const res = await fetch(`${API_URL}/token-specs/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Load token spec failed: ${res.status}`);
    return res.json() as Promise<import("../../../shared/types").TokenSpec>;
  }

  /** Save a token. Server composes the SVG + writes both `data/tokens/<id>.svg`
   *  and the editable spec. Returns the asset path the NPC Creator should
   *  drop into `NPCDef.tokenAsset`. The server rejects with HTTP 409 when a
   *  token with the same id already exists; the caller catches `TokenExistsError`
   *  to prompt the user, then retries with `overwrite: true`. */
  async saveToken(
    spec: import("../../../shared/types").TokenSpec,
    opts: { overwrite?: boolean } = {},
  ): Promise<{ id: string; tokenAsset: string }> {
    const query = opts.overwrite ? "?overwrite=true" : "";
    const res = await fetch(`${API_URL}/token${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new TokenExistsError(body.error ?? "Token already exists");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Token save failed: ${res.status}`);
    }
    return res.json() as Promise<{ id: string; tokenAsset: string }>;
  }

  /** Per-tileset tile legends (one block per tileset) used by the Tile
   *  Creator to render each tileset's frame grid + load existing attributes. */
  async listTileLegends(): Promise<{ tilesets: TileLegendBlock[] }> {
    const res = await fetch(`${API_URL}/tilesets/legends`);
    if (!res.ok) throw new Error(`List tile legends failed: ${res.status}`);
    return res.json() as Promise<{ tilesets: TileLegendBlock[] }>;
  }

  /** Tileset image-slicing metadata (tilewidth/columns/etc.) so the Tile
   *  Creator can crop individual frames from each tileset PNG. */
  async listTilesetMeta(): Promise<TilesetMeta[]> {
    const res = await fetch(`${API_URL}/tilesets`);
    if (!res.ok) throw new Error(`List tilesets failed: ${res.status}`);
    return res.json() as Promise<TilesetMeta[]>;
  }

  /** Create or update a single tile's legend entry. Server writes it into
   *  `<tileset>_legend.json` and reloads defs so the new semantics take
   *  effect on the next session. */
  async saveTileEntry(
    tileset: string,
    gid: number,
    entry: import("../../../shared/types").TileLegendEntry,
  ): Promise<void> {
    const res = await fetch(`${API_URL}/tilesets/${encodeURIComponent(tileset)}/tiles/${gid}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Tile save failed: ${res.status}`);
    }
  }

  /** AIGM tile generation: a description → an SVG image + suggested legend
   *  attributes. The client rasterises the SVG and composites it into the
   *  shared `generated` tileset before calling `saveGeneratedTile`. */
  async generateTile(description: string): Promise<{ svg: string; suggested: import("../../../shared/types").TileLegendEntry }> {
    const res = await fetch(`${API_URL}/tiles/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Tile generation failed: ${res.status}`);
    }
    return res.json() as Promise<{ svg: string; suggested: import("../../../shared/types").TileLegendEntry }>;
  }

  /** Existing generated tiles (gid order) + the sheet's grid metadata. The
   *  client re-rasterises every source SVG to rebuild the spritesheet. */
  async listGeneratedTiles(): Promise<{ tiles: Array<{ gid: number; svg: string; entry: import("../../../shared/types").TileLegendEntry }>; tileSize: number; columns: number }> {
    const res = await fetch(`${API_URL}/tiles/generated`);
    if (!res.ok) throw new Error(`List generated tiles failed: ${res.status}`);
    return res.json() as Promise<{ tiles: Array<{ gid: number; svg: string; entry: import("../../../shared/types").TileLegendEntry }>; tileSize: number; columns: number }>;
  }

  /** Persist a generated tile: its source SVG, legend entry, and the full
   *  re-assembled spritesheet PNG (base64). Returns the assigned gid. */
  async saveGeneratedTile(payload: { svg: string; entry: import("../../../shared/types").TileLegendEntry; pngBase64: string }): Promise<{ gid: number }> {
    const res = await fetch(`${API_URL}/tiles/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Tile save failed: ${res.status}`);
    }
    return res.json() as Promise<{ gid: number }>;
  }

  /** Upsert an authored NPC. Server validates the `monsterClass` against the
   *  monster roster (the engine resolves an NPC's stats by looking up its
   *  monsterClass) and writes `<active-setting>/npcs/<id>.json`. */
  async saveNpc(npc: import("../../../shared/types").NPCDef): Promise<{ npcId: string }> {
    const res = await fetch(`${API_URL}/npc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(npc),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `NPC save failed: ${res.status}`);
    }
    return res.json() as Promise<{ npcId: string }>;
  }

  /** Author-side preview chat for an NPC draft. No session required. */
  async testNpcChat(
    draft: { name: string; monsterClass?: string; factionId?: string; persona: string },
    history: Array<{ role: "user" | "assistant"; content: string }>,
    prompt: string,
  ): Promise<{ reply: string }> {
    const res = await fetch(`${API_URL}/npc/test-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft, history, prompt }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Test chat failed: ${res.status}`);
    }
    return res.json() as Promise<{ reply: string }>;
  }

  /**
   * Update an existing encounter in place — used by `EncounterCreatorScene`.
   * Mirrors `composeEncounter`'s body shape but requires an `encounterId`
   * and skips map composition (the encounter's existing `mapId` is reused
   * unless the caller supplies a new one).
   */
  async updateEncounter(args: {
    encounterId: string;
    mapId?: string;
    /** Long-form AIGM scene context (writes to the encounter's `customContext`). */
    aigmContext?: string;
    /** Player-facing card summary (writes to the encounter's `description`). */
    description?: string;
    startingZonesData?: number[];
    /** Starting-location mode (`'zones'` = random in zones, `'exact'` = per-entity tiles). */
    placementMode?: 'zones' | 'exact';
    /** Per-entity exact-tile bindings (consumed only when `placementMode === 'exact'`). */
    placements?: import("../../../shared/types").EncounterPlacement[];
    allyIds?: string[];
    enemyIds?: string[];
    neutralIds?: string[];
    customTitle?: string;
    customIntroduction?: string;
    customObjective?: string;
    completionFlag?: string;
    triggers?: RefinerTrigger[];
  }): Promise<{ encounterId: string; mapId: string }> {
    const res = await fetch(`${API_URL}/generate/encounter/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Update encounter failed: ${res.status}`);
    }
    return res.json() as Promise<{ encounterId: string; mapId: string }>;
  }

  /**
   * Fetch the live maps list from the server. Used after a fresh map has been
   * generated so the client's registry can pick it up without restarting.
   */
  async listMaps(): Promise<unknown[]> {
    const res = await fetch(`${API_URL}/maps`);
    if (!res.ok) throw new Error(`List maps failed: ${res.status}`);
    return res.json() as Promise<unknown[]>;
  }

  /** Fetch the live factions list from the server. Used by BootScene to seed the registry. */
  async listFactions(): Promise<unknown[]> {
    const res = await fetch(`${API_URL}/factions`);
    if (!res.ok) throw new Error(`List factions failed: ${res.status}`);
    return res.json() as Promise<unknown[]>;
  }

  /**
   * Pause or resume the off-camera world tick. The client posts this whenever
   * input is focused (the GM chat box, mainly) or a blocking overlay opens —
   * the server stops advancing NPC-vs-NPC fights while the player is reading
   * or typing. Idempotent on the server side; safe to spam.
   */
  async setWorldPaused(sessionId: string, paused: boolean): Promise<void> {
    try {
      await fetch(`${API_URL}/game/session/${sessionId}/world-paused`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      });
    } catch {
      // Fire-and-forget — a missed message just delays the next tick by one
      // interval, no need to surface the failure.
    }
  }

  /**
   * Delete every map and encounter in the `gen_*` namespace. Used by the
   * dev-mode button on MapEditorScene so iterating on prompts doesn't
   * accumulate clutter in the maps list.
   */
  async deleteAllGeneratedMaps(): Promise<{ mapsDeleted: number; encountersDeleted: number }> {
    const res = await fetch(`${API_URL}/generate/maps/all`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Delete failed: ${res.status}`);
    }
    return res.json() as Promise<{ mapsDeleted: number; encountersDeleted: number }>;
  }

  /**
   * Promote a generated (`gen_*`) encounter to a stable premade id. The slug
   * defaults to a sanitised version of the encounter title; if omitted the
   * server derives it. Renames the encounter JSON, removes its `generated`
   * flag, and (if it references a `gen_*` map) renames that too.
   */
  async promoteEncounter(encounterId: string, slug?: string): Promise<{ encounterId: string; mapId?: string }> {
    const res = await fetch(`${API_URL}/generate/encounter/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encounterId, slug }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Promote failed: ${res.status}`);
    }
    return res.json() as Promise<{ encounterId: string; mapId?: string }>;
  }

  /**
   * Generate just a map (no encounter wrapper). Returns the map's id and
   * the raw GID arrays so the client can render a preview without an
   * additional round-trip. The map is persisted on disk for future use.
   */
  async generateMap(prompt: string): Promise<{
    mapId: string;
    width: number;
    height: number;
    terrainData: number[];
    objectData: number[];
    name: string;
    description: string;
  }> {
    const res = await fetch(`${API_URL}/generate/map`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Map generation failed: ${res.status}`);
    }
    return res.json() as Promise<{
      mapId: string; width: number; height: number;
      terrainData: number[]; objectData: number[];
      name: string; description: string;
    }>;
  }

  /**
   * Start a session against a freshly-generated encounter. Fetches the
   * encounter JSON from the server's /encounters listing, then calls the
   * standard session-create route with its fields.
   */
  async startGeneratedEncounter(encounterId: string, characterId: string): Promise<{ state: GameState; playerDef: PlayerDef }> {
    const list = await fetch(`${API_URL}/encounters`).then((r) => r.json()) as Array<{
      id: string; encounterTitle: string; mapId: string;
      npcIds?: string[]; allyIds?: string[]; enemyIds?: string[];
      customIntroduction?: string; customContext?: string;
      tileProperties?: unknown[]; startingZones?: unknown;
      objective?: string;
    }>;
    const enc = list.find((e) => e.id === encounterId);
    if (!enc) throw new Error(`Encounter "${encounterId}" not found after generation.`);
    return this.createSession({
      mapType: "saved",
      playerDefId: characterId,
      savedMapId: enc.mapId,
      encounterTitle: enc.encounterTitle,
      npcIds: enc.npcIds,
      allyIds: enc.allyIds,
      enemyIds: enc.enemyIds,
      customIntroduction: enc.customIntroduction,
      customContext: enc.customContext,
      customObjective: enc.objective,
      tileProperties: enc.tileProperties as never,
      startingZones: enc.startingZones as never,
    });
  }

  async startAdventure(characterId: string, adventureId: string): Promise<{ state: GameState; playerDef: PlayerDef }> {
    const res = await fetch(`${API_URL}/adventure/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId, adventureId, devFlags: DevMode.snapshotDevFlags() }),
    });
    if (!res.ok) throw new Error(`Adventure start failed: ${res.status}`);
    const { sessionId, state, playerDef } = await res.json() as { sessionId: string; state: GameState; playerDef: PlayerDef };
    this.sessionId = sessionId;
    state.sessionId = sessionId;
    return { state, playerDef };
  }

  /** Persist the in-progress chapter's cross-chapter state so the adventure can
   *  be resumed from Adventure Setup. Called on LEAVE ADVENTURE before the
   *  session is torn down. Best-effort — a failure must not block leaving. */
  async checkpointAdventure(characterId: string): Promise<void> {
    await fetch(`${API_URL}/adventure/${encodeURIComponent(characterId)}/checkpoint`, { method: 'POST' });
  }

  /**
   * Advance to the next chapter. Returns `{ complete: true }` when the
   * adventure has been finished; otherwise the new chapter's GameState +
   * leveled-up PlayerDef. The caller is responsible for closing the old
   * WebSocket and connecting to the new session (see GameScene's
   * chapter-advance handler).
   */
  async advanceChapter(characterId: string): Promise<{ complete: true } | { complete: false; sessionId: string; state: GameState; playerDef: PlayerDef }> {
    const res = await fetch(`${API_URL}/adventure/${characterId}/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devFlags: DevMode.snapshotDevFlags() }),
    });
    if (!res.ok) throw new Error(`Adventure advance failed: ${res.status}`);
    const body = await res.json() as { complete: boolean; sessionId?: string; state?: GameState; playerDef?: PlayerDef };
    if (body.complete) return { complete: true };
    this.sessionId = body.sessionId!;
    body.state!.sessionId = body.sessionId!;
    return { complete: false, sessionId: body.sessionId!, state: body.state!, playerDef: body.playerDef! };
  }

  /** Boot the adventure's rest-stop interlude session. Used by the
   *  "Visit the rest encounter first?" prompt between chapters. The returned
   *  session's `adventureContext.isRestSession === true`; LEAVE ENCOUNTER from
   *  that session calls `advanceChapter` (which the server detects as
   *  rest-handoff) rather than going back to the setup screen. */
  async startRest(characterId: string): Promise<{ sessionId: string; state: GameState; playerDef: PlayerDef }> {
    const res = await fetch(`${API_URL}/adventure/${characterId}/rest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devFlags: DevMode.snapshotDevFlags() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      throw new Error(body.error ?? `Adventure rest failed: ${res.status}`);
    }
    const body = await res.json() as { sessionId: string; state: GameState; playerDef: PlayerDef };
    this.sessionId = body.sessionId;
    body.state.sessionId = body.sessionId;
    return body;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async generateStorylog(characterId: string, rewrite = false): Promise<StorylogEntry[]> {
    const url = rewrite
      ? `${API_URL}/save/${characterId}/storylog?rewrite=true`
      : `${API_URL}/save/${characterId}/storylog`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`Storylog generation failed: ${res.status}`);
    const { storylog } = await res.json() as { storylog: StorylogEntry[] };
    return storylog;
  }
}

export const gameClient = new GameClient();
