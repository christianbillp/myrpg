import type {
  GameState, GameEvent, PlayerAction, ServerWSMessage, CreateSessionRequest, StorylogEntry,
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
