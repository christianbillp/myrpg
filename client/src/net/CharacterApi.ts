/**
 * Character & save REST calls — stateless helpers split out of the
 * GameClient god-class; GameClient re-exposes them as instance fields so
 * every existing call site keeps working.
 */
import type { GameState, PlayerDef, StorylogEntry, AdventureSave } from '../../../shared/types';
import { API_URL } from './apiBase';

/** Character creation (US-122): build + persist a new character from choices.
 *  Returns the created PlayerDef, or throws with the server's error message. */
export async function createCharacter(choices: unknown): Promise<PlayerDef> {
  const res = await fetch(`${API_URL}/characters`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(choices),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Failed to create character: ${res.status}`);
  }
  const { playerDef } = await res.json() as { playerDef: PlayerDef };
  return playerDef;
}

/** AI character-concept assist (US-122): suggest a setting-consistent
 *  character from a free-text concept + any locked species/background/class. */
export async function suggestCharacter(req: { prompt: string; classId?: string; speciesId?: string; backgroundId?: string }): Promise<{
  name: string; shortDescription: string; description: string;
  speciesId: string; backgroundId: string; classId: string;
  abilityPriority: string[];
  skillProficiencies?: string[]; languages?: string[]; cantrips?: string[]; preparedSpells?: string[];
  rationale: string;
}> {
  const res = await fetch(`${API_URL}/generate/character`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `AI assist failed: ${res.status}`);
  }
  return await res.json();
}

/** Generate identity text (name / tagline / backstory) for an in-progress
 *  character build (US-122 Review step). `fields` selects which to produce. */
export async function generateCharacterIdentity(req: {
  speciesId: string; backgroundId: string; classId: string;
  fields: Array<"name" | "shortDescription" | "description">;
  current?: { name?: string; shortDescription?: string; description?: string };
  topAbilities?: string[]; skills?: string[]; languages?: string[];
}): Promise<{ name?: string; shortDescription?: string; description?: string }> {
  const res = await fetch(`${API_URL}/generate/character/identity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Identity generation failed: ${res.status}`);
  }
  return await res.json();
}

/** Re-fetch the character roster (after creating one) so the setup scene can
 *  refresh its carousel. */
export async function fetchCharacters(): Promise<PlayerDef[]> {
  const res = await fetch(`${API_URL}/characters`);
  if (!res.ok) throw new Error(`Failed to fetch characters: ${res.status}`);
  return await res.json() as PlayerDef[];
}

/** Permanently delete a character definition from the active setting's
 *  roster. The session save is removed separately via `deleteSave`. */
export async function deleteCharacter(characterId: string): Promise<void> {
  const res = await fetch(`${API_URL}/characters/${characterId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete character: ${res.status}`);
}

// Save / delete (kept for the setup screen)
export async function loadSave(characterId: string): Promise<unknown> {
  const res = await fetch(`${API_URL}/save/${characterId}`);
  return res.ok ? res.json() : null;
}

export async function deleteSave(characterId: string): Promise<void> {
  await fetch(`${API_URL}/save/${characterId}`, { method: 'DELETE' });
}

export async function loadAdventureSave(characterId: string): Promise<AdventureSave | null> {
  const res = await fetch(`${API_URL}/adventure/${characterId}`);
  if (!res.ok) return null;
  const body = await res.json();
  return body && typeof body === 'object' && 'adventureId' in body ? (body as AdventureSave) : null;
}

export async function deleteAdventureSave(characterId: string): Promise<void> {
  await fetch(`${API_URL}/adventure/${characterId}`, { method: 'DELETE' });
}
