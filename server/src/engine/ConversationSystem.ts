import type { GameContext } from "./GameContext.js";
import type {
  ConversationDef, ConversationNode, ConversationChoice, ConversationChoiceOutcome,
  ActiveConversation, ConversationExchange, EntityRef, TriggerAction, NpcSave, NpcFactValue,
} from "../../../shared/types.js";
import {
  writeFact, clearFact, adjustRelationship, pushJournal, setArcPhase,
} from "./NpcSavePersistence.js";
import { guardHolds } from "./TriggerSystem.js";

/** A choice is visible when every `visibleIf` guard holds (no guards ⇒ always
 *  visible). Evaluated against live world state so mission flags drive which
 *  branches the player sees. */
function choiceIsVisible(ctx: GameContext, choice: ConversationChoice): boolean {
  return (choice.visibleIf ?? []).every((g) => guardHolds(ctx, g));
}

/**
 * ConversationSystem — server runtime for the deterministic dialogue layer.
 *
 * Designed participant-agnostic from day one so simulation-mode NPC-vs-NPC
 * conversations (future scope) reuse the same engine: the conversation state
 * lives on `GameState.activeConversation` as a generic graph cursor, every
 * effect routes through `resolveEntityRef` (no `"player"`-hardcoding), and
 * the conversation transcript records every participant's contribution.
 *
 * Current scope: the player drives choice selection from the client. Future:
 * a per-NPC policy decides on the NPC's turn during sim play.
 */

const EXCHANGE_CAP = 64;

// ── Public entrypoints ─────────────────────────────────────────────────────

/** Open a conversation between the player and the named NPC. No-op when
 *  another conversation is already active. Returns the resulting active
 *  conversation, or null when the NPC ref or conversation id can't be
 *  resolved. */
export function startConversation(
  ctx: GameContext,
  npcRef: EntityRef,
  conversationId?: string,
): ActiveConversation | null {
  if (ctx.state.activeConversation) return ctx.state.activeConversation;
  const npc = resolveNpcByRef(ctx, npcRef);
  if (!npc) return null;
  const npcDef = ctx.defs.npcs.find((n) => n.id === npc.defId);
  const convId = conversationId ?? npcDef?.conversationId;
  if (!convId) return null;
  const def = ctx.defs.conversations.find((c) => c.id === convId);
  if (!def) return null;

  const speakerRef: EntityRef = `npc_${npc.id}`;
  const conversation: ActiveConversation = {
    conversationId: convId,
    currentNodeId: def.startNode,
    participants: ["player", speakerRef],
    currentSpeaker: speakerRef,
    exchanges: [],
    visitedNodeIds: [],
    lineLastUsed: {},
    attemptedCheckKeys: [],
  };
  ctx.state.activeConversation = conversation;
  enterNode(ctx, def, def.startNode, speakerRef);
  return conversation;
}

/** Advance the active conversation by picking the choice at `choiceIndex`.
 *  Runs ability check + onPass/onFail OR direct actions, then enters the
 *  next node. No-op when nothing is active. */
export function advanceConversation(ctx: GameContext, choiceIndex: number): void {
  const ac = ctx.state.activeConversation;
  if (!ac) return;
  const def = ctx.defs.conversations.find((c) => c.id === ac.conversationId);
  if (!def) return;
  const node = def.nodes.find((n) => n.id === ac.currentNodeId);
  if (!node) return;
  const choice = node.choices[choiceIndex];
  if (!choice) return;

  // No-retry guard: ability-check choices are rolled once per conversation.
  // Re-attempts are rejected silently unless `devFlags.allowRetryChecks` is
  // on. The guard runs BEFORE the choice is written to the transcript so a
  // rejected click leaves no trace.
  const checkKey = choice.check ? `${node.id}#${choiceIndex}` : null;
  if (checkKey && ac.attemptedCheckKeys.includes(checkKey) && !ctx.state.devFlags?.allowRetryChecks) {
    return;
  }

  // Record the choice in BOTH the conversation transcript and the Event Log
  // so the player can scroll back through their dialogue choices later.
  const playerName = ctx.playerDef.name;
  pushExchange(ac, "player", playerName, "choice", choice.label);
  ctx.addLog({ left: `▸ ${playerName}: "${choice.label}"`, style: "status" });

  // openAigm choices are surfaced to the client which opens the GM input
  // with the full transcript context. The server doesn't navigate — the
  // AIGM's tool calls (Phase 5) will optionally re-anchor via
  // set_conversation_node.
  if (choice.openAigm) {
    return; // client opens AIGM with transcript; conversation stays paused
  }

  // Ability check — roll server-side, write the result to both the
  // transcript and the Event Log, then route to onPass / onFail.
  if (choice.check) {
    const result = runConversationCheck(ctx, choice);
    if (checkKey && !ac.attemptedCheckKeys.includes(checkKey)) {
      ac.attemptedCheckKeys.push(checkKey);
    }
    const outcome = result.passed ? choice.onPass : choice.onFail;
    const what = formatCheckLabel(choice.check.skill ?? choice.check.ability ?? "check");
    const rollText = `${what} (d20[${result.roll}]${formatModifier(result.modifier)} = ${result.total} vs DC ${choice.check.dc}) — ${result.passed ? "SUCCESS" : "FAILURE"}`;
    pushExchange(ac, choice.check.actor ?? "player",
      result.passed ? "Success" : "Failure", "roll", rollText);
    ctx.addLog({ left: `🎲 ${rollText}`, style: result.passed ? "hit" : "miss" });
    if (outcome) applyOutcome(ctx, def, outcome);
    return;
  }

  // Plain choice without a check — apply actions + jump.
  applyOutcome(ctx, def, {
    actions: choice.actions,
    next: choice.next,
    end: choice.end,
  });
}

/** Close the active conversation. Writes a conversation-history entry to
 *  every participating persistent NPC's save and clears the runtime state. */
export function endConversation(ctx: GameContext): void {
  const ac = ctx.state.activeConversation;
  if (!ac) return;
  const def = ctx.defs.conversations.find((c) => c.id === ac.conversationId);

  // Record completion in every persistent participating NPC's save.
  const saves = ctx.engineRef?.getNpcSaves();
  if (saves && def) {
    for (const participant of ac.participants) {
      if (participant === "player") continue;
      const npcId = entityRefToDefId(ctx, participant);
      if (!npcId) continue;
      const save = saves.get(npcId);
      if (!save) continue;
      const chosenPath = ac.exchanges
        .filter((e) => e.kind === "choice")
        .map((e) => e.text);
      const rolledChecks = ac.exchanges
        .filter((e) => e.kind === "roll")
        .map((e) => parseRollExchange(e.text));
      save.conversationHistory.push({
        conversationId: ac.conversationId,
        endedAtNodeId: ac.currentNodeId,
        chosenPath,
        rolledChecks,
        at: new Date().toISOString(),
      });
    }
  }

  ctx.state.activeConversation = null;
}

/** Jump the active conversation to a specific node. Used by the AIGM
 *  handoff path (`set_conversation_node` tool) to re-anchor after
 *  free-form roleplay. */
export function setConversationNode(ctx: GameContext, nodeId: string): void {
  const ac = ctx.state.activeConversation;
  if (!ac) return;
  const def = ctx.defs.conversations.find((c) => c.id === ac.conversationId);
  if (!def) return;
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  enterNode(ctx, def, nodeId, node.speaker ?? ac.currentSpeaker);
}

// ── NpcSave-mutating effect actions ────────────────────────────────────────
//
// These mirror the TriggerAction variants of the same name and are reused by
// both the conversation system and (Phase 5) the AIGM tool handlers.

export function applyNpcRemember(
  ctx: GameContext,
  ref: EntityRef,
  fact: string,
  value: NpcFactValue = true,
  source: "authored" | "aigm" | "witness" | "system" = "authored",
): void {
  const save = resolveNpcSave(ctx, ref);
  if (!save) return;
  writeFact(save, fact, value, source);
}

export function applyNpcForget(ctx: GameContext, ref: EntityRef, fact: string): void {
  const save = resolveNpcSave(ctx, ref);
  if (!save) return;
  clearFact(save, fact);
}

export function applyNpcAdjustRelationship(
  ctx: GameContext,
  ref: EntityRef,
  target: EntityRef,
  delta: number,
): void {
  const save = resolveNpcSave(ctx, ref);
  if (!save) return;
  adjustRelationship(save, target, delta);
}

export function applyNpcRecordJournal(
  ctx: GameContext,
  ref: EntityRef,
  text: string,
  source: "authored" | "aigm" | "witness" | "system" = "authored",
  salience: 1 | 2 | 3 = 2,
): void {
  const save = resolveNpcSave(ctx, ref);
  if (!save) return;
  pushJournal(save, text, source, salience);
}

export function applyNpcSetArcPhase(ctx: GameContext, ref: EntityRef, phase: string): void {
  const save = resolveNpcSave(ctx, ref);
  if (!save) return;
  setArcPhase(save, phase);
}

// ── Internal helpers ───────────────────────────────────────────────────────

function enterNode(ctx: GameContext, def: ConversationDef, nodeId: string, speaker: EntityRef): void {
  const ac = ctx.state.activeConversation!;
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return;
  ac.currentNodeId = nodeId;
  ac.currentSpeaker = node.speaker ?? speaker;
  if (!ac.visitedNodeIds.includes(nodeId)) ac.visitedNodeIds.push(nodeId);

  // Pick + record the line. Push to BOTH the transcript and the Event Log
  // so a scrollback in either surface tells the same story.
  const line = pickLine(node, ac.lineLastUsed);
  if (line !== null) {
    const speakerName = resolveSpeakerName(ctx, ac.currentSpeaker);
    pushExchange(ac, ac.currentSpeaker, speakerName, "line", line);
    ctx.addLog({ left: `💬 ${speakerName}: "${line}"`, style: "status" });
  }

  // onEnter actions fire BEFORE choices are surfaced. Capture anything the
  // actions write to the event log and replay it as "event" exchanges so
  // the conversation overlay shows the effects inline.
  if (node.onEnter) {
    runActionsCapturingLog(ctx, node.onEnter);
  }

  // Resolve which choices are visible NOW — after onEnter, so a node's choices
  // can react to flags it (or the choice that led here) just set. The client
  // renders only these indices. Skip if onEnter ended the conversation.
  if (ctx.state.activeConversation === ac) {
    ac.choiceVisibility = node.choices
      .map((choice, i) => (choiceIsVisible(ctx, choice) ? i : -1))
      .filter((i) => i >= 0);
  }

  // Auto-end terminal nodes.
  if (node.ends) endConversation(ctx);
}

function applyOutcome(ctx: GameContext, def: ConversationDef, outcome: ConversationChoiceOutcome): void {
  if (outcome.actions) {
    runActionsCapturingLog(ctx, outcome.actions);
  }
  if (outcome.end) {
    endConversation(ctx);
    return;
  }
  if (outcome.next) {
    enterNode(ctx, def, outcome.next, ctx.state.activeConversation?.currentSpeaker ?? "player");
  }
}

/** Fire a list of actions, capture every entry they appended to the Event
 *  Log during execution, and replay each one as a `kind: "event"` exchange
 *  on the active conversation. Lets authors surface effects (gold spent,
 *  flag set with `show_log`, NPC bubble, etc.) inside the conversation
 *  overlay without having to author parallel transcript text. */
function runActionsCapturingLog(ctx: GameContext, actions: TriggerAction[]): void {
  const before = ctx.state.eventLog.length;
  for (const action of actions) fireConversationAction(ctx, action);
  const ac = ctx.state.activeConversation;
  if (!ac) return; // conversation may have ended mid-chain (end_conversation)
  for (let i = before; i < ctx.state.eventLog.length; i++) {
    const entry = ctx.state.eventLog[i];
    // Skip rows the conversation system pushed itself (NPC line / player
    // choice / roll already have transcript exchanges of the right kind).
    if (isOwnConversationLog(entry.left)) continue;
    pushExchange(ac, "system", "—", "event", entry.left);
  }
}

/** Heuristic: rows starting with the conversation system's prefixes were
 *  already turned into a typed exchange (`line`, `choice`, `roll`); a second
 *  copy under `kind: "event"` would double up. */
function isOwnConversationLog(left: string): boolean {
  return left.startsWith("💬 ") || left.startsWith("▸ ") || left.startsWith("🎲 ");
}

/** Resolve a `"self"` ref to the current speaker, then pass through to the
 *  central fire-action dispatcher. Conversation-specific actions
 *  (npc_remember, etc.) are handled here directly so the trigger
 *  dispatcher stays decoupled from `"self"` semantics. */
function fireConversationAction(ctx: GameContext, action: TriggerAction): void {
  const ac = ctx.state.activeConversation;
  // Rewrite `"self"` refs to the current speaker. We do this for the
  // conversation-specific actions explicitly; other refs pass through
  // unchanged. (Other actions don't currently use `"self"`.)
  switch (action.type) {
    case "npc_remember": {
      const ref = action.ref === "self" ? ac?.currentSpeaker ?? action.ref : action.ref;
      applyNpcRemember(ctx, ref, action.fact, action.value, action.source ?? "authored");
      return;
    }
    case "npc_forget": {
      const ref = action.ref === "self" ? ac?.currentSpeaker ?? action.ref : action.ref;
      applyNpcForget(ctx, ref, action.fact);
      return;
    }
    case "npc_adjust_relationship": {
      const ref = action.ref === "self" ? ac?.currentSpeaker ?? action.ref : action.ref;
      applyNpcAdjustRelationship(ctx, ref, action.target, action.delta);
      return;
    }
    case "npc_record_journal": {
      const ref = action.ref === "self" ? ac?.currentSpeaker ?? action.ref : action.ref;
      applyNpcRecordJournal(ctx, ref, action.text, action.source ?? "authored", action.salience);
      return;
    }
    case "npc_set_arc_phase": {
      const ref = action.ref === "self" ? ac?.currentSpeaker ?? action.ref : action.ref;
      applyNpcSetArcPhase(ctx, ref, action.phase);
      return;
    }
    case "start_conversation":
      startConversation(ctx, action.npcRef, action.conversationId);
      return;
    case "end_conversation":
      endConversation(ctx);
      return;
    case "set_conversation_node":
      setConversationNode(ctx, action.nodeId);
      return;
    default:
      // Everything else routes through the standard trigger dispatcher.
      ctx.engineRef?.fireSingleAction(action);
      return;
  }
}

interface ConversationCheckResult {
  passed: boolean;
  roll: number;
  modifier: number;
  total: number;
}

function runConversationCheck(ctx: GameContext, choice: ConversationChoice): ConversationCheckResult {
  const c = choice.check!;
  // For now: actor is the player (or omitted = player). NPC-driven checks
  // (sim mode) will land in a follow-up.
  const playerDef = ctx.playerDef;
  let modifier = 0;
  if (c.skill && typeof playerDef.skills?.[c.skill] === "number") {
    modifier = playerDef.skills[c.skill];
  } else if (c.ability) {
    const score = (playerDef as unknown as Record<string, number>)[c.ability] ?? 10;
    modifier = Math.floor((score - 10) / 2);
  }
  // d20 + modifier, with adv/dis when configured.
  const adv = c.advantage ?? "normal";
  const r1 = 1 + Math.floor(Math.random() * 20);
  let roll = r1;
  if (adv === "advantage") {
    const r2 = 1 + Math.floor(Math.random() * 20);
    roll = Math.max(r1, r2);
  } else if (adv === "disadvantage") {
    const r2 = 1 + Math.floor(Math.random() * 20);
    roll = Math.min(r1, r2);
  }
  const total = roll + modifier;
  return { passed: total >= c.dc, roll, modifier, total };
}

/** "persuasion" → "Persuasion", "sleightOfHand" → "Sleight of Hand". */
function formatCheckLabel(skill: string): string {
  return skill
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (s) => s.toUpperCase());
}

function formatModifier(mod: number): string {
  if (mod === 0) return "";
  return mod > 0 ? `+${mod}` : `${mod}`;
}

function pickLine(node: ConversationNode, memory: Record<string, number>): string | null {
  if (node.lines.length === 0) return null;
  if (node.lines.length === 1) {
    memory[node.id] = 0;
    return node.lines[0];
  }
  const last = memory[node.id] ?? -1;
  let idx = Math.floor(Math.random() * node.lines.length);
  if (idx === last) idx = (idx + 1) % node.lines.length;
  memory[node.id] = idx;
  return node.lines[idx];
}

function pushExchange(
  ac: ActiveConversation,
  speaker: EntityRef,
  speakerName: string,
  kind: ConversationExchange["kind"],
  text: string,
): void {
  ac.exchanges.push({ speaker, speakerName, kind, text, at: new Date().toISOString() });
  while (ac.exchanges.length > EXCHANGE_CAP) ac.exchanges.shift();
}

function resolveSpeakerName(ctx: GameContext, ref: EntityRef): string {
  if (ref === "player") return ctx.playerDef.name;
  const npc = resolveNpcByRef(ctx, ref);
  if (!npc) return ref;
  return npc.revealedName ?? npc.name ?? npc.defId;
}

function resolveNpcByRef(ctx: GameContext, ref: EntityRef) {
  if (ref === "player") return undefined;
  return ctx.resolveNpcByEntity(ref) ?? ctx.state.npcs.find((n) => `npc_${n.id}` === ref || `npc_${n.defId}` === ref);
}

function entityRefToDefId(ctx: GameContext, ref: EntityRef): string | null {
  const npc = resolveNpcByRef(ctx, ref);
  return npc?.defId ?? null;
}

function resolveNpcSave(ctx: GameContext, ref: EntityRef): NpcSave | null {
  const defId = entityRefToDefId(ctx, ref);
  if (!defId) return null;
  return ctx.engineRef?.getNpcSaves().get(defId) ?? null;
}

function parseRollExchange(text: string): { skill: string; dc: number; total: number; passed: boolean } {
  // Format mirrored by the formatter above:
  // "<Skill> (d20[<roll>][+mod] = <total> vs DC <dc>) — SUCCESS|FAILURE".
  const match = /^(.*?) \(d20\[\d+\][^=]*= (\d+) vs DC (\d+)\) — (SUCCESS|FAILURE)$/.exec(text);
  if (!match) return { skill: "?", dc: 0, total: 0, passed: false };
  return {
    skill: match[1].trim() || "?",
    total: parseInt(match[2], 10),
    dc: parseInt(match[3], 10),
    passed: match[4] === "SUCCESS",
  };
}
