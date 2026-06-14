/**
 * Ambient NPC-to-NPC banter (US-129).
 *
 * Each world tick (exploration only — the whole sim is combat-gated upstream)
 * this:
 *   1. ADVANCES every in-flight exchange one line, dropping any whose speakers
 *      are no longer eligible (separated, alerted, downed).
 *   2. With a small per-tick chance, STARTS a new exchange between two idle,
 *      calm, mutually-visible NPCs the player can witness.
 *
 * Determinism: every random choice draws from the tick's seeded `SimRng`
 * (keyed by tickId + a fixed "banter" salt id), never `Math.random`. Same
 * world state + tick id → same banter.
 *
 * Surfacing: lines emit through the same `npc_speech` event + Event Log line
 * that directed speech uses, but with the dimmed `ambient` log style so they
 * read as overheard background chatter.
 */
import type { GameContext } from '../GameContext.js';
import type { NpcState, GameEvent } from '../types.js';
import type { BanterPack, ActiveBanter, BanterRelation } from '../../../../shared/types.js';
import { SimRng } from './SimRng.js';
import { canSee } from '../Vision.js';
import { viewStance } from '../Relationships.js';

/** How far apart two NPCs may be and still strike up a chat (tiles). */
const CHAT_RADIUS_TILES = 3;
/** The player must be within this many tiles of a speaker to witness (and thus
 *  trigger) an exchange — keeps off-screen chatter out of the log. */
const EARSHOT_TILES = 8;
/** Per-tick probability the sim tries to open ONE new exchange. Sparse on
 *  purpose: ambience, not a talk-show. */
const START_CHANCE = 0.25;
/** Ticks an NPC must wait after finishing an exchange before bantering again. */
const COOLDOWN_TICKS = 12;
/** Cap on the OVERHEARD lines surfaced to the AIGM. */
const RECENT_LINES_CAP = 6;

function chebyshev(a: { tileX: number; tileY: number }, b: { tileX: number; tileY: number }): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

/** A creature that can take part in idle banter: alive, calm, not engaged, not
 *  a busy companion, not concealed. */
function isChatEligible(npc: NpcState): boolean {
  if (npc.hp <= 0) return false;
  if ((npc.alertness ?? 'calm') !== 'calm') return false;
  if (npc.conditions.includes('hidden') || npc.conditions.includes('incapacitated') || npc.conditions.includes('unconscious')) return false;
  // A companion mid-task (moving to a command) shouldn't stop to gossip.
  if (npc.companion?.override && npc.companion.override.kind !== 'wait') return false;
  return true;
}

/** Stance between two NPCs as a banter relation. */
function relationBetween(ctx: GameContext, a: NpcState, b: NpcState): BanterRelation {
  return viewStance(ctx.state, { id: a.id, factionId: a.factionId }, { id: b.id, factionId: b.factionId });
}

/** Does the player currently witness this NPC (within earshot AND line of sight)? */
function playerWitnesses(ctx: GameContext, npc: NpcState): boolean {
  const s = ctx.state;
  if (chebyshev({ tileX: s.player.tileX, tileY: s.player.tileY }, npc) > EARSHOT_TILES) return false;
  return canSee(s, { tileX: s.player.tileX, tileY: s.player.tileY, senses: ctx.playerDef.senses }, { tileX: npc.tileX, tileY: npc.tileY, conditions: npc.conditions, id: npc.id }).sees;
}

/** Emit one banter line: dimmed Event Log entry + the speech-bubble event. */
function emitLine(ctx: GameContext, speaker: NpcState, text: string, events: GameEvent[]): void {
  const speakerName = speaker.revealedName ?? speaker.name;
  ctx.addLog({ left: `💬 ${speakerName}: "${text}"`, style: 'ambient' });
  events.push({ type: 'npc_speech', entityId: speaker.id, text, speakerName });
  const s = ctx.state;
  s.recentAmbientLines = [...(s.recentAmbientLines ?? []), `${speakerName}: "${text}"`].slice(-RECENT_LINES_CAP);
}

/** Resolve `{a}`/`{b}` name placeholders in a line. */
function fillNames(text: string, a: NpcState, b: NpcState): string {
  return text
    .replace(/\{a\}/g, a.revealedName ?? a.name)
    .replace(/\{b\}/g, b.revealedName ?? b.name);
}

/** Find packs whose selectors match a pair + the current world state. */
function eligiblePacks(ctx: GameContext, a: NpcState, b: NpcState, relation: BanterRelation): BanterPack[] {
  const packs = ctx.defs.banter ?? [];
  const dayPhase = ctx.state.dayPhase;
  return packs.filter((p) => {
    if (p.relation !== relation) return false;
    if (p.sameFaction && a.factionId !== b.factionId) return false;
    if (p.faction && a.factionId !== p.faction && b.factionId !== p.faction) return false;
    if (p.dayPhases && p.dayPhases.length > 0 && !p.dayPhases.includes(dayPhase)) return false;
    if (p.exchanges.length === 0) return false;
    return true;
  });
}

/**
 * Run the ambient-banter pass for one world tick. Called from
 * `runSimNpcTicks` after the per-NPC sim dispatch.
 */
export function runAmbientConversations(ctx: GameContext, tickId: number, events: GameEvent[]): void {
  const s = ctx.state;
  if (!(ctx.defs.banter && ctx.defs.banter.length > 0)) return;
  const rng = SimRng.forNpcTick(tickId, 'banter');
  const byId = new Map(s.npcs.map((n) => [n.id, n]));

  // ── 1. Advance in-flight exchanges ──
  const ongoing: ActiveBanter[] = [];
  for (const chat of s.ambientChats ?? []) {
    const a = byId.get(chat.speakerA);
    const b = byId.get(chat.speakerB);
    // Interrupt: a speaker gone, no longer eligible, separated, or unwitnessed.
    if (!a || !b || !isChatEligible(a) || !isChatEligible(b)
        || chebyshev(a, b) > CHAT_RADIUS_TILES
        || !(playerWitnesses(ctx, a) || playerWitnesses(ctx, b))) {
      continue;
    }
    const pack = (ctx.defs.banter ?? []).find((p) => p.id === chat.packId);
    const exchange = pack?.exchanges[chat.exchangeIndex];
    if (!exchange || chat.lineCursor >= exchange.lines.length) {
      // Finished — start the cooldown for both speakers.
      s.ambientChatCooldowns = { ...(s.ambientChatCooldowns ?? {}), [a.id]: tickId + COOLDOWN_TICKS, [b.id]: tickId + COOLDOWN_TICKS };
      continue;
    }
    const line = exchange.lines[chat.lineCursor];
    const speaker = line.speaker === 'a' ? a : b;
    emitLine(ctx, speaker, fillNames(line.text, a, b), events);
    const next = chat.lineCursor + 1;
    if (next >= exchange.lines.length) {
      s.ambientChatCooldowns = { ...(s.ambientChatCooldowns ?? {}), [a.id]: tickId + COOLDOWN_TICKS, [b.id]: tickId + COOLDOWN_TICKS };
    } else {
      ongoing.push({ ...chat, lineCursor: next });
    }
  }
  s.ambientChats = ongoing;

  // ── 2. Maybe start a new exchange ──
  if (!rng.chance(START_CHANCE)) return;
  const busy = new Set<string>();
  for (const chat of ongoing) { busy.add(chat.speakerA); busy.add(chat.speakerB); }
  const cooldowns = s.ambientChatCooldowns ?? {};
  const candidates = s.npcs.filter((n) =>
    isChatEligible(n) && !busy.has(n.id) && (cooldowns[n.id] ?? 0) <= tickId && playerWitnesses(ctx, n),
  );
  if (candidates.length < 2) return;

  // Pick an initiator the player can witness, then a nearby partner.
  const a = rng.pick(candidates);
  const partners = s.npcs.filter((n) =>
    n.id !== a.id && isChatEligible(n) && !busy.has(n.id) && (cooldowns[n.id] ?? 0) <= tickId
    && chebyshev(a, n) <= CHAT_RADIUS_TILES
    && canSee(s, { tileX: a.tileX, tileY: a.tileY, senses: ctx.resolveMonsterDef(a.defId)?.senses }, { tileX: n.tileX, tileY: n.tileY, conditions: n.conditions, id: n.id }).sees,
  );
  if (partners.length === 0) return;
  const b = rng.pick(partners);

  const relation = relationBetween(ctx, a, b);
  const packs = eligiblePacks(ctx, a, b, relation);
  if (packs.length === 0) return;
  const pack = rng.pick(packs);
  const exchangeIndex = rng.intBelow(pack.exchanges.length);

  const first = pack.exchanges[exchangeIndex].lines[0];
  if (!first) return;
  const speaker = first.speaker === 'a' ? a : b;
  emitLine(ctx, speaker, fillNames(first.text, a, b), events);
  const total = pack.exchanges[exchangeIndex].lines.length;
  if (total > 1) {
    s.ambientChats = [...ongoing, { speakerA: a.id, speakerB: b.id, packId: pack.id, exchangeIndex, lineCursor: 1 }];
  } else {
    s.ambientChatCooldowns = { ...(s.ambientChatCooldowns ?? {}), [a.id]: tickId + COOLDOWN_TICKS, [b.id]: tickId + COOLDOWN_TICKS };
  }
}
