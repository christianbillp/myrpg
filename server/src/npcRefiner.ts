import Anthropic from "@anthropic-ai/sdk";
import type { GameDefs } from "./engine/types.js";
import { settingPromptBlock } from "./settings.js";

/**
 * NPC Refiner — Claude takes a draft NPC (identity fields + persona +
 * persistent/conversationId) and a free-text prompt, returns a structured
 * patch. Smallest of the three creators because there's no graph or spatial
 * dimension; the AI mostly proposes prose + a monster class + a faction +
 * (optionally) a conversation id and a token asset path.
 *
 * Like the encounter / adventure refiners, the AI may only reference ids
 * that already exist in the relevant rosters (monsters, factions,
 * conversations). The server validates every proposed reference; the
 * client renders a diff and the user accepts / rejects.
 */

export interface NpcDraftForRefine {
  /** snake_case id — user owns this, AI does not propose changes to it. */
  id: string;
  name: string;
  /** Monster def id whose stat block this NPC inherits at spawn time. */
  monsterClass: string;
  /** Optional faction id; empty string when unset. */
  factionId: string;
  /** Hex colour string (`#aabbcc`). Stored numerically on disk; converted
   *  back at save time. */
  color: string;
  /** Path under `/tokens/` — empty string when unset. */
  tokenAsset: string;
  /** Persona blurb the AIGM reads when roleplaying the character. */
  persona: string;
  persistent: boolean;
  /** Optional conversation id; empty string when unset. */
  conversationId: string;
}

/** Reference data the model sees so it can pick valid ids when proposing
 *  monsterClass / factionId / conversationId. Built fresh on every request. */
export interface NpcRefinePool {
  monsters: Array<{ id: string; name: string; type: string; cr: string; hp: number }>;
  factions: Array<{ id: string; name: string; description: string }>;
  conversations: Array<{ id: string }>;
}

export interface RefineNpcRequest {
  draft: NpcDraftForRefine;
  prompt: string;
  pool: NpcRefinePool;
}

export interface RefineNpcResponse {
  /** Subset of the draft — only fields the model wants to modify. */
  proposed: Partial<{
    name: string;
    monsterClass: string;
    factionId: string;
    color: string;
    tokenAsset: string;
    persona: string;
    persistent: boolean;
    conversationId: string;
  }>;
  rationale: string;
}

interface RefinerPayload {
  rationale: string;
  name?: string;
  monsterClass?: string;
  factionId?: string;
  color?: string;
  tokenAsset?: string;
  persona?: string;
  persistent?: boolean;
  conversationId?: string;
}

export async function refineNpc(
  anthropic: Anthropic,
  defs: GameDefs,
  req: RefineNpcRequest,
): Promise<RefineNpcResponse> {
  const validMonsterIds = new Set(req.pool.monsters.map((m) => m.id));
  const validFactionIds = new Set(req.pool.factions.map((f) => f.id));
  const validConvIds    = new Set(req.pool.conversations.map((c) => c.id));

  const system = buildSystemPrompt(defs, req.pool);
  const user = buildUserPrompt(req);
  const tool = buildResponseTool();

  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_refinement" },
    messages: [{ role: "user", content: user }],
  });

  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("Model did not return a tool_use block.");
  }
  const payload = block.input as RefinerPayload;
  validateRefinement(payload, validMonsterIds, validFactionIds, validConvIds);

  const proposed: RefineNpcResponse["proposed"] = {};
  if (payload.name           !== undefined) proposed.name           = payload.name;
  if (payload.monsterClass   !== undefined) proposed.monsterClass   = payload.monsterClass;
  if (payload.factionId      !== undefined) proposed.factionId      = payload.factionId;
  if (payload.color          !== undefined) proposed.color          = normaliseHexColor(payload.color);
  if (payload.tokenAsset     !== undefined) proposed.tokenAsset     = payload.tokenAsset;
  if (payload.persona        !== undefined) proposed.persona        = payload.persona;
  if (payload.persistent     !== undefined) proposed.persistent     = payload.persistent;
  if (payload.conversationId !== undefined) proposed.conversationId = payload.conversationId;

  return { proposed, rationale: payload.rationale };
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateRefinement(
  p: RefinerPayload,
  validMonsterIds: Set<string>,
  validFactionIds: Set<string>,
  validConvIds: Set<string>,
): void {
  if (!p.rationale || typeof p.rationale !== "string") {
    throw new Error("refineNpc: missing rationale.");
  }
  if (p.monsterClass !== undefined) {
    if (typeof p.monsterClass !== "string" || !validMonsterIds.has(p.monsterClass)) {
      throw new Error(`refineNpc: monsterClass "${p.monsterClass}" is not a known monster id.`);
    }
  }
  if (p.factionId !== undefined && p.factionId !== "") {
    if (typeof p.factionId !== "string" || !validFactionIds.has(p.factionId)) {
      throw new Error(`refineNpc: factionId "${p.factionId}" is not a known faction id.`);
    }
  }
  if (p.conversationId !== undefined && p.conversationId !== "") {
    if (typeof p.conversationId !== "string" || !validConvIds.has(p.conversationId)) {
      throw new Error(`refineNpc: conversationId "${p.conversationId}" is not a known conversation id.`);
    }
  }
  if (p.color !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(p.color)) {
    throw new Error(`refineNpc: color "${p.color}" must be a 6-digit hex colour (e.g. "#aabbcc").`);
  }
  if (p.tokenAsset !== undefined && p.tokenAsset !== "") {
    if (!/^\/?tokens\/[a-z0-9_\-\.]+\.svg$/i.test(p.tokenAsset)) {
      throw new Error(`refineNpc: tokenAsset "${p.tokenAsset}" must point at /tokens/<id>.svg.`);
    }
  }
}

function normaliseHexColor(raw: string): string {
  const s = raw.trim().replace(/^#/, "").toLowerCase();
  return `#${s}`;
}

// ── Prompt assembly ────────────────────────────────────────────────────────

function buildSystemPrompt(defs: GameDefs, pool: NpcRefinePool): string {
  const setting = settingPromptBlock(defs.activeSetting ?? null, "summary");
  const settingRules = setting
    ? "\n\nKeep every proposal consistent with the active setting (above) — names, factions, themes, tone."
    : "";

  const monsterLines = pool.monsters
    .map((m) => `  ${m.id}  ·  ${m.name}  ·  ${m.type}  ·  CR ${m.cr}  ·  HP ${m.hp}`)
    .join("\n");
  const factionLines = pool.factions.length === 0
    ? "  (no factions — proposing factionId is not allowed)"
    : pool.factions.map((f) => `  ${f.id}  ·  ${f.name}${f.description ? "  ·  " + f.description.replace(/\s+/g, " ").slice(0, 120) : ""}`).join("\n");
  const convLines = pool.conversations.length === 0
    ? "  (no conversations — proposing conversationId is not allowed)"
    : pool.conversations.map((c) => `  ${c.id}`).join("\n");

  return `${setting ? setting + "\n\n" : ""}You are an NPC editor for a 2D tile-based SRD 5.2.1 RPG. The user has an existing NPC draft and describes what to change. You return a STRUCTURED PATCH via the submit_refinement tool — only the fields you want to modify. Fields you omit are left untouched.${settingRules}

MONSTER ROSTER (monsterClass MUST be an exact id from this list — the NPC inherits its stat block at spawn time):
${monsterLines}

FACTION ROSTER (factionId MUST be an exact id from this list, or empty string to clear):
${factionLines}

CONVERSATION POOL (conversationId MUST be an exact id from this list, or empty string to clear):
${convLines}

REFINEMENT RULES:
- Make the SMALLEST change that satisfies the user's prompt. If they only ask for a new name, return only \`name\`.
- \`monsterClass\` drives this NPC's stat block — pick a monster whose CR / type / HP fits the role you're describing. Don't accidentally turn a tavern keeper into a dragon.
- \`color\` is a 6-digit hex string (\`#aabbcc\`). Pick something that reads against a dark map background.
- \`tokenAsset\` should point at \`/tokens/<id>.svg\` and only when you know the file exists; leave it untouched otherwise.
- \`persona\` is the AIGM's roleplay brief — 2-4 sentences, second-person, captures voice and what they know.
- \`persistent\` should be true only for NPCs the player is expected to interact with again across sessions (named characters; not throwaways).
- \`conversationId\` ties the NPC to a deterministic dialogue graph. Only set when the id exists in the pool above.
- Always include a short \`rationale\` (1-2 sentences) describing what you changed and why.

OUTPUT — emit ONLY the submit_refinement tool call. No code fences, no prose outside the tool.`;
}

function buildUserPrompt(req: RefineNpcRequest): string {
  const d = req.draft;
  return `CURRENT DRAFT:

Id:              ${d.id || "(empty)"}
Name:            ${d.name || "(empty)"}
Monster class:   ${d.monsterClass || "(empty)"}
Faction id:      ${d.factionId || "(none)"}
Color (hex):     ${d.color || "(default)"}
Token asset:     ${d.tokenAsset || "(falls back to monster token)"}
Persistent:     ${d.persistent ? "yes" : "no"}
Conversation:   ${d.conversationId || "(none)"}

Persona:
${d.persona || "(empty)"}

USER REQUEST:
${req.prompt}`;
}

function buildResponseTool() {
  return {
    name: "submit_refinement",
    description: "Return ONLY the fields you want to change in the NPC draft. Omit fields you want untouched.",
    input_schema: {
      type: "object" as const,
      properties: {
        rationale:      { type: "string", description: "1-2 sentence summary of what you changed and why." },
        name:           { type: "string" },
        monsterClass:   { type: "string", description: "Exact monster id from the roster." },
        factionId:      { type: "string", description: "Faction id from the roster, or empty string to clear." },
        color:          { type: "string", description: "6-digit hex (e.g. '#aabbcc')." },
        tokenAsset:     { type: "string", description: "Path under /tokens/, or empty string to clear." },
        persona:        { type: "string", description: "2-4 sentence roleplay brief in second person." },
        persistent:     { type: "boolean" },
        conversationId: { type: "string", description: "Conversation id from the pool, or empty string to clear." },
      },
      required: ["rationale"],
    },
  };
}
