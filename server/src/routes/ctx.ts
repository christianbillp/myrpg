/**
 * Shared context every route module receives. Holds live references and
 * mutators for the server-wide state index.ts owns: the loaded `GameDefs`,
 * cached config, the data dir, helpers tied to the active setting, and the
 * Anthropic client.
 *
 * Routes that need additional state (e.g. session helpers) import the
 * session module directly — there's no need to surface them on `AppCtx`
 * since those helpers are module-level functions in their own right.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { GameDefs } from "../engine/types.js";
import type { DevFlags } from "../../../shared/types.js";

export interface AppCtx {
  anthropic: Anthropic;
  /** Absolute path to `server/data`. */
  dataDir: string;
  /** Live reference to the loaded defs. Read on every request so freshly-
   *  loaded JSON is visible without re-registering routes. */
  getDefs(): GameDefs;
  /** Re-read every JSON-backed def from disk. Awaited after any file write. */
  loadDefs(): Promise<void>;
  /** In-memory mirror of `server_config.disabledTiles`. Get-with-fallback
   *  getter; setter is exposed so the `/server-config` PUT refreshes it. */
  getDisabledTiles(): Record<string, number[]>;
  setDisabledTiles(value: Record<string, number[]>): void;
  /** Resolve a sub-folder under the active setting's data directory.
   *  Returns null when no setting is active. */
  settingSubDir(sub: string): string | null;
  /** Merge file + client dev flags into the effective set. */
  resolveDevFlags(client: DevFlags | undefined): Promise<DevFlags | undefined>;
}
