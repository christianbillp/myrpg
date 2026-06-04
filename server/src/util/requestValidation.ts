/**
 * Request-validation helpers shared by the route modules. Two concerns:
 *
 *   1. Path safety — `safeId` gates any user-supplied value that becomes a
 *      filesystem path segment (character id, encounter id, adventure id,
 *      token id, map id). It rejects anything outside a strict slug allowlist
 *      and runs the result through `basename`, so a crafted `../`-style id
 *      can never escape the data directory. Throwing `InvalidPathSegmentError`
 *      lets the global error handler return a 400 rather than a 500.
 *
 *   2. Type safety — `asString` / `asArray` coerce body fields whose runtime
 *      type can't be trusted from the TypeScript signature alone, so a crafted
 *      payload (e.g. `{ prompt: { trim: … } }`) can't crash a handler by
 *      reaching a `.trim()` / `.length` call on a non-string / non-array.
 */
import { basename } from "path";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class InvalidPathSegmentError extends Error {
  constructor(public readonly segment: unknown) {
    const shown = typeof segment === "string" ? JSON.stringify(segment) : typeof segment;
    super(`invalid path segment: ${shown}`);
    this.name = "InvalidPathSegmentError";
  }
}

/**
 * Validate a user-supplied id before it is used to build a filesystem path.
 * Returns the id unchanged when it matches the slug allowlist; throws
 * `InvalidPathSegmentError` otherwise. The `basename` pass is a second line of
 * defence (and is what static analysers recognise as the traversal sanitiser).
 */
export function safeId(id: unknown): string {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new InvalidPathSegmentError(id);
  }
  return basename(id);
}

/** Coerce an unknown request field to a string, falling back to `""` when it
 *  isn't one. Guards `.trim()` / `.match()` calls on untrusted body fields. */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Coerce an unknown request field to an array, falling back to `[]` when it
 *  isn't one. Guards `.length` / `.some()` / `.filter()` calls. */
export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
