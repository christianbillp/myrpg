import type { WebSocket } from '@fastify/websocket';
import { GameEngine } from './engine/GameEngine.js';
import type { ServerWSMessage, GameEvent, GameState } from './engine/types.js';

export interface AigmMessage { role: 'user' | 'assistant'; content: string; }

export interface EncounterLogLine {
  type: 'combat' | 'dm_player' | 'dm_reply';
  text: string;
}

interface AdventureMeta {
  timestamp: string;
  description: string;
  encounterTitle: string;
  xpStart: number;
  goldStart: number;
}

interface Session {
  engine: GameEngine;
  ws: WebSocket | null;
  aigmHistory: AigmMessage[];
  aigmArchive: AigmMessage[];   // full history (pre-summarization); for the memory tool
  adventureLines: EncounterLogLine[];
  adventureMeta: AdventureMeta;
  aigmBusy: boolean;             // simple mutex flag
}

const sessions = new Map<string, Session>();

export function createSession(sessionId: string, engine: GameEngine): void {
  const s = engine.getState();
  sessions.set(sessionId, {
    engine,
    ws: null,
    aigmHistory: [],
    aigmArchive: [],
    adventureLines: [],
    adventureMeta: {
      timestamp: new Date().toISOString(),
      description: s.introduction,
      encounterTitle: s.encounterTitle,
      xpStart: s.player.xp,
      goldStart: s.player.gold,
    },
    aigmBusy: false,
  });
}

export function getAigmArchive(sessionId: string): AigmMessage[] | undefined {
  return sessions.get(sessionId)?.aigmArchive;
}

/**
 * Acquire the per-session AIGM mutex. Returns true if acquired (caller must
 * call releaseAigmLock when done), false if another request is already running.
 */
export function tryAcquireAigmLock(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.aigmBusy) return false;
  session.aigmBusy = true;
  return true;
}

export function releaseAigmLock(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) session.aigmBusy = false;
}

export function pushAdventureLines(sessionId: string, lines: EncounterLogLine[]): void {
  const session = sessions.get(sessionId);
  if (session && lines.length > 0) session.adventureLines.push(...lines);
}

export function getAdventureData(sessionId: string): { meta: AdventureMeta; lines: EncounterLogLine[]; state: GameState } | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  return { meta: session.adventureMeta, lines: session.adventureLines, state: session.engine.getState() };
}

export function getAigmHistory(sessionId: string): AigmMessage[] | undefined {
  return sessions.get(sessionId)?.aigmHistory;
}

export function setAigmHistory(sessionId: string, history: AigmMessage[]): void {
  const session = sessions.get(sessionId);
  if (session) session.aigmHistory = history;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/** Returns the first session belonging to the given character, or undefined. The current server hosts one active session at a time per process, so this is effectively "the active session for this character." */
export function findSessionByCharacter(characterId: string): { sessionId: string; session: Session } | undefined {
  for (const [sessionId, session] of sessions) {
    if (session.engine.getState().player.defId === characterId) return { sessionId, session };
  }
  return undefined;
}

export function getEngine(sessionId: string): GameEngine | undefined {
  return sessions.get(sessionId)?.engine;
}

export function registerWebSocket(sessionId: string, ws: WebSocket): void {
  const session = sessions.get(sessionId);
  if (session) session.ws = ws;
}

export function push(sessionId: string, message: ServerWSMessage): void {
  const session = sessions.get(sessionId);
  if (!session?.ws) return;
  try {
    session.ws.send(JSON.stringify(message));
  } catch {
    // Connection may be closed
  }
}

export function pushStateUpdate(sessionId: string, events: GameEvent[], state: GameState): void {
  push(sessionId, { type: 'state_update', events, state });
}

export function deleteSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session?.ws) { try { session.ws.close(); } catch { /* ignore */ } }
  sessions.delete(sessionId);
}
