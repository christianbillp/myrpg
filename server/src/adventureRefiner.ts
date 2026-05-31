import Anthropic from "@anthropic-ai/sdk";
import type { GameDefs } from "./engine/types.js";
import { settingPromptBlock } from "./settings.js";

/**
 * Adventure Refiner — Claude takes a draft adventure (title / description /
 * introduction / aiContext + ordered chapter list + optional rest encounter)
 * and a free-text prompt, and returns a structured patch.
 *
 * Smaller than the encounter refiner because there's no spatial element. The
 * AI can edit prose fields, add/remove/reorder/rename chapters from the pool
 * of existing encounters, and pick a rest encounter. It cannot author new
 * encounter content — every `encounterId` must already exist in the registry.
 */

export interface AdventureChapterForRefine {
  id: string;
  title: string;
  encounterId: string;
  completionFlag?: string;
}

export interface AdventureDraftForRefine {
  /** snake_case id — used to suggest stem-related defaults but the AI does
   *  not propose changes to it; the user owns the id. */
  id: string;
  title: string;
  description: string;
  introduction: string;
  aiContext: string;
  chapters: AdventureChapterForRefine[];
  /** Empty string when no rest encounter is set. */
  restEncounterId: string;
}

/** One line per available encounter — surfaced to the model so it can pick
 *  ids when proposing chapters / restEncounterId. The route handler builds
 *  this from the loaded encounter defs. */
export interface EncounterPoolEntry {
  id: string;
  title: string;
  /** Comma-joined encounterTypes (e.g. `"combat"` / `"social,exploration"`). */
  types: string;
  description: string;
}

export interface RefineAdventureRequest {
  draft: AdventureDraftForRefine;
  prompt: string;
  encounterPool: EncounterPoolEntry[];
}

export interface RefineAdventureResponse {
  /** Subset of the draft — only fields the model wants to modify. Missing
   *  fields = leave alone. `chapters` and `restEncounterId` are wholesale
   *  replacements when present. */
  proposed: Partial<{
    title: string;
    description: string;
    introduction: string;
    aiContext: string;
    chapters: AdventureChapterForRefine[];
    /** Empty string clears the rest encounter. */
    restEncounterId: string;
  }>;
  rationale: string;
}

interface RefinerPayload {
  rationale: string;
  title?: string;
  description?: string;
  introduction?: string;
  aiContext?: string;
  chapters?: AdventureChapterForRefine[];
  restEncounterId?: string;
}

export async function refineAdventure(
  anthropic: Anthropic,
  defs: GameDefs,
  req: RefineAdventureRequest,
): Promise<RefineAdventureResponse> {
  const validEncounterIds = new Set(req.encounterPool.map((e) => e.id));

  const system = buildSystemPrompt(defs, req.encounterPool);
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
  validateRefinement(payload, validEncounterIds);

  const proposed: RefineAdventureResponse["proposed"] = {};
  if (payload.title           !== undefined) proposed.title           = payload.title;
  if (payload.description     !== undefined) proposed.description     = payload.description;
  if (payload.introduction    !== undefined) proposed.introduction    = payload.introduction;
  if (payload.aiContext       !== undefined) proposed.aiContext       = payload.aiContext;
  if (payload.chapters        !== undefined) proposed.chapters        = payload.chapters;
  if (payload.restEncounterId !== undefined) proposed.restEncounterId = payload.restEncounterId;

  return { proposed, rationale: payload.rationale };
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateRefinement(p: RefinerPayload, validEncounterIds: Set<string>): void {
  if (!p.rationale || typeof p.rationale !== "string") {
    throw new Error("refineAdventure: missing rationale.");
  }
  if (p.chapters !== undefined) {
    if (!Array.isArray(p.chapters)) throw new Error("refineAdventure: chapters must be an array.");
    const seenIds = new Set<string>();
    p.chapters.forEach((ch, i) => {
      if (!ch || typeof ch !== "object") throw new Error(`refineAdventure: chapters[${i}] is not an object.`);
      if (typeof ch.id !== "string" || !/^[a-z0-9_]+$/.test(ch.id)) {
        throw new Error(`refineAdventure: chapters[${i}].id must be snake_case (lowercase letters / digits / underscores).`);
      }
      if (seenIds.has(ch.id)) throw new Error(`refineAdventure: duplicate chapter id "${ch.id}".`);
      seenIds.add(ch.id);
      if (typeof ch.title !== "string" || !ch.title.trim()) {
        throw new Error(`refineAdventure: chapters[${i}].title must be a non-empty string.`);
      }
      if (typeof ch.encounterId !== "string" || !validEncounterIds.has(ch.encounterId)) {
        throw new Error(`refineAdventure: chapters[${i}].encounterId "${ch.encounterId}" is not a known encounter id.`);
      }
    });
  }
  if (p.restEncounterId !== undefined) {
    if (typeof p.restEncounterId !== "string") {
      throw new Error("refineAdventure: restEncounterId must be a string (empty to clear).");
    }
    if (p.restEncounterId && !validEncounterIds.has(p.restEncounterId)) {
      throw new Error(`refineAdventure: restEncounterId "${p.restEncounterId}" is not a known encounter id.`);
    }
  }
}

// ── Prompt assembly ────────────────────────────────────────────────────────

function buildSystemPrompt(defs: GameDefs, pool: EncounterPoolEntry[]): string {
  const setting = settingPromptBlock(defs.activeSetting ?? null, "summary");
  const settingRules = setting
    ? `\n\nKeep every proposal consistent with the active setting (above) — names, factions, themes, tone.`
    : "";
  const encounterLines = pool
    .map((e) => {
      const blurb = (e.description ?? "").replace(/\s+/g, " ").slice(0, 140);
      return `  ${e.id}  ·  ${e.title || "(untitled)"}  ·  ${e.types || "—"}${blurb ? `  ·  ${blurb}` : ""}`;
    })
    .join("\n");

  return `${setting ? setting + "\n\n" : ""}You are an adventure editor for a 2D tile-based SRD 5.2.1 RPG. The user has an existing adventure draft (title / description / introduction / aiContext + an ordered list of chapters + an optional rest encounter) and describes what to change. You return a STRUCTURED PATCH via the submit_refinement tool — only the fields you want to modify. Fields you omit are left untouched.${settingRules}

ENCOUNTER POOL (every chapter.encounterId AND restEncounterId MUST come from this list — exact ids):
${encounterLines || "  (empty — no encounters available; cannot propose chapter changes)"}

REFINEMENT RULES:
- Make the SMALLEST change that satisfies the user's prompt. If they only ask for a new title, return only \`title\`.
- When proposing \`chapters\`, return the COMPLETE new ordered list — it replaces the existing chapter array wholesale.
- Every chapter \`id\` must be snake_case (lowercase letters / digits / underscores), unique within the adventure, and ideally hint at its place in the arc (e.g. \`ch1_arrival\`, \`ch2_descent\`).
- Every chapter \`encounterId\` must EXACTLY match one in the pool above. Do NOT invent ids.
- \`restEncounterId\` is optional — set to the empty string to clear it, or to an id from the pool. The rest encounter is the inn / campsite / safehouse the player returns to between chapters; pick something low-stakes and conversational, not a combat scene.
- \`aiContext\` is the AIGM's running context for every chapter — backstory, factions, themes, plot hooks. Keep it 1-3 paragraphs.
- \`description\` is the player-facing card text — 1-2 sentences, hook-driven, no spoilers.
- \`introduction\` is the opening narration before chapter 1 — atmospheric, sets the stakes.
- Preserve the adventure's existing tone unless the prompt explicitly directs otherwise.
- Always include a short \`rationale\` (1-2 sentences) describing what you changed and why.

OUTPUT — emit ONLY the submit_refinement tool call. No code fences, no prose outside the tool.`;
}

function buildUserPrompt(req: RefineAdventureRequest): string {
  const d = req.draft;
  const chaptersBlock = d.chapters.length === 0
    ? "(none — this adventure has no chapters yet)"
    : d.chapters.map((c, i) => `  ${i + 1}. ${c.id}  ·  "${c.title}"  ·  encounter=${c.encounterId}`).join("\n");
  return `CURRENT DRAFT:

Id:             ${d.id || "(empty)"}
Title:          ${d.title || "(empty)"}
Description:    ${d.description || "(empty)"}
Introduction:   ${d.introduction || "(empty)"}
AI context:     ${d.aiContext || "(empty)"}
Rest encounter: ${d.restEncounterId || "(none)"}

Chapters:
${chaptersBlock}

USER REQUEST:
${req.prompt}`;
}

function buildResponseTool() {
  const chapterSchema = {
    type: "object" as const,
    properties: {
      id:             { type: "string", pattern: "^[a-z0-9_]+$", description: "snake_case unique chapter id." },
      title:          { type: "string", minLength: 1, description: "Display title shown on the chapter card." },
      encounterId:    { type: "string", minLength: 1, description: "Must match an id from the encounter pool." },
      completionFlag: { type: "string", description: "Optional. Snake_case flag whose set marks the chapter complete; required for non-combat chapters." },
    },
    required: ["id", "title", "encounterId"],
  };
  return {
    name: "submit_refinement",
    description: "Return ONLY the fields you want to change in the adventure draft. Omit fields you want untouched. `chapters` replaces the existing list wholesale when present.",
    input_schema: {
      type: "object" as const,
      properties: {
        rationale:       { type: "string", description: "1-2 sentence summary of what you changed and why." },
        title:           { type: "string" },
        description:     { type: "string" },
        introduction:    { type: "string" },
        aiContext:       { type: "string" },
        chapters:        { type: "array", items: chapterSchema },
        restEncounterId: { type: "string", description: "Encounter id from the pool, or empty string to clear." },
      },
      required: ["rationale"],
    },
  };
}
