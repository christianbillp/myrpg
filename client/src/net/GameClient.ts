import type {
  GameState, GameEvent, PlayerAction, ServerWSMessage, CreateSessionRequest, StorylogEntry, AdventureSave,
} from './types';

const API_URL = 'http://localhost:3000';
const WS_URL  = 'ws://localhost:3000';

export type StateUpdateHandler = (state: GameState, events: GameEvent[]) => void;
export type AIDMReplyHandler   = (reply: string) => void;

// Streaming AIDM handlers — fed by aidm_start / aidm_chunk /
// aidm_speculative_discard / aidm_done WebSocket messages.
export interface AIDMStreamHandlers {
  onStart?: () => void;
  onChunk?: (text: string) => void;
  onCheckpoint?: () => void;
  onSpeculativeDiscard?: () => void;
  onDone?: (reply: string, rollResults: string[]) => void;
}


export class GameClient {
  private sessionId: string | null = null;
  private ws: WebSocket | null = null;
  private onStateUpdate: StateUpdateHandler | null = null;
  private onAIDMReply: AIDMReplyHandler | null = null;
  private aidmStreamHandlers: AIDMStreamHandlers | null = null;
  private onDisconnect: (() => void) | null = null;
  private intentionalClose = false;

  setStateUpdateHandler(fn: StateUpdateHandler): void { this.onStateUpdate = fn; }
  setAIDMReplyHandler(fn: AIDMReplyHandler): void { this.onAIDMReply = fn; }
  setAIDMStreamHandlers(handlers: AIDMStreamHandlers): void { this.aidmStreamHandlers = handlers; }
  setDisconnectHandler(fn: () => void): void { this.onDisconnect = fn; }

  resumeSession(sessionId: string): void { this.sessionId = sessionId; }

  async loadWorld(): Promise<{ sessionId: string; state: GameState; dmHistory: { role: 'user' | 'assistant'; content: string }[] } | null> {
    try {
      const res = await fetch(`${API_URL}/world`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return res.json() as Promise<{ sessionId: string; state: GameState; dmHistory: { role: 'user' | 'assistant'; content: string }[] }>;
    } catch {
      return null;
    }
  }

  async createSession(req: CreateSessionRequest): Promise<GameState> {
    const res = await fetch(`${API_URL}/game/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const { sessionId, state } = await res.json() as { sessionId: string; state: GameState };
    this.sessionId = sessionId;
    return state;
  }

  connectWebSocket(): void {
    if (!this.sessionId) { console.error('connectWebSocket: no sessionId'); return; }
    this.intentionalClose = false;
    this.ws = new WebSocket(`${WS_URL}/game/session/${this.sessionId}/ws`);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as ServerWSMessage;
      if (msg.type === 'state_update') {
        this.onStateUpdate?.(msg.state, msg.events);
      } else if (msg.type === 'aidm_reply') {
        this.onAIDMReply?.(msg.reply);
      } else if (msg.type === 'aidm_start') {
        this.aidmStreamHandlers?.onStart?.();
      } else if (msg.type === 'aidm_chunk') {
        this.aidmStreamHandlers?.onChunk?.(msg.text);
      } else if (msg.type === 'aidm_checkpoint') {
        this.aidmStreamHandlers?.onCheckpoint?.();
      } else if (msg.type === 'aidm_speculative_discard') {
        this.aidmStreamHandlers?.onSpeculativeDiscard?.();
      } else if (msg.type === 'aidm_done') {
        this.aidmStreamHandlers?.onDone?.(msg.reply, msg.rollResults);
      }
    };
    this.ws.onerror = (e) => console.error('WebSocket error:', e);
    this.ws.onclose = () => {
      if (!this.intentionalClose) this.onDisconnect?.();
    };
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.ws?.close();
    this.ws = null;
    if (this.sessionId) {
      await fetch(`${API_URL}/game/session/${this.sessionId}`, { method: 'DELETE' }).catch(() => {});
      this.sessionId = null;
    }
  }

  /** Close the local WebSocket without deleting the server-side session. Used when transitioning between chapter sessions in adventure mode. */
  closeWebSocket(): void {
    this.intentionalClose = true;
    this.ws?.close();
    this.ws = null;
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

  async sendAIDMMessage(
    playerMessage: string,
    dmPersona: 'story' | 'dev',
  ): Promise<{ reply: string; rollResults: string[] }> {
    if (!this.sessionId) return { reply: '', rollResults: [] };
    const res = await fetch(`${API_URL}/game/session/${this.sessionId}/aidm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerMessage, dmPersona }),
    });
    if (!res.ok) throw new Error(`AIDM request failed: ${res.status}`);
    const { reply, rollResults } = await res.json() as { reply: string; rollResults: string[] };
    // State update (if AIDM used tools) arrives via WebSocket
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
    encounterTypes?: string[];
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
   * Compose a map deterministically from terrain + features toggles. Used
   * when the player has set any of the map-style toggles on
   * `GenerateSetupScene` — bypasses Claude entirely and returns a map built
   * by the rule-based composer in `engine/MapComposer.ts`.
   */
  async composeMap(args: {
    terrain: 'grassland' | 'forest';
    features: Array<'ruins' | 'buildings' | 'campsites' | 'path'>;
    seed?: number;
  }): Promise<{
    mapId: string;
    width: number;
    height: number;
    terrainData: number[];
    objectData: number[];
    name: string;
    description: string;
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
      mapId: string; width: number; height: number;
      terrainData: number[]; objectData: number[];
      name: string; description: string;
    }>;
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
    terrain?: 'grassland' | 'forest';
    features?: Array<'ruins' | 'buildings' | 'campsites' | 'path'>;
    encounterTypes?: string[];
    description?: string;
    seed?: number;
    startingZonesData?: number[];
    allyIds?: string[];
    enemyIds?: string[];
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

  /**
   * Fetch the live maps list from the server. Used after a fresh map has been
   * generated so the client's registry can pick it up without restarting.
   */
  async listMaps(): Promise<unknown[]> {
    const res = await fetch(`${API_URL}/maps`);
    if (!res.ok) throw new Error(`List maps failed: ${res.status}`);
    return res.json() as Promise<unknown[]>;
  }

  /**
   * Delete every map and encounter in the `gen_*` namespace. Used by the
   * dev-mode button on GenerateSetupScene so iterating on prompts doesn't
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
  async startGeneratedEncounter(encounterId: string, characterId: string): Promise<GameState> {
    const list = await fetch(`${API_URL}/encounters`).then((r) => r.json()) as Array<{
      id: string; encounterTitle: string; encounterTypes: string[]; mapId: string;
      npcIds?: string[]; allyIds?: string[]; enemyIds?: string[];
      customIntroduction?: string; customContext?: string;
      tileProperties?: unknown[]; startingZones?: unknown;
      objective?: string;
    }>;
    const enc = list.find((e) => e.id === encounterId);
    if (!enc) throw new Error(`Encounter "${encounterId}" not found after generation.`);
    return this.createSession({
      encounterTypes: enc.encounterTypes as never,
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

  async startAdventure(characterId: string, adventureId: string): Promise<GameState> {
    const res = await fetch(`${API_URL}/adventure/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId, adventureId }),
    });
    if (!res.ok) throw new Error(`Adventure start failed: ${res.status}`);
    const { sessionId, state } = await res.json() as { sessionId: string; state: GameState };
    this.sessionId = sessionId;
    state.sessionId = sessionId;
    return state;
  }

  /**
   * Advance to the next chapter. Returns `{ complete: true }` when the
   * adventure has been finished; otherwise the new chapter's GameState. The
   * caller is responsible for closing the old WebSocket and connecting to
   * the new session (see GameScene's chapter-advance handler).
   */
  async advanceChapter(characterId: string): Promise<{ complete: true } | { complete: false; sessionId: string; state: GameState }> {
    const res = await fetch(`${API_URL}/adventure/${characterId}/advance`, { method: 'POST' });
    if (!res.ok) throw new Error(`Adventure advance failed: ${res.status}`);
    const body = await res.json() as { complete: boolean; sessionId?: string; state?: GameState };
    if (body.complete) return { complete: true };
    this.sessionId = body.sessionId!;
    body.state!.sessionId = body.sessionId!;
    return { complete: false, sessionId: body.sessionId!, state: body.state! };
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
