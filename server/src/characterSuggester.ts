import Anthropic from "@anthropic-ai/sdk";
import type { GameDefs } from "./engine/types.js";
import { settingPromptBlock } from "./settings.js";
import { ABILITY_KEYS } from "../../shared/abilityScores.js";
import type { AbilityKey } from "../../shared/types.js";

/**
 * Character-concept assistant (US-122). Given a free-text concept and any
 * choices the player has already locked, Claude proposes a setting-consistent
 * character: a name, a one-line tagline + short backstory, a species /
 * background / class drawn from the actual rosters, and an ability-priority
 * order to guide score assignment. The setting lore is injected so suggestions
 * honour the active campaign (names, tone, themes) — the GM's "do not invent
 * outside the setting" rule applies here too.
 *
 * Every proposed id is validated against the live rosters; a locked choice in
 * the request is forced through unchanged. The client renders the suggestion
 * into the creator form, which the player can freely edit before saving.
 */
export interface SuggestCharacterRequest {
  prompt: string;
  /** Choices the player has already locked — the model must respect these. */
  classId?: string;
  speciesId?: string;
  backgroundId?: string;
}

export interface SuggestCharacterResponse {
  name: string;
  shortDescription: string;
  description: string;
  speciesId: string;
  backgroundId: string;
  classId: string;
  /** Six ability keys ordered highest → lowest, guiding score assignment. */
  abilityPriority: AbilityKey[];
  rationale: string;
}

interface SuggesterPayload {
  name?: string;
  shortDescription?: string;
  description?: string;
  speciesId?: string;
  backgroundId?: string;
  classId?: string;
  abilityPriority?: string[];
  rationale?: string;
}

export async function suggestCharacter(
  anthropic: Anthropic,
  defs: GameDefs,
  req: SuggestCharacterRequest,
): Promise<SuggestCharacterResponse> {
  const classes = defs.classes.map((c) => ({ id: c.id, name: c.name }));
  const species = defs.species.map((s) => ({ id: s.id, name: s.name }));
  const backgrounds = defs.backgrounds.map((b) => ({ id: b.id, name: b.name }));

  const system = buildSystemPrompt(defs, classes, species, backgrounds, req);
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system,
    tools: [RESPONSE_TOOL],
    tool_choice: { type: "tool", name: "submit_character" },
    messages: [{ role: "user", content: `Concept: ${req.prompt.trim()}` }],
  });

  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Model did not return a tool_use block.");
  const p = block.input as SuggesterPayload;

  const validClass = new Set(classes.map((c) => c.id));
  const validSpecies = new Set(species.map((s) => s.id));
  const validBg = new Set(backgrounds.map((b) => b.id));

  // Locked choices win; otherwise take the model's pick when valid, else the
  // first roster entry as a safe fallback.
  const classId = pick(req.classId, p.classId, validClass, classes[0]?.id);
  const speciesId = pick(req.speciesId, p.speciesId, validSpecies, species[0]?.id);
  const backgroundId = pick(req.backgroundId, p.backgroundId, validBg, backgrounds[0]?.id);

  return {
    name: (p.name ?? "Adventurer").trim().slice(0, 40),
    shortDescription: (p.shortDescription ?? "").trim().slice(0, 120),
    description: (p.description ?? "").trim().slice(0, 600),
    speciesId, backgroundId, classId,
    abilityPriority: normaliseAbilityPriority(p.abilityPriority),
    rationale: (p.rationale ?? "").trim().slice(0, 300),
  };
}

function pick(locked: string | undefined, proposed: string | undefined, valid: Set<string>, fallback: string | undefined): string {
  if (locked && valid.has(locked)) return locked;
  if (proposed && valid.has(proposed)) return proposed;
  return fallback ?? "";
}

/** Coerce the model's ability order into a valid permutation of the six keys,
 *  appending any it omitted (in canonical order) and dropping dupes/unknowns. */
function normaliseAbilityPriority(raw: string[] | undefined): AbilityKey[] {
  const out: AbilityKey[] = [];
  const seen = new Set<string>();
  for (const k of raw ?? []) {
    const key = String(k).toLowerCase() as AbilityKey;
    if (ABILITY_KEYS.includes(key) && !seen.has(key)) { out.push(key); seen.add(key); }
  }
  for (const k of ABILITY_KEYS) if (!seen.has(k)) out.push(k);
  return out;
}

const RESPONSE_TOOL: Anthropic.Tool = {
  name: "submit_character",
  description: "Submit a setting-consistent character concept.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Character name, fitting the setting (no titles)." },
      shortDescription: { type: "string", description: "One-line tagline (≤ 120 chars)." },
      description: { type: "string", description: "2-3 sentence backstory consistent with the setting." },
      speciesId: { type: "string", description: "An id from the SPECIES roster." },
      backgroundId: { type: "string", description: "An id from the BACKGROUND roster." },
      classId: { type: "string", description: "An id from the CLASS roster." },
      abilityPriority: {
        type: "array", items: { type: "string", enum: [...ABILITY_KEYS] },
        description: "All six ability keys ordered highest → lowest for this class.",
      },
      rationale: { type: "string", description: "1-2 sentences on why these choices fit the concept + setting." },
    },
    required: ["name", "shortDescription", "description", "speciesId", "backgroundId", "classId", "abilityPriority", "rationale"],
  },
};

function buildSystemPrompt(
  defs: GameDefs,
  classes: Array<{ id: string; name: string }>,
  species: Array<{ id: string; name: string }>,
  backgrounds: Array<{ id: string; name: string }>,
  req: SuggestCharacterRequest,
): string {
  const setting = settingPromptBlock(defs.activeSetting ?? null, "full");
  const roster = (label: string, xs: Array<{ id: string; name: string }>) =>
    `${label}:\n${xs.map((x) => `  ${x.id}  ·  ${x.name}`).join("\n")}`;
  const locked: string[] = [];
  if (req.classId) locked.push(`class = ${req.classId}`);
  if (req.speciesId) locked.push(`species = ${req.speciesId}`);
  if (req.backgroundId) locked.push(`background = ${req.backgroundId}`);
  const lockedNote = locked.length
    ? `\n\nThe player has LOCKED these choices — keep them exactly: ${locked.join(", ")}.`
    : "";

  return `${setting ? setting + "\n\n" : ""}You help a player create a level-1 player character for an SRD 5.2.1 RPG. From the player's concept, propose a complete, setting-consistent character via the submit_character tool. Pick the species / background / class from the rosters below (use the exact ids). Honour the active setting${setting ? " (above)" : ""}: the name, tone, and backstory must fit it; do not invent factions or places outside it.${lockedNote}

${roster("CLASS roster", classes)}

${roster("SPECIES roster", species)}

${roster("BACKGROUND roster", backgrounds)}

GUIDELINES:
- Choose a class whose role matches the concept; species + background that reinforce it.
- \`abilityPriority\` lists ALL SIX ability keys (str, dex, con, int, wis, cha) ordered from the one this character should value most to least — put the class's spellcasting / attack ability first.
- \`name\` is just the name (no class/title). \`shortDescription\` is a single evocative line. \`description\` is 2-3 sentences of backstory grounded in the setting.`;
}

// ── Identity generator (US-122 — Review step) ────────────────────────────────

/** Which identity fields to (re)generate. */
export type IdentityField = "name" | "shortDescription" | "description";

/**
 * Generate the requested identity fields (name / tagline / backstory) for an
 * already-built character, honouring the active setting's lore and the full
 * build (species, background, class, top abilities, skills, languages). Only
 * the requested fields are produced — so the player can regenerate one field
 * (e.g. just the tagline) without disturbing the others — and any fields they
 * already wrote are passed as context so the result stays coherent.
 */
export interface GenerateIdentityRequest {
  speciesId: string;
  backgroundId: string;
  classId: string;
  fields: IdentityField[];
  /** Fields the player has already filled in — kept as context. */
  current?: { name?: string; shortDescription?: string; description?: string };
  /** Optional build colour for richer prompts. */
  topAbilities?: string[];   // highest-rated ability keys, best first
  skills?: string[];
  languages?: string[];
}

export interface GenerateIdentityResponse {
  name?: string;
  shortDescription?: string;
  description?: string;
}

const FIELD_BLURB: Record<IdentityField, string> = {
  name: "`name`: just a personal name fitting the setting (no class, title, or epithet)",
  shortDescription: "`shortDescription`: a single evocative tagline (≤ 120 characters)",
  description: "`description`: 2-3 sentences of backstory grounded in the setting",
};

export async function generateCharacterIdentity(
  anthropic: Anthropic,
  defs: GameDefs,
  req: GenerateIdentityRequest,
): Promise<GenerateIdentityResponse> {
  const fields = (req.fields ?? []).filter((f): f is IdentityField => f in FIELD_BLURB);
  if (fields.length === 0) throw new Error("No identity fields requested.");

  const nameOf = (arr: { id: string; name: string }[], id: string) => arr.find((x) => x.id === id)?.name ?? id;
  const species = nameOf(defs.species, req.speciesId);
  const background = nameOf(defs.backgrounds, req.backgroundId);
  const className = nameOf(defs.classes, req.classId);

  const setting = settingPromptBlock(defs.activeSetting ?? null, "full");
  const buildLines = [
    `Species: ${species}`,
    `Background: ${background}`,
    `Class: ${className}`,
    req.topAbilities?.length ? `Strongest abilities: ${req.topAbilities.map((a) => a.toUpperCase()).join(", ")}` : "",
    req.skills?.length ? `Skill proficiencies: ${req.skills.join(", ")}` : "",
    req.languages?.length ? `Languages: ${req.languages.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  const current = req.current ?? {};
  const keepLines = (["name", "shortDescription", "description"] as IdentityField[])
    .filter((f) => !fields.includes(f) && current[f])
    .map((f) => `${f}: ${current[f]}`);
  const contextLines = (["name", "shortDescription", "description"] as IdentityField[])
    .filter((f) => current[f])
    .map((f) => `${f}: ${current[f]}`);

  const system = `${setting ? setting + "\n\n" : ""}You write identity text for a level-1 player character in an SRD 5.2.1 RPG. Produce ONLY these fields via the submit_identity tool, honouring the active setting${setting ? " (above)" : ""} — names, tone, and backstory must fit it; do not invent factions or places outside it:
${fields.map((f) => "- " + FIELD_BLURB[f]).join("\n")}

THE CHARACTER'S BUILD:
${buildLines}${keepLines.length ? `\n\nKeep these already-chosen fields consistent (do not change them):\n${keepLines.join("\n")}` : ""}

Match the requested fields to the build and the setting. Do not return fields you weren't asked for.`;

  const user = contextLines.length
    ? `Generate: ${fields.join(", ")}.\nExisting fields:\n${contextLines.join("\n")}`
    : `Generate: ${fields.join(", ")}.`;

  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system,
    tools: [IDENTITY_TOOL],
    tool_choice: { type: "tool", name: "submit_identity" },
    messages: [{ role: "user", content: user }],
  });
  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Model did not return a tool_use block.");
  const p = block.input as GenerateIdentityResponse;

  // Return only the requested fields, trimmed/clamped.
  const out: GenerateIdentityResponse = {};
  if (fields.includes("name") && p.name) out.name = p.name.trim().slice(0, 40);
  if (fields.includes("shortDescription") && p.shortDescription) out.shortDescription = p.shortDescription.trim().slice(0, 120);
  if (fields.includes("description") && p.description) out.description = p.description.trim().slice(0, 600);
  return out;
}

const IDENTITY_TOOL: Anthropic.Tool = {
  name: "submit_identity",
  description: "Submit the requested character identity fields.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Personal name fitting the setting (no titles)." },
      shortDescription: { type: "string", description: "One-line tagline (≤ 120 chars)." },
      description: { type: "string", description: "2-3 sentence backstory consistent with the setting + build." },
    },
  },
};
