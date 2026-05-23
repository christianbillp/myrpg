import type { WebSocket } from '@fastify/websocket';
import { GameEngine } from './engine/GameEngine.js';
import type { ServerWSMessage, GameEvent, GameState } from './engine/types.js';

export interface AidmMessage { role: 'user' | 'assistant'; content: string; }

interface Session {
  engine: GameEngine;
  ws: WebSocket | null;
  aidmHistory: AidmMessage[];
}

const sessions = new Map<string, Session>();

export function createSession(sessionId: string, engine: GameEngine): void {
  sessions.set(sessionId, { engine, ws: null, aidmHistory: [] });
}

export function getAidmHistory(sessionId: string): AidmMessage[] | undefined {
  return sessions.get(sessionId)?.aidmHistory;
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
