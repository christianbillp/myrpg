/**
 * Id helpers for generated quests. The encounter transport keeps the historical
 * `mission_gen_` prefix (so the contract loop, the client TopBar, and the
 * transition endpoint work unchanged). Multi-stage quests address their later
 * encounters with a `#<ordinal>` suffix; stage 0 has no suffix so it doubles as
 * the registry key and `mission_pending` value.
 */
import { randomUUID } from 'crypto';

export const GEN_ENCOUNTER_PREFIX = 'mission_gen_';

export function newQuestIds(): { baseEncounterId: string; questId: string } {
  const uuid = randomUUID();
  return { baseEncounterId: `${GEN_ENCOUNTER_PREFIX}${uuid}`, questId: `quest_gen_${uuid}` };
}

/** The encounter id for stage `ordinal` of a generated quest. Stage 0 is the
 *  bare base id; later stages append `#<ordinal>`. */
export function stageEncounterId(baseId: string, ordinal: number): string {
  return ordinal === 0 ? baseId : `${baseId}#${ordinal}`;
}

/** Split a (possibly suffixed) generated encounter id into its base + stage. */
export function parseStageEncounterId(id: string): { baseId: string; ordinal: number } {
  const hash = id.indexOf('#');
  if (hash < 0) return { baseId: id, ordinal: 0 };
  return { baseId: id.slice(0, hash), ordinal: Number(id.slice(hash + 1)) || 0 };
}

export function isGeneratedEncounterId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith(GEN_ENCOUNTER_PREFIX);
}
