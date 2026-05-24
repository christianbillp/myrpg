import Anthropic from '@anthropic-ai/sdk';
import type { EncounterLogLine } from './sessions.js';

export interface EncounterRecord {
  id: string;
  timestamp: string;
  description: string;
  encounterTitle: string;
  xpGained: number;
  goldGained: number;
  outcome: 'survived' | 'defeated';
  lines: EncounterLogLine[];
}

export interface StorylogEntry {
  encounterId: string;
  narrative: string;
}

const SYSTEM_PROMPT = `You are a fantasy novelist writing a single encounter entry for an adventurer's story log.

You will receive the scene description and the sequence of events from one encounter.

Write exactly one short paragraph of two to three sentences. Write in third person. Weave the scene description naturally into the narrative — do not quote or restate it directly. Include one piece of meaningful dialogue at most (use italics with *asterisks*). Never mention dice rolls, HP numbers, damage numbers, skill names, XP amounts, or gold amounts. Translate mechanical events into narrative: a hit is a blow landed, a kill is a death, Second Wind is finding a reserve of strength. Write as if narrating a fantasy novel, not logging a game session. Do not include headers, titles, or separators — output only the prose.`;

function buildPrompt(record: EncounterRecord): string {
  const events = record.lines.map((l) => {
    if (l.type === 'dm_player') return `  [player] ${l.text}`;
    if (l.type === 'dm_reply') return `  [dungeon master] ${l.text}`;
    return `  [event] ${l.text}`;
  }).join('\n');
  return `Scene: ${record.description}\n\nEvents:\n${events}`;
}

export async function generateStorylog(
  anthropic: Anthropic,
  encounterLog: EncounterRecord[],
  existing: StorylogEntry[],
  rewrite: boolean,
): Promise<StorylogEntry[]> {
  const base = rewrite ? [] : existing;
  const doneIds = new Set(base.map((e) => e.encounterId));
  const toGenerate = [...encounterLog].reverse().filter((r) => !doneIds.has(r.id));

  const newEntries: StorylogEntry[] = [];
  for (const record of toGenerate) {
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(record) }],
    });
    const narrative = res.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    newEntries.push({ encounterId: record.id, narrative });
  }

  return [...base, ...newEntries];
}
