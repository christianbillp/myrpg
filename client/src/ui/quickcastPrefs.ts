/**
 * Quickcast preferences — the per-character set of spell ids the player added to
 * the Player Panel's quickcast menu (opened by the CAST button). Spells are
 * added/removed from the Character Sheet's Spells tab. Stored in localStorage,
 * keyed by character id (mirrors the other per-client UI prefs).
 */
const KEY = (characterId: string): string => `myrpg_quickcast_${characterId}`;

export function readQuickcast(characterId: string): string[] {
  try {
    const raw = localStorage.getItem(KEY(characterId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeQuickcast(characterId: string, ids: string[]): void {
  if (ids.length === 0) localStorage.removeItem(KEY(characterId));
  else localStorage.setItem(KEY(characterId), JSON.stringify(ids));
}

export function isQuickcast(characterId: string, spellId: string): boolean {
  return readQuickcast(characterId).includes(spellId);
}

/** Add/remove a spell from the character's quickcast menu. Returns the new state. */
export function toggleQuickcast(characterId: string, spellId: string): boolean {
  const ids = readQuickcast(characterId);
  const i = ids.indexOf(spellId);
  if (i >= 0) { ids.splice(i, 1); writeQuickcast(characterId, ids); return false; }
  ids.push(spellId);
  writeQuickcast(characterId, ids);
  return true;
}
