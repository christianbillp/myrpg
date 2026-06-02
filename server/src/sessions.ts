import type { WebSocket } from '@fastify/websocket';
import { GameEngine } from './engine/GameEngine.js';
import type { ServerWSMessage, GameEvent, GameState } from './engine/types.js';
import { Logger } from './Logger.js';

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
  /** Coin purse balance in CP at the moment the session was created.
   *  Used by the encounter-finish flow to compute net coin delta. */
  balanceCpStart: number;
}

interface Session {
  engine: GameEngine;
  ws: WebSocket | null;
  aigmHistory: AigmMessage[];
  aigmArchive: AigmMessage[];   // full history (pre-summarization); for the memory tool
  adventureLines: EncounterLogLine[];
  adventureMeta: AdventureMeta;
  aigmBusy: boolean;             // simple mutex flag
  /**
   * Off-camera world tick state (Pass 3c). When `false` and the engine is
   * in `exploring` phase, the per-session interval fires every 6 s and runs
   * one round of NPC-vs-NPC combat for every hostile pair on the map. Set
   * true by the client whenever the player is typing into the GM chat box
   * or has a blocking overlay open — typing time should never affect the
   * world clock.
   */
  worldPaused: boolean;
  worldTickHandle: NodeJS.Timeout | null;
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
      balanceCpStart: s.player.balanceCp,
    },
    aigmBusy: false,
    worldPaused: false,
    worldTickHandle: null,
  });
  // US-093: open the per-session structured log file. Fire-and-forget;
  // the binding is async (mkdir + rotation), so we don't block the
  // request path on it. Subsequent `Logger.log` calls before binding
  // completes still land in stdout (the per-file fallback is graceful).
  void Logger.bindSession(sessionId).then(() => {
    Logger.log('session.created', {
      sessionId,
      encounterTitle: s.encounterTitle,
      playerDef: s.player.defId,
      hp: s.player.hp,
      xp: s.player.xp,
      phase: s.phase,
      npcCount: s.npcs.length,
    });
  });
}

/** Toggle the per-session pause flag. Surfaced via `POST /game/session/:id/world-paused`.
 *  Returns the previous value so callers can detect transitions (in particular
 *  paused→unpaused, which triggers the deferred first-turn advance for
 *  combat that started during `encounter_started`). */
export function setWorldPaused(sessionId: string, paused: boolean): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  const previous = session.worldPaused;
  session.worldPaused = paused;
  return previous;
}

/** True iff the off-camera tick is allowed to run this moment. */
export function isWorldTickEligible(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.worldPaused) return false;
  const s = session.engine.getState();
  // Off-camera tick only runs in exploration; combat already drives initiative.
  if (s.phase !== 'exploring') return false;
  // A pending reaction prompt suspends everything — don't tick under the user's feet.
  if (s.pendingReaction !== null) return false;
  return true;
}

/** Per-session interval registration. Cleared on `deleteSession`. */
export function setWorldTickHandle(sessionId: string, handle: NodeJS.Timeout | null): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.worldTickHandle) clearInterval(session.worldTickHandle);
  session.worldTickHandle = handle;
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
  if (session?.worldTickHandle) clearInterval(session.worldTickHandle);
  if (session?.ws) { try { session.ws.close(); } catch { /* ignore */ } }
  sessions.delete(sessionId);
  Logger.log('session.deleted', { sessionId }, 'info', sessionId);
  Logger.unbindSession(sessionId);
}
