/**
 * The Roadside Cage (The Long Account, ch1). The objective is the RESCUE, not
 * the kill: getting rid of the two bandit slavers by ANY means (bribe, parley,
 * intimidation, or violence) frees the captive elves. The bandits start NEUTRAL
 * and unaware — walking up opens a scripted parley; attacking or casting
 * provokes them. A faction override pins bandits ↔ commoners to neutral so that
 * if it does come to blows the bandits never turn on their own prisoners. These
 * tests read the real data so a future change can't silently re-break the flow.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildFactionRelations, isHostileTo } from './FactionRelations.js';
import type { FactionDef } from '../../../shared/types.js';

const DATA = join(import.meta.dirname, '..', '..', 'data');
const setting = join(DATA, 'settings', 'the_sundered_reach');
const rj = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('The Roadside Cage — free the captives, bandits neutral until provoked', () => {
  const enc = rj(join(setting, 'encounters', 'the_long_account_ch1.json'));
  const factions: FactionDef[] = ['bandits', 'commoners', 'party'].map((id) => rj(join(setting, 'factions', `${id}.json`)));
  const state = { factionRelations: buildFactionRelations(factions, { encounterOverride: enc.factionRelations }), relationships: {} };

  const bandit = { id: 'bandit', factionId: 'bandits' };
  const captive = { id: 'captive_elf', factionId: 'commoners' };
  const player = { id: 'player', factionId: 'party' };

  const trig = (id: string) => enc.triggers.find((t: { id: string }) => t.id === id);
  const hasAction = (t: { then: Array<Record<string, unknown>> }, pred: (a: Record<string, unknown>) => boolean) => t.then.some(pred);

  it('spawns two captive elves and two bandits, all NEUTRAL (no enemies at start)', () => {
    // Bandits live in npcIds (→ neutral disposition) so they don't auto-aggro on
    // proximity; nothing is in enemyIds. Provoke flips them to enemy at runtime.
    expect(enc.enemyIds).toEqual([]);
    expect(enc.npcIds).toEqual(['captive_elf', 'captive_elf', 'bandit', 'bandit']);
  });

  // The player must START CONCEALED so they can choose their approach (sneak,
  // charge, or parley). This loads the real map + tile legend and asserts the
  // authored start is (a) walkable — the original (4,11) was a tree — and
  // (b) has no line of sight to either bandit. Guards against a future edit
  // dropping the player onto an obstacle or into the open clearing.
  it('the player starts on a walkable tile, hidden from both bandits', () => {
    const map = rj(join(setting, 'maps', `${enc.mapId}.json`));
    const legend = rj(join(DATA, 'tilesets', 'scribble_legend.json')).tiles as Record<string, { blocksMovement?: boolean; blocksSight?: boolean }>;
    const W = map.width;
    const terr = map.layers.find((l: { name: string }) => l.name === 'terrain').data as number[];
    const obj = map.layers.find((l: { name: string }) => l.name === 'objects').data as number[];
    const strip = (g: number) => g & 0x1fffffff;
    const prop = (g: number, k: 'blocksMovement' | 'blocksSight') => { const e = legend[String(strip(g))]; return e ? !!e[k] : false; };
    const blocksMove = (x: number, y: number) => prop(terr[y * W + x], 'blocksMovement') || prop(obj[y * W + x], 'blocksMovement');
    const blocksSight = (x: number, y: number) => prop(terr[y * W + x], 'blocksSight') || prop(obj[y * W + x], 'blocksSight');
    // Bresenham LOS skipping both endpoints — mirrors Vision.walkLOS.
    const hasLOS = (ax: number, ay: number, bx: number, by: number): boolean => {
      let x0 = ax, y0 = ay; const dx = Math.abs(bx - ax), dy = Math.abs(by - ay), sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1; let err = dx - dy;
      for (;;) {
        if (!(x0 === ax && y0 === ay) && !(x0 === bx && y0 === by) && blocksSight(x0, y0)) return false;
        if (x0 === bx && y0 === by) return true;
        const e2 = 2 * err; if (e2 > -dy) { err -= dy; x0 += sx; } if (e2 < dx) { err += dx; y0 += sy; }
      }
    };
    const find = (role: string, index?: number) => enc.placements.find((p: { role: string; index?: number }) => p.role === role && (index === undefined || p.index === index));
    const p = find('player');
    expect(blocksMove(p.x, p.y), 'player start must be walkable').toBe(false);
    // Bandits are neutral placements index 2 and 3 (captives are 0 and 1).
    for (const i of [2, 3]) {
      const b = find('neutral', i);
      expect(hasLOS(p.x, p.y, b.x, b.y), `player must be hidden from bandit at neutral[${i}]`).toBe(false);
    }
  });

  it('the bandits are NOT hostile to their captive elves (faction override)', () => {
    expect(isHostileTo(state, bandit, captive)).toBe(false);
    expect(isHostileTo(state, captive, bandit)).toBe(false);
  });

  it('the bandits start NEUTRAL to the player (no faction auto-aggro), hostile only once provoked', () => {
    // The encounter pins bandits↔party to neutral so the faction baseline
    // (bandits → party = -40) can't auto-discover a HIDDEN player via the
    // world-tick's faction-based escalation (`anyHostileToParty`). Without this
    // the bandits "discovered" the player the moment the first world tick ran.
    expect(isHostileTo(state, bandit, player)).toBe(false);
    // Provoking writes an individual -100 link (what `set_disposition enemy`
    // does); that overrides the neutral faction baseline → hostile.
    const provoked = { ...state, relationships: { [bandit.id]: { [player.id]: -100 } } };
    expect(isHostileTo(provoked, bandit, player)).toBe(true);
  });

  // ── The TALK path: a scripted parley the player can open by approaching. ──
  it('gives the bandits the parley conversation and auto-opens it on approach', () => {
    expect(enc.conversationOverrides?.bandit).toBe('bandit_slaver_parley');
    const p = trig('ch1_parley');
    expect(p.when.event).toBe('player_moved');
    expect(p.when.in_area).toBeTruthy();
    // Only while still exploring and before the bandits are dealt with.
    expect(p.if).toContainEqual({ type: 'phase', in: ['exploring'] });
    expect(p.if).toContainEqual({ type: 'flag_unset', name: 'tla_bandits_gone' });
    expect(hasAction(p, (a) => a.type === 'start_conversation' && a.conversationId === 'bandit_slaver_parley')).toBe(true);
  });

  // ── Provoke paths flip the (neutral) bandits to enemy and start the fight. ──
  it('combat_started flips both bandits to enemy and taunts via speech bubbles', () => {
    const c = trig('ch1_combat_start');
    expect(c.when.event).toBe('combat_started');
    expect(hasAction(c, (a) => a.type === 'set_disposition_by_def_id' && a.defId === 'bandit' && a.disposition === 'enemy')).toBe(true);
    const bubbles = c.then.filter((a: { type: string }) => a.type === 'npc_speaks');
    expect(bubbles.length).toBeGreaterThanOrEqual(1);
    expect(bubbles.every((a: { entity?: string }) => a.entity?.startsWith('npc_bandit_'))).toBe(true);
  });

  it('the specific magic line overrides the generic combat taunt (mutually exclusive)', () => {
    // The magic reaction sets `tla_combat_dialog_done`, and the generic
    // combat-start taunt is guarded on that flag being unset — so a fight
    // opened with a spell shows the magic shock line, NOT the generic one.
    const generic = trig('ch1_combat_start');
    const magic = trig('ch1_magic_reaction');
    expect(generic.if).toContainEqual({ type: 'flag_unset', name: 'tla_combat_dialog_done' });
    expect(hasAction(magic, (a) => a.type === 'set_flag' && a.name === 'tla_combat_dialog_done' && a.value === true)).toBe(true);
    // And the flag must be set BEFORE trigger_combat, or the generic taunt
    // would already have fired by the time the guard is checked.
    const order = (t: string) => magic.then.findIndex((a: { type: string }) => a.type === t);
    expect(order('set_flag')).toBeLessThan(order('trigger_combat'));
  });

  it('casting a spell provokes the bandits (set enemy + trigger_combat) with shock bubbles', () => {
    const r = trig('ch1_magic_reaction');
    expect(r.when.event).toBe('spell_cast');
    expect(hasAction(r, (a) => a.type === 'set_disposition_by_def_id' && a.defId === 'bandit' && a.disposition === 'enemy')).toBe(true);
    expect(hasAction(r, (a) => a.type === 'trigger_combat')).toBe(true);
    const bubbles = r.then.filter((a: { type: string }) => a.type === 'npc_speaks');
    expect(bubbles.length).toBeGreaterThanOrEqual(1);
    expect(bubbles.every((a: { entity?: string }) => a.entity?.startsWith('npc_bandit_'))).toBe(true);
  });

  // ── "Bandits gone" is the shared gate, set by EITHER killing them OR parley. ──
  it('killing the last bandit sets tla_bandits_gone (scoped to a bandit death, not auto-freeing)', () => {
    const down = trig('ch1_bandits_down');
    expect(down.when).toEqual({ event: 'npc_killed', defId: 'bandit' });
    expect(down.if).toContainEqual({ type: 'enemies_alive', op: 'eq', count: 0 });
    expect(hasAction(down, (a) => a.type === 'set_flag' && a.name === 'tla_bandits_gone')).toBe(true);
    // It must NOT free the elves here — that's the Help action's job.
    expect(hasAction(down, (a) => a.type === 'set_disposition_by_def_id')).toBe(false);
  });

  it('once the bandits are gone (by any path) the objective switches to freeing the elves', () => {
    const gone = trig('ch1_bandits_gone');
    expect(gone.when).toEqual({ event: 'flag_set', name: 'tla_bandits_gone' });
    expect(hasAction(gone, (a) => a.type === 'set_objective')).toBe(true);
  });

  it('each elf is freed by a Help action on it, gated on the bandits being gone, with a thank-you + warning', () => {
    for (const [tid, freedFlag] of [['captive_elf_1', 'tla_elf1_freed'], ['captive_elf_2', 'tla_elf2_freed']] as const) {
      const t = enc.triggers.find((x: { when: { event: string; targetId?: string } }) => x.when.event === 'help_used' && x.when.targetId === tid);
      expect(t, `free trigger for ${tid}`).toBeTruthy();
      expect(t.if).toContainEqual({ type: 'flag_equals', name: 'tla_bandits_gone', value: true });
      expect(hasAction(t, (a) => a.type === 'set_disposition_by_def_id' && a.defId === tid && a.disposition === 'ally')).toBe(true);
      expect(hasAction(t, (a) => a.type === 'npc_speaks')).toBe(true);
      expect(hasAction(t, (a) => a.type === 'set_flag' && a.name === freedFlag)).toBe(true);
    }
  });

  it('completes only when BOTH elves are freed', () => {
    const both = trig('ch1_both_freed');
    expect(both.if).toContainEqual({ type: 'flag_equals', name: 'tla_elf1_freed', value: true });
    expect(both.if).toContainEqual({ type: 'flag_equals', name: 'tla_elf2_freed', value: true });
    expect(hasAction(both, (a) => a.type === 'set_flag' && a.name === enc.completionFlag)).toBe(true);
  });

  it('does not complete on combat-clear — only the completion flag finishes it', () => {
    // Killing the bandits is one way to get rid of them, not the objective:
    // freeing the elves is. `completeOnFlagOnly` makes the engine ignore
    // combat-clear and wait for `tla_ch1_done` (set by ch1_both_freed).
    expect(enc.completeOnFlagOnly).toBe(true);
  });
});

describe('The Roadside Cage — bandit slaver parley conversation', () => {
  const conv = rj(join(setting, 'conversations', 'bandit_slaver_parley.json'));
  const node = (id: string) => conv.nodes.find((n: { id: string }) => n.id === id);
  const onEnterHas = (id: string, pred: (a: Record<string, unknown>) => boolean) => (node(id)?.onEnter ?? []).some(pred);

  it('every peaceful resolution gets rid of the bandits (set tla_bandits_gone + walk them off)', () => {
    for (const id of ['bought_off', 'talked_down', 'scared_off']) {
      expect(node(id), id).toBeTruthy();
      expect(onEnterHas(id, (a) => a.type === 'set_flag' && a.name === 'tla_bandits_gone' && a.value === true), `${id} sets gone flag`).toBe(true);
      expect(onEnterHas(id, (a) => a.type === 'npc_leaves' && a.defId === 'bandit'), `${id} walks the bandits off the map`).toBe(true);
    }
  });

  it('the hostile branch starts combat (set bandits enemy + trigger_combat)', () => {
    expect(onEnterHas('to_blows', (a) => a.type === 'set_disposition_by_def_id' && a.defId === 'bandit' && a.disposition === 'enemy')).toBe(true);
    expect(onEnterHas('to_blows', (a) => a.type === 'trigger_combat')).toBe(true);
  });

  it('offers bribe / persuasion / intimidation / fight from the opening node', () => {
    const intro = node(conv.startNode);
    const hasCheck = (skill: string) => intro.choices.some((c: { check?: { skill?: string } }) => c.check?.skill === skill);
    expect(hasCheck('persuasion')).toBe(true);
    expect(hasCheck('intimidation')).toBe(true);
    // A bribe (coin) option and a draw-on-them option both route somewhere.
    expect(intro.choices.some((c: { next?: string }) => c.next === 'bought_off')).toBe(true);
    expect(intro.choices.some((c: { next?: string }) => c.next === 'to_blows')).toBe(true);
  });
});
