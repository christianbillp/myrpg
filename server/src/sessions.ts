import type { WebSocket } from '@fastify/websocket';
import { GameEngine } from './engine/GameEngine.js';
import type { ServerWSMessage, GameEvent, GameState } from './engine/types.js';

export interface AidmMessage { role: 'user' | 'assistant'; content: string; }

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
  aidmHistory: AidmMessage[];
  adventureLines: EncounterLogLine[];
  adventureMeta: AdventureMeta;
}

const sessions = new Map<string, Session>();

export function createSession(sessionId: string, engine: GameEngine): void {
  const s = engine.getState();
  sessions.set(sessionId, {
    engine,
    ws: null,
    aidmHistory: [],
    adventureLines: [],
    adventureMeta: {
      timestamp: new Date().toISOString(),
      description: s.introduction,
      encounterTitle: s.encounterTitle,
      xpStart: s.player.xp,
      goldStart: s.player.gold,
    },
  });
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

export function getAidmHistory(sessionId: string): AidmMessage[] | undefined {
  return sessions.get(sessionId)?.aidmHistory;
}

export function setAidmHistory(sessionId: string, history: AidmMessage[]): void {
  const session = sessions.get(sessionId);
  if (session) session.aidmHistory = history;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
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
