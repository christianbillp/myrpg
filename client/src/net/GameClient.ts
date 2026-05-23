import type {
  GameState, GameEvent, PlayerAction, ServerWSMessage, CreateSessionRequest,
} from './types';

const API_URL = 'http://localhost:3000';
const WS_URL  = 'ws://localhost:3000';

export type StateUpdateHandler = (state: GameState, events: GameEvent[]) => void;
export type AIDMReplyHandler   = (reply: string) => void;

interface ChatMessage { role: 'user' | 'assistant'; content: string; }

export class GameClient {
  private sessionId: string | null = null;
  private ws: WebSocket | null = null;
  private onStateUpdate: StateUpdateHandler | null = null;
  private onAIDMReply: AIDMReplyHandler | null = null;

  setStateUpdateHandler(fn: StateUpdateHandler): void { this.onStateUpdate = fn; }
  setAIDMReplyHandler(fn: AIDMReplyHandler): void { this.onAIDMReply = fn; }

  resumeSession(sessionId: string): void { this.sessionId = sessionId; }

  async loadWorld(): Promise<{ sessionId: string; state: GameState } | null> {
    try {
      const res = await fetch(`${API_URL}/world`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      return res.json() as Promise<{ sessionId: string; state: GameState }>;
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
    this.ws = new WebSocket(`${WS_URL}/game/session/${this.sessionId}/ws`);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as ServerWSMessage;
      if (msg.type === 'state_update') {
        this.onStateUpdate?.(msg.state, msg.events);
      } else if (msg.type === 'aidm_reply') {
        this.onAIDMReply?.(msg.reply);
      }
    };
    this.ws.onerror = (e) => console.error('WebSocket error:', e);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    if (this.sessionId) {
      fetch(`${API_URL}/game/session/${this.sessionId}`, { method: 'DELETE' }).catch(() => {});
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
    history: ChatMessage[],
    dmPersona: 'story' | 'dev',
  ): Promise<{ reply: string; rollResults: string[] }> {
    if (!this.sessionId) return { reply: '', rollResults: [] };
    const res = await fetch(`${API_URL}/game/session/${this.sessionId}/aidm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerMessage, history, dmPersona }),
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
}

export const gameClient = new GameClient();
