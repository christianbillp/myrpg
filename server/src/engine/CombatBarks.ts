/**
 * In-combat barks — flavorful one-liners NPCs call out during a fight, tied to
 * what they DO (attack / flee / surrender) and to impactful MOMENTS (taking
 * damage / bloodied / death). Built on the same `npc_speech` bubble + Event Log
 * channel as ambient banter (US-129), but fired by combat events rather than the
 * world tick.
 *
 * `emitCombatBark` is the single entry point; the combat engine calls it from a
 * handful of hooks (the central NPC-damage publisher, the enemy attack site, the
 * morale flee/surrender branch). Lines come from authored `CombatBarkPack`s in
 * the setting's `barks/` directory, scoped by faction / def / creature-type.
 *
 * Kept sparse so a fight has texture without becoming a chatroom: frequent
 * triggers (attack, damaged) fire on a chance and at most once per round per NPC
 * (`NpcState.lastBarkRound`); impactful one-shots pass `force` and always fire.
 */
import type { GameContext } from './GameContext.js';
import type { NpcState, MonsterDef, BarkTrigger, CombatBarkPack } from './types.js';
import { combatantDisplayName } from './DisplayNames.js';

/** Chance a non-forced (frequent) trigger actually barks. */
const BARK_CHANCE = 0.5;

export function emitCombatBark(
  ctx: GameContext,
  npc: NpcState,
  trigger: BarkTrigger,
  opts: { force?: boolean } = {},
): void {
  const packs = ctx.defs.combatBarks;
  if (!packs || packs.length === 0) return;
  // The dead don't speak — except their own death line.
  if (npc.hp <= 0 && trigger !== 'death') return;
  if (npc.conditions.includes('surrendered') && trigger !== 'surrender') return;

  const def = ctx.resolveMonsterDef(npc.defId);
  const lines = packs
    .filter((p) => p.trigger === trigger && packMatches(p, npc, def))
    .flatMap((p) => p.lines);
  if (lines.length === 0) return;

  const force = opts.force ?? false;
  if (!force) {
    if ((npc.lastBarkRound ?? -1) === (ctx.state.combatRound ?? 0)) return;  // one frequent bark / round
    if (Math.random() > BARK_CHANCE) return;
  }
  npc.lastBarkRound = ctx.state.combatRound ?? 0;

  const line = lines[Math.floor(Math.random() * lines.length)];
  const speakerName = combatantDisplayName(npc, ctx.state.npcs);
  ctx.eventSink?.push({ type: 'npc_speech', entityId: npc.id, text: line, speakerName });
  ctx.addLog({ left: `💬 ${speakerName}: "${line}"`, style: 'ambient' });
}

/** A pack applies when every present selector matches the barking NPC. */
function packMatches(pack: CombatBarkPack, npc: NpcState, def: MonsterDef | undefined): boolean {
  if (pack.factions && !pack.factions.includes(npc.factionId)) return false;
  if (pack.defIds && !pack.defIds.includes(npc.defId)) return false;
  if (pack.types) {
    const type = (def?.type ?? '').toLowerCase();
    if (!pack.types.some((t) => type.includes(t.toLowerCase()))) return false;
  }
  return true;
}
