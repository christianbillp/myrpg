/**
 * ServerConfig — persistent server-wide configuration written to disk so
 * choices made via the Configuration page survive restarts. Currently holds
 * the player's selected setting id; future game-wide options live here too.
 *
 * Stored at `<DATA_DIR>/server_config.json`. Missing file is treated as an
 * empty config — startup uses fallback defaults.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { DevFlags } from '../../shared/types.js';

export interface ServerConfig {
  /** Player-selected active setting id. Null when the player has not chosen;
   *  the settings loader then falls back to env var → first non-default → default. */
  activeSettingId?: string | null;
  /** Persistent Development Mode toggles set via the Configuration scene.
   *  Survives server restarts. Merged with any client-sent `devFlags` at
   *  session creation — the file is the source of truth across browsers, the
   *  client copy in localStorage is a per-browser cache for UI display. */
  devFlags?: DevFlags;
}

const CONFIG_FILE = 'server_config.json';

export async function loadServerConfig(dataDir: string): Promise<ServerConfig> {
  try {
    const raw = await readFile(join(dataDir, CONFIG_FILE), 'utf-8');
    return JSON.parse(raw) as ServerConfig;
  } catch {
    return {};
  }
}

export async function saveServerConfig(dataDir: string, config: ServerConfig): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, CONFIG_FILE), JSON.stringify(config, null, 2));
}
