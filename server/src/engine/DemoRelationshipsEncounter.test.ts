/**
 * Content-integrity test for the `demo_relationships` encounter ("Thieves Fall
 * Out"). Loads the real encounter + NPC + faction JSON from disk and runs them
 * through the same resolution the session builder uses, asserting the authored
 * numbers produce the intended behaviour:
 *   • Karn ↔ Dell — same faction, individual enemies → hostile.
 *   • Mott ↔ Bryn — opposing factions, individual friends → friendly.
 *   • Wess → player — life-debt (seeded by the encounter's trigger) → friendly.
 *   • The other bandits are neutral to the party (bandits↔party override = 0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FactionDef, NpcState } from '../../../shared/types.js';
import { PLAYER_ID, PLAYER_FACTION_ID } from '../../../shared/types.js';
import { buildFactionRelations } from './FactionRelations.js';
import { setIndividualRelation, viewStance, projectDisposition } from './Relationships.js';

const SETTING = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/settings/the_sundered_reach',
);
const readJson = (rel: string) => JSON.parse(readFileSync(join(SETTING, rel), 'utf8'));

describe('demo_relationships encounter', () => {
  const enc = readJson('encounters/demo_relationships.json');
  const npcDefs = enc.npcIds.map((id: string) => readJson(`npcs/${id}.json`));
  const factions: FactionDef[] = ['bandits', 'fortune_guards', 'party'].map((id) =>
    readJson(`factions/${id}.json`),
  );

  // Replicate the session-build resolution: faction matrix (+ encounter
  // override), then individual links from each NPCDef.relations, then the
  // encounter's encounter_started trigger (Wess's life-debt to the player).
  const factionRelations = buildFactionRelations(factions, { encounterOverride: enc.factionRelations });
  const relationships: Record<string, Record<string, number>> = {};
  for (const def of npcDefs) {
    if (def.relations) for (const [b, v] of Object.entries(def.relations)) (relationships[def.id] ??= {})[b] = v as number;
  }
  const state = { factionRelations, relationships, npcs: [] as NpcState[] };
  setIndividualRelation(state, PLAYER_ID, 'demo_rel_wess', 80, { mirror: true }); // the trigger

  const view = (id: string) => ({ id, factionId: npcDefs.find((d: { id: string }) => d.id === id)!.factionId });
  const player = { id: PLAYER_ID, factionId: PLAYER_FACTION_ID };

  it('parses and references resolve (relations point at spawned NPCs)', () => {
    const ids = new Set(npcDefs.map((d: { id: string }) => d.id));
    for (const def of npcDefs) {
      for (const other of Object.keys(def.relations ?? {})) {
        expect(ids.has(other)).toBe(true);
      }
    }
  });

  it('same-faction bandits Karn and Dell are individual enemies', () => {
    expect(view('demo_rel_karn').factionId).toBe('bandits');
    expect(view('demo_rel_dell').factionId).toBe('bandits');
    expect(viewStance(state, view('demo_rel_karn'), view('demo_rel_dell'))).toBe('hostile');
  });

  it('opposing-faction Mott (bandit) and Bryn (Fortune Guard) are individual friends', () => {
    expect(view('demo_rel_mott').factionId).toBe('bandits');
    expect(view('demo_rel_bryn').factionId).toBe('fortune_guards');
    // Faction baseline is hostile…
    expect(viewStance({ ...state, relationships: {} }, view('demo_rel_mott'), view('demo_rel_bryn'))).toBe('hostile');
    // …but the individual +90 links override it.
    expect(viewStance(state, view('demo_rel_mott'), view('demo_rel_bryn'))).toBe('friendly');
  });

  it('Wess is friendly to the player and the other bandits are neutral to the party', () => {
    expect(viewStance(state, view('demo_rel_wess'), player)).toBe('friendly');
    expect(viewStance(state, view('demo_rel_karn'), player)).toBe('neutral');
    expect(viewStance(state, view('demo_rel_dell'), player)).toBe('neutral');
  });

  it('projects Wess and the bandits to non-hostile dispositions toward the party', () => {
    const mk = (id: string): NpcState => ({ id, factionId: view(id).factionId, disposition: 'neutral' } as NpcState);
    expect(projectDisposition(state, mk('demo_rel_wess'))).toBe('neutral'); // friendly but not a companion
    expect(projectDisposition(state, mk('demo_rel_karn'))).toBe('neutral');
  });
});
