/**
 * Structured session logging (US-093).
 *
 * Purpose: when a player reports "X went wrong at minute 12", a developer
 * (or Claude Code) should be able to read a single NDJSON file and
 * reconstruct the chain of state changes, decisions, and dice rolls that
 * led to the bug — without re-running the encounter.
 *
 * This is NOT the player-facing Event Log (US-076). The Event Log is
 * curated, in-fiction, and shown to the player. This module captures the
 * full mechanical breadcrumb: every condition flip, every Adv/Disadv
 * source, every AIGM tool call, every save-write.
 *
 * Output:
 *   • Per-session NDJSON at `server/data/logs/<sessionId>.ndjson` —
 *     one structured event per line.
 *   • Single-line human-readable mirror to stdout for live tailing.
 *   • A rolling `latest.ndjson` symlink to the most recent session file.
 *
 * Format of each line:
 *   {"t":"2026-06-01T12:34:56.789Z","ms":12345,"sid":"abc",
 *    "cat":"combat.condition_added","sev":"info","entity":"enemy_A",...}
 *
 *   • `cat` is a dotted category tag (combat.*, ai.*, aigm.*, persist.*,
 *     vision.*, trigger.*, anomaly.*) — designed for grep / jq filtering.
 *   • `sev` is one of `debug | info | warn | error`. Debug events are
 *     silently dropped unless `process.env.MYRPG_LOG_DEBUG === '1'`.
 *   • Payload is open: each call-site decides what fields are relevant.
 *     We deliberately avoid schema enforcement — over-typing kills
 *     adoption when the cost of a new log line should be ~one extra line.
 *
 * Lifecycle: `Logger.bindSession(sessionId)` opens the file (creates the
 * logs dir + rotates old files); `Logger.unbindSession(sessionId)` closes
 * the file handle. Calling `Logger.log(...)` before any session is bound
 * routes to stdout only (no file). Tests run without log files.
 */

import { appendFile, mkdir, readdir, stat, unlink, symlink, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Severity levels. `debug` is dropped unless MYRPG_LOG_DEBUG=1. */
export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';

/** Maximum number of session log files to keep on disk. Tunable via env. */
const MAX_SESSION_LOGS = (() => {
  const raw = process.env.MYRPG_LOG_KEEP;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 50;
})();

const LOG_DIR = join(__dirname, '../data/logs');

const DEBUG_ENABLED = process.env.MYRPG_LOG_DEBUG === '1';

/** Resolve "now" once per call so log lines are consistent. */
function nowIso(): string { return new Date().toISOString(); }

/** Per-session bookkeeping: file path + monotonic timer start. */
interface SessionState {
  path: string;
  startedAtMs: number;
}

const sessionStates = new Map<string, SessionState>();
/** Global default — used by call-sites that don't yet know a session id
 *  (e.g. boot-time `loadDefs`, save load before session install). */
let activeSessionId: string | null = null;

/** Render a single log entry to the one-line stdout format. Compact for grep. */
function renderForStdout(entry: Record<string, unknown>): string {
  const { ms, cat, sev, sid: _sid, t: _t, ...payload } = entry;
  const sevTag = sev === 'info' ? '' : `[${sev}] `;
  const tail = Object.entries(payload).map(([k, v]) => {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${s}`;
  }).filter(Boolean).join(' ');
  return `${ms}ms ${sevTag}${cat} ${tail}`.trimEnd();
}

async function ensureLogDir(): Promise<void> {
  try { await mkdir(LOG_DIR, { recursive: true }); } catch { /* race-safe */ }
}

/** Keep at most MAX_SESSION_LOGS files in LOG_DIR. Deletes the oldest by mtime. */
async function rotateOldLogs(): Promise<void> {
  let entries: string[];
  try { entries = await readdir(LOG_DIR); } catch { return; }
  const ndjson = entries.filter((f) => f.endsWith('.ndjson') && f !== 'latest.ndjson');
  if (ndjson.length <= MAX_SESSION_LOGS) return;
  const stamped = await Promise.all(ndjson.map(async (name) => {
    try {
      const st = await stat(join(LOG_DIR, name));
      return { name, mtime: st.mtimeMs };
    } catch { return { name, mtime: 0 }; }
  }));
  stamped.sort((a, b) => a.mtime - b.mtime);
  const drop = stamped.slice(0, stamped.length - MAX_SESSION_LOGS);
  await Promise.all(drop.map((d) => unlink(join(LOG_DIR, d.name)).catch(() => {})));
}

/** Update / create the `latest.ndjson` symlink pointing at the most recent file. */
async function refreshLatestSymlink(targetFile: string): Promise<void> {
  const link = join(LOG_DIR, 'latest.ndjson');
  try { await rm(link, { force: true }); } catch { /* ignore */ }
  try { await symlink(targetFile, link); } catch {
    // Symlinks not supported (Windows without privileges) — silent.
  }
}

export const Logger = {
  /**
   * Register a session for structured logging. Creates the logs directory,
   * rotates old files past the keep limit, opens the per-session NDJSON
   * file, and points `latest.ndjson` at it. Subsequent `log()` calls
   * without an explicit `sid` route here.
   */
  async bindSession(sessionId: string): Promise<void> {
    await ensureLogDir();
    await rotateOldLogs();
    const fileName = `${sessionId}.ndjson`;
    const path = join(LOG_DIR, fileName);
    sessionStates.set(sessionId, { path, startedAtMs: Date.now() });
    activeSessionId = sessionId;
    await refreshLatestSymlink(fileName);
    this.log('session.bound', { sessionId }, 'info');
  },

  /** Release the per-session file handle. Idempotent. */
  unbindSession(sessionId: string): void {
    if (!sessionStates.has(sessionId)) return;
    this.log('session.unbound', { sessionId }, 'info');
    sessionStates.delete(sessionId);
    if (activeSessionId === sessionId) activeSessionId = null;
  },

  /**
   * Append one structured event. Synchronous from the caller's POV; the
   * file write is fire-and-forget (we never want a log error to crash the
   * server). `payload` is merged into the line as-is — call-sites pick
   * what fields are relevant; there's no schema.
   *
   * `sid` is normally derived from the active session. Override only
   * when logging from a code path that touches multiple sessions or runs
   * before any session is bound (e.g. boot, save load).
   */
  log(category: string, payload: Record<string, unknown> = {}, severity: LogSeverity = 'info', sid?: string): void {
    if (severity === 'debug' && !DEBUG_ENABLED) return;
    const effectiveSid = sid ?? activeSessionId ?? null;
    const state = effectiveSid ? sessionStates.get(effectiveSid) : undefined;
    const ms = state ? Date.now() - state.startedAtMs : 0;
    const entry: Record<string, unknown> = {
      t: nowIso(),
      ms,
      sid: effectiveSid,
      cat: category,
      sev: severity,
      ...payload,
    };
    // Always mirror to stdout for live tailing — single line, no JSON
    // newlines, no excessive whitespace.
    const line = renderForStdout(entry);
    if (severity === 'error') console.error(line);
    else if (severity === 'warn') console.warn(line);
    else console.log(line);
    // Persist to NDJSON when a session file is open. We don't await — log
    // I/O must never block the request path. Errors are swallowed; the
    // stdout copy is the safety net.
    if (state) {
      const ndjson = JSON.stringify(entry) + '\n';
      appendFile(state.path, ndjson).catch(() => { /* swallow */ });
    }
  },

  /** Convenience: warn-level shorthand. */
  warn(category: string, payload: Record<string, unknown> = {}, sid?: string): void {
    this.log(category, payload, 'warn', sid);
  },

  /** Convenience: error-level shorthand. */
  error(category: string, payload: Record<string, unknown> = {}, sid?: string): void {
    this.log(category, payload, 'error', sid);
  },

  /** Convenience: debug-level shorthand (dropped unless MYRPG_LOG_DEBUG=1). */
  debug(category: string, payload: Record<string, unknown> = {}, sid?: string): void {
    this.log(category, payload, 'debug', sid);
  },
};
