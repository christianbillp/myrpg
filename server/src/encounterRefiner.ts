import Anthropic from "@anthropic-ai/sdk";
import type { GameDefs } from "./engine/types.js";
import { settingPromptBlock } from "./settings.js";
import { stripTileFlipBits } from "../../shared/tileGid.js";
import { instanceIdForSlot } from "../../shared/spawnInstanceIds.js";

/**
 * Encounter Refiner — Claude takes a draft encounter (+ the map it sits on)
 * and a free-text prompt and returns a structured patch. Phase 5 scope: text
 * fields, monster/NPC rosters, AND spatial work — player spawn, monster
 * spawns (one tile per slot), and the full trigger object set.
 *
 * The prompt is given a passability grid for the map plus the current
 * placement state so the model has the spatial context to make decisions.
 */

/** Compact exact-tile spawn shape used in both the request and the proposal. */
export interface SpawnTile {
  /** Slot index into the role's id array — e.g. `{ index: 1, x, y }` binds
   *  the second entry of `enemyIds`. Omitted on the player spawn (player is
   *  a singleton). */
  index?: number;
  x: number;
  y: number;
}

/** Subset of the client's `ComposedTrigger` that's safe to ship over the
 *  wire. Mirrors the trigger schema closely enough for the AI to author
 *  full triggers; the client's TriggerEditor renders these directly. */
export interface RefinerTrigger {
  id: string;
  whenEvent?: 'player_moved' | 'encounter_started' | 'encounter_completed' | 'flag_set';
  region: { x: number; y: number; w: number; h: number };
  kind: 'perception' | 'log' | 'aigm' | 'combat' | 'xp' | 'announcement' | 'speech' | 'fade' | 'set_flag';
  dc?: number;
  passMessage?: string;
  message: string;
  defId?: string;
  defIds?: string[];
  xpAmount?: number;
  durationMs?: number;
  entityRef?: string;
  fadeMode?: 'in' | 'out' | 'dim';
  announcementMode?: 'focused' | 'unfocused';
  whenFlagName?: string;
  setFlagName?: string;
}

export interface EncounterDraftForRefine {
  title: string;
  introduction: string;
  /** Long-form AIGM scene context (maps to encounter JSON's `customContext`). */
  aigmContext: string;
  /** Player-facing card summary (maps to encounter JSON's `description`). */
  description: string;
  objective: string;
  completionFlag: string;
  allyIds: string[];
  enemyIds: string[];
  neutralIds: string[];
  /** Read-only one-line summaries of the encounter's current triggers.
   *  Kept alongside the full `triggerObjects` so the AI's prose edits stay
   *  consistent with what's already scripted. */
  triggers: string[];
  /** Current full trigger objects — read-only context plus the baseline the
   *  AI replaces wholesale when it proposes a new `triggerObjects` array. */
  triggerObjects: RefinerTrigger[];
  /** Saved map id this draft is built on. The server reads the map from
   *  `defs.maps` to build a passability grid for the AI prompt. */
  mapId: string;
  /** Currently bound exact-mode placements (player + per-slot monster
   *  tiles). The AI proposes a new set wholesale when it wants to relocate. */
  playerPlacement: { x: number; y: number } | null;
  enemyPlacements: SpawnTile[];
  allyPlacements: SpawnTile[];
  neutralPlacements: SpawnTile[];
  /** Zone-based starts — array of `[x, y]` pairs per role. The AI may keep,
   *  modify, or supersede these with exact placements. */
  playerZones: Array<[number, number]>;
  allyZones: Array<[number, number]>;
  enemyZones: Array<[number, number]>;
  neutralZones: Array<[number, number]>;
}

export interface RefineRequest {
  draft: EncounterDraftForRefine;
  prompt: string;
}

export interface RefineResponse {
  /** Subset of EncounterDraftForRefine — only fields the model wants to
   *  modify. Missing fields = leave alone. */
  proposed: Partial<{
    title: string;
    introduction: string;
    /** Long-form AIGM scene context. */
    aigmContext: string;
    /** Player-facing card summary. */
    description: string;
    objective: string;
    completionFlag: string;
    allyIds: string[];
    enemyIds: string[];
    neutralIds: string[];
    /** Single exact tile for the player. Null clears the placement. */
    playerSpawn: { x: number; y: number };
    /** Per-slot exact tile for each enemy / ally / neutral. Array replaces
     *  the existing placements wholesale; an empty array clears them. */
    enemySpawns: SpawnTile[];
    allySpawns: SpawnTile[];
    neutralSpawns: SpawnTile[];
    /** Full trigger objects — replaces the entire trigger list wholesale. */
    triggerObjects: RefinerTrigger[];
  }>;
  /** Short explanation of what the model changed and why. */
  rationale: string;
}

interface RefinerPayload {
  rationale: string;
  title?: string;
  introduction?: string;
  aigmContext?: string;
  description?: string;
  objective?: string;
  completionFlag?: string;
  allyIds?: string[];
  enemyIds?: string[];
  neutralIds?: string[];
  playerSpawn?: { x: number; y: number };
  enemySpawns?: SpawnTile[];
  allySpawns?: SpawnTile[];
  neutralSpawns?: SpawnTile[];
  triggerObjects?: RefinerTrigger[];
}

export async function refineEncounter(
  anthropic: Anthropic,
  defs: GameDefs,
  req: RefineRequest,
): Promise<RefineResponse> {
  const validMonsterIds = new Set(defs.monsters.map((m) => m.id));
  const validNpcIds     = new Set(defs.npcs.map((n) => n.id));

  const map = defs.maps.find((m) => m.id === req.draft.mapId);
  if (!map) throw new Error(`refineEncounter: unknown mapId "${req.draft.mapId}"`);
  const passability = buildPassabilityGrid(map, defs);

  const system = buildSystemPrompt(defs);
  const user = buildUserPrompt(req, passability, map.cols, map.rows);
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
  // Use the proposed roster (if any) as the validation baseline so the AI
  // can add a monster and place it in the same response. Fall back to the
  // current draft roster for fields the AI didn't touch.
  const effectiveAllyIds:    string[] = payload.allyIds    ?? req.draft.allyIds;
  const effectiveEnemyIds:   string[] = payload.enemyIds   ?? req.draft.enemyIds;
  const effectiveNeutralIds: string[] = payload.neutralIds ?? req.draft.neutralIds;
  validateRefinement(
    payload,
    validMonsterIds, validNpcIds,
    map.cols, map.rows, passability,
    effectiveAllyIds, effectiveEnemyIds, effectiveNeutralIds,
  );

  const proposed: RefineResponse['proposed'] = {};
  if (payload.title          !== undefined) proposed.title          = payload.title;
  if (payload.introduction   !== undefined) proposed.introduction   = payload.introduction;
  if (payload.aigmContext    !== undefined) proposed.aigmContext    = payload.aigmContext;
  if (payload.description    !== undefined) proposed.description    = payload.description;
  if (payload.objective      !== undefined) proposed.objective      = payload.objective;
  if (payload.completionFlag !== undefined) proposed.completionFlag = payload.completionFlag;
  if (payload.allyIds        !== undefined) proposed.allyIds        = payload.allyIds;
  if (payload.enemyIds       !== undefined) proposed.enemyIds       = payload.enemyIds;
  if (payload.neutralIds     !== undefined) proposed.neutralIds     = payload.neutralIds;
  if (payload.playerSpawn    !== undefined) proposed.playerSpawn    = payload.playerSpawn;
  if (payload.enemySpawns    !== undefined) proposed.enemySpawns    = payload.enemySpawns;
  if (payload.allySpawns     !== undefined) proposed.allySpawns     = payload.allySpawns;
  if (payload.neutralSpawns  !== undefined) proposed.neutralSpawns  = payload.neutralSpawns;
  if (payload.triggerObjects !== undefined) proposed.triggerObjects = payload.triggerObjects;

  return { proposed, rationale: payload.rationale };
}

// ── Map passability grid ───────────────────────────────────────────────────

/** Build a row-major passability grid: `.` passable, `#` impassable. Skips
 *  flip-bits when looking up GIDs (orientation doesn't affect passability). */
function buildPassabilityGrid(
  map: { gidGrid: number[][]; objectGidGrid?: number[][]; tilesets: Array<{ firstgid: number; tilePassability: Record<number, boolean> }> },
  defs: GameDefs,
): string {
  const legend = defs.tileLegend.tiles;
  const tilesets = map.tilesets ?? [];
  const cellPassable = (groundRaw: number, objectRaw: number | undefined): boolean => {
    const eff = (objectRaw && objectRaw !== 0) ? objectRaw : groundRaw;
    if (eff === 0) return true;
    const gid = stripTileFlipBits(eff);
    let owner: { firstgid: number; tilePassability: Record<number, boolean> } | undefined;
    for (const ts of tilesets) {
      if (ts.firstgid <= gid && (!owner || ts.firstgid > owner.firstgid)) owner = ts;
    }
    if (owner) {
      const local = gid - owner.firstgid;
      const declared = owner.tilePassability[local];
      if (declared !== undefined) return declared;
    }
    const legendPassable = legend[String(gid)]?.passable;
    if (legendPassable !== undefined) return legendPassable;
    return true;
  };
  const lines: string[] = [];
  for (let r = 0; r < map.gidGrid.length; r++) {
    let line = "";
    for (let c = 0; c < map.gidGrid[r].length; c++) {
      const g = map.gidGrid[r][c] ?? 0;
      const o = map.objectGidGrid?.[r]?.[c] ?? 0;
      line += cellPassable(g, o) ? "." : "#";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// ── Prompts ────────────────────────────────────────────────────────────────

function buildSystemPrompt(defs: GameDefs): string {
  const monsterLines = defs.monsters.map((m) => `  ${m.id} — ${m.name} (CR ${m.cr})`).join("\n");
  const npcLines     = defs.npcs.map((n) => `  ${n.id} — ${n.name}`).join("\n");
  const setting = settingPromptBlock(defs.activeSetting, 'full');
  const settingRules = defs.activeSetting ? `

SETTING-AWARE AUTHORING — the active setting block is your canon. Every prose field you write must read as part of that world; do not default to generic high fantasy.` : '';

  return `${setting ? setting + '\n\n' : ''}You are an encounter editor for a 2D tile-based SRD 5.2.1 RPG. The user has an existing encounter draft (text + monster roster + map + spawn positions + scripted triggers) and describes what to change. You return a STRUCTURED PATCH via the submit_refinement tool — only the fields you want to modify. Fields you omit are left untouched.${settingRules}

MONSTER ROSTER (allyIds / enemyIds must come from this list — exact ids):
${monsterLines}

NPC ROSTER (neutralIds must come from this list — exact ids):
${npcLines}

REFINEMENT RULES:
- Make the SMALLEST change that satisfies the user's prompt. If they only ask for a new title, return only \`title\`. If they only ask to relocate the player, return only \`playerSpawn\`.
- When updating a roster (allyIds / enemyIds / neutralIds), return the COMPLETE new array, not a delta — the response replaces the field wholesale.
- When updating spawns or triggers, the response REPLACES the existing list wholesale. To add to existing triggers, include them all in the new list.
- Preserve the encounter's existing tone and stakes unless the prompt explicitly directs otherwise.
- \`completionFlag\` must be snake_case (lowercase letters, digits, underscores only).
- Always include a short \`rationale\` (1-2 sentences) describing what you changed and why.

SPATIAL PLACEMENT — when the user asks for a full encounter ("set everything up", "ambush scene", "place the bandits in the trees"), you SHOULD propose spawns and triggers, not just text. The user prompt embeds the map's passability grid:
- Each row is one map row, top to bottom. Each character is one tile, left to right.
- '.' means the tile is PASSABLE (creatures can stand on it).
- '#' means the tile is IMPASSABLE (wall, water, void, blocking object — do NOT spawn anything here).
- Coordinates are \`(x, y)\` where \`x\` is the column index (0 = leftmost) and \`y\` is the row index (0 = top row).

PLACEMENT RULES:
- Every spawn coordinate MUST point at a '.' tile. Never spawn on '#'.
- Coordinates must be within bounds: 0 ≤ x < width, 0 ≤ y < height.
- The player spawn is a single tile. Each monster spawn must reference a roster slot by \`index\` (0-based into the array you're proposing or, if you're not changing the roster, the CURRENT roster).
- Do NOT stack two creatures on the same tile (the player and every monster slot need unique tiles).
- Pick positions that match the scene: ambushers behind cover, allies near the player, neutral NPCs in safe spots, bosses in the focal feature. Use the passability grid to find chokepoints, rooms, and natural cover.
- The player spawn should be a tile that gives the player a clear view and at least one direction to step into without immediately being adjacent to a hostile spawn (unless the scene is explicitly an ambush at point blank).

TRIGGER OBJECTS — when you propose \`triggerObjects\`, return a FULL trigger list (you may include unchanged existing triggers + your new ones). Each trigger object's shape:
- \`id\`: unique snake_case slug — e.g. \`approach_throne\`, \`spot_trap\`.
- \`whenEvent\`: \`player_moved\` (default — fires when player enters the region), \`encounter_started\`, \`encounter_completed\`, or \`flag_set\`.
- \`region\`: \`{ x, y, w, h }\` — rectangular tile region. \`w\`/\`h\` ≥ 1. Must fit inside the map.
- \`kind\`: one of:
  - \`perception\` — DC perception check. Required: \`dc\`, \`passMessage\`, \`message\` (fail text).
  - \`combat\` — flips monsters to enemy disposition + starts combat. Required: \`defIds\` (list of **definition ids** that get flipped — e.g. \`"bandit"\`, \`"goblin_minion"\`). These are the SAME strings that appear in \`enemyIds\` / \`neutralIds\` / \`allyIds\` (or in the global monster/NPC rosters). DO NOT use slot refs (\`neutral_1\`, \`enemy_0\`), combat labels (\`enemy_A\`), or instance ids (\`bandit_1\`) — only the bare defId. Flipping one defId flips every NPC in the encounter with that def, which is usually what you want for "the bandits attack".
  - \`log\` — appends a text line to the event log. Required: \`message\`.
  - \`speech\` — an NPC speaks a line. Required: \`entityRef\` (e.g. \`npc_<id>\` or \`enemy_A\`), \`message\`.
  - \`aigm\` — feeds a cue to the AI Game Master so it narrates the next reply with the line. Required: \`message\`.
  - \`announcement\` — full-screen announcement. Required: \`message\`. Optional: \`durationMs\` (default 3000), \`announcementMode\` (\`focused\` pauses the world).
  - \`fade\` — fade overlay. Required: \`fadeMode\` (\`in\`/\`out\`/\`dim\`). Optional: \`durationMs\` (default 800).
  - \`xp\` — award XP. Required: \`xpAmount\`, \`message\`.
  - \`set_flag\` — set an encounter flag. Required: \`setFlagName\`, \`message\`.
- \`whenFlagName\`: only meaningful with \`whenEvent: 'flag_set'\` — name of the flag that triggers this; blank/omitted matches any flag write.
- Always include \`message\`. For \`perception\`, include both \`passMessage\` and \`message\` (used as the fail message).
- A combat trigger should usually be a small region near the focal feature (e.g. throne, doorway) so the player walks into it. Don't make combat regions cover the entire map.
- Triggers must reference EXISTING monster/NPC ids — either from the CURRENT roster or from a roster you're proposing in the same response.

DESCRIPTION must end with a TRIGGERS BLOCK — whenever you propose a \`description\`, finish it with a clearly delimited section that describes the scripted beats in plain English so the author can review them. Format:

  …prose description…

  Triggers:
  1. Skeletons (T0 combat) start fighting when the player crosses the threshold of the central chamber.
  2. The innkeeper (T1 speech) greets the player on encounter start.
  3. A DC 13 Perception check (T2) at the altar reveals a hidden compartment.

Rules:
- Numbered prose list, narrative order, one line per trigger.
- Reference each \`triggerObjects\` entry by its id or by sequence (\`T0\`, \`T1\`, …) so the author can map prose ↔ trigger.
- If you propose no triggers and none seem needed, write \`Triggers: (none — this scene plays as freeform exploration).\`
- The TRIGGERS block must be the LAST thing in the description.

OUTPUT — emit ONLY the submit_refinement tool call. No code fences, no prose outside the tool.`;
}

function buildUserPrompt(req: RefineRequest, passability: string, width: number, height: number): string {
  const d = req.draft;
  const triggersBlock = d.triggers.length === 0
    ? "(none — this encounter has no scripted triggers yet)"
    : d.triggers.map((line) => `  ${line}`).join("\n");
  const fmtSpawn = (s: SpawnTile): string => `${s.index !== undefined ? `[${s.index}] ` : ""}(${s.x},${s.y})`;
  const fmtList = (items: SpawnTile[]): string => items.length === 0 ? "(none)" : items.map(fmtSpawn).join(", ");
  const fmtZone = (cells: Array<[number, number]>): string => cells.length === 0 ? "(none)" : `${cells.length} cells`;
  return `MAP — ${width} × ${height} tiles. Passability grid (top row first; '.' passable, '#' impassable):

${passability}

CURRENT DRAFT:

Title:                  ${d.title || "(empty)"}
Introduction:           ${d.introduction || "(empty)"}
Description (player):   ${d.description || "(empty)"}
AIGM Context:           ${d.aigmContext || "(empty)"}
Objective:              ${d.objective || "(empty)"}
Completion flag: ${d.completionFlag || "(empty)"}
Ally ids:        ${d.allyIds.length === 0 ? "(none)" : d.allyIds.join(", ")}
Enemy ids:       ${d.enemyIds.length === 0 ? "(none)" : d.enemyIds.join(", ")}
Neutral NPC ids: ${d.neutralIds.length === 0 ? "(none)" : d.neutralIds.join(", ")}

CURRENT SPAWNS (exact-mode placements; coordinate format (x,y)):
Player:    ${d.playerPlacement ? `(${d.playerPlacement.x},${d.playerPlacement.y})` : "(unset)"}
Enemies:   ${fmtList(d.enemyPlacements)}
Allies:    ${fmtList(d.allyPlacements)}
Neutrals:  ${fmtList(d.neutralPlacements)}

CURRENT ZONES (paint-mode fallback when no exact placement is set):
Player:    ${fmtZone(d.playerZones)}
Allies:    ${fmtZone(d.allyZones)}
Enemies:   ${fmtZone(d.enemyZones)}
Neutrals:  ${fmtZone(d.neutralZones)}

TRIGGERS (read-only one-line summaries — propose new triggers via \`triggerObjects\` if changes are needed):
${triggersBlock}

USER REQUEST:
${req.prompt}`;
}

function buildResponseTool() {
  const spawnSchema = {
    type: "object" as const,
    properties: {
      index: { type: "integer", minimum: 0, description: "0-based slot index into the matching role's id array. Omit for the player spawn (singleton)." },
      x:     { type: "integer", minimum: 0 },
      y:     { type: "integer", minimum: 0 },
    },
    required: ["x", "y"],
  };
  const triggerSchema = {
    type: "object" as const,
    properties: {
      id:         { type: "string", description: "snake_case slug, unique within this encounter." },
      whenEvent:  { type: "string", enum: ['player_moved', 'encounter_started', 'encounter_completed', 'flag_set'] },
      region:     {
        type: "object" as const,
        properties: {
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          w: { type: "integer", minimum: 1 },
          h: { type: "integer", minimum: 1 },
        },
        required: ["x", "y", "w", "h"],
      },
      kind:       { type: "string", enum: ['perception', 'log', 'aigm', 'combat', 'xp', 'announcement', 'speech', 'fade', 'set_flag'] },
      dc:         { type: "integer" },
      passMessage:{ type: "string" },
      message:    { type: "string" },
      defId:      { type: "string" },
      defIds:     { type: "array", items: { type: "string" } },
      xpAmount:   { type: "integer" },
      durationMs: { type: "integer" },
      entityRef:  { type: "string" },
      fadeMode:   { type: "string", enum: ['in', 'out', 'dim'] },
      announcementMode: { type: "string", enum: ['focused', 'unfocused'] },
      whenFlagName: { type: "string" },
      setFlagName:  { type: "string" },
    },
    required: ["id", "region", "kind", "message"],
  };
  return {
    name: "submit_refinement",
    description: "Submit a partial update to the encounter draft. Only include fields you actually want to change.",
    input_schema: {
      type: "object" as const,
      properties: {
        rationale:      { type: "string", description: "1-2 sentence explanation of what was changed and why." },
        title:          { type: "string" },
        introduction:   { type: "string" },
        description:    { type: "string", description: "Short player-facing card summary shown on the Single Encounter Setup screen. Maps to the encounter's description field." },
        aigmContext:    { type: "string", description: "Long-form AIGM scene context — grounding the GM reads silently. Maps to the encounter's customContext field." },
        objective:      { type: "string" },
        completionFlag: { type: "string", description: "snake_case slug, or empty string to clear." },
        allyIds:        { type: "array", items: { type: "string" } },
        enemyIds:       { type: "array", items: { type: "string" } },
        neutralIds:     { type: "array", items: { type: "string" } },
        playerSpawn:    { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" } }, required: ["x", "y"] },
        enemySpawns:    { type: "array", items: spawnSchema },
        allySpawns:     { type: "array", items: spawnSchema },
        neutralSpawns:  { type: "array", items: spawnSchema },
        triggerObjects: { type: "array", items: triggerSchema },
      },
      required: ["rationale"],
    },
  };
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateRefinement(
  p: RefinerPayload,
  validMonsterIds: Set<string>,
  validNpcIds: Set<string>,
  mapW: number,
  mapH: number,
  passability: string,
  effectiveAllyIds: string[],
  effectiveEnemyIds: string[],
  effectiveNeutralIds: string[],
): void {
  if (typeof p.rationale !== "string" || p.rationale.trim().length === 0) {
    throw new Error("Refinement missing rationale.");
  }
  if (p.completionFlag !== undefined && p.completionFlag !== "" && !/^[a-z0-9_]+$/.test(p.completionFlag)) {
    throw new Error(`completionFlag "${p.completionFlag}" must be snake_case (lowercase letters, digits, underscores).`);
  }
  // Spawn resolves NPC ids first, then monster ids (SpawnHelpers.spawnNpc),
  // so allyIds/enemyIds can carry either. Accept both rosters here — the
  // previous monster-only check rejected encounters that legitimately put
  // a named NPC in an ally/enemy slot (e.g. `frightened_traveller`).
  if (p.allyIds !== undefined) {
    for (const id of p.allyIds) if (!validMonsterIds.has(id) && !validNpcIds.has(id))
      throw new Error(`allyIds contains unknown id "${id}" (not in monster or NPC roster)`);
  }
  if (p.enemyIds !== undefined) {
    for (const id of p.enemyIds) if (!validMonsterIds.has(id) && !validNpcIds.has(id))
      throw new Error(`enemyIds contains unknown id "${id}" (not in monster or NPC roster)`);
  }
  if (p.neutralIds !== undefined) {
    for (const id of p.neutralIds) if (!validNpcIds.has(id) && !validMonsterIds.has(id))
      throw new Error(`neutralIds contains unknown id "${id}" (not in NPC or monster roster)`);
  }

  const passRows = passability.split("\n");
  const isPassable = (x: number, y: number): boolean => {
    if (y < 0 || y >= passRows.length) return false;
    const row = passRows[y];
    if (x < 0 || x >= row.length) return false;
    return row[x] === ".";
  };
  const inBounds = (x: number, y: number): boolean => x >= 0 && x < mapW && y >= 0 && y < mapH;
  const checkSpawn = (label: string, s: SpawnTile, expectedRoster: string[] | null): void => {
    if (!Number.isInteger(s.x) || !Number.isInteger(s.y)) throw new Error(`${label} has non-integer coordinates (${s.x}, ${s.y}).`);
    if (!inBounds(s.x, s.y)) throw new Error(`${label} coordinate (${s.x}, ${s.y}) is outside the map (${mapW}×${mapH}).`);
    if (!isPassable(s.x, s.y)) throw new Error(`${label} coordinate (${s.x}, ${s.y}) is on an impassable tile.`);
    if (expectedRoster !== null) {
      if (s.index === undefined) throw new Error(`${label} is missing required \`index\`.`);
      if (s.index < 0 || s.index >= expectedRoster.length) {
        throw new Error(`${label} index ${s.index} is out of range for a roster of ${expectedRoster.length}.`);
      }
    }
  };
  if (p.playerSpawn) checkSpawn("playerSpawn", p.playerSpawn, null);
  if (p.enemySpawns)   for (const s of p.enemySpawns)   checkSpawn(`enemySpawns[index=${s.index ?? "?"}]`,   s, effectiveEnemyIds);
  if (p.allySpawns)    for (const s of p.allySpawns)    checkSpawn(`allySpawns[index=${s.index ?? "?"}]`,    s, effectiveAllyIds);
  if (p.neutralSpawns) for (const s of p.neutralSpawns) checkSpawn(`neutralSpawns[index=${s.index ?? "?"}]`, s, effectiveNeutralIds);

  // Tile-uniqueness: no two spawns may land on the same cell.
  const seen = new Set<string>();
  const remember = (s: { x: number; y: number }, label: string): void => {
    const k = `${s.x},${s.y}`;
    if (seen.has(k)) throw new Error(`${label} stacks on an already-occupied tile (${s.x}, ${s.y}).`);
    seen.add(k);
  };
  if (p.playerSpawn)   remember(p.playerSpawn,   "playerSpawn");
  if (p.enemySpawns)   for (const s of p.enemySpawns)   remember(s, `enemySpawns[${s.index}]`);
  if (p.allySpawns)    for (const s of p.allySpawns)    remember(s, `allySpawns[${s.index}]`);
  if (p.neutralSpawns) for (const s of p.neutralSpawns) remember(s, `neutralSpawns[${s.index}]`);

  if (p.triggerObjects) {
    const validIds = new Set<string>();
    for (const t of p.triggerObjects) {
      if (!t.id || typeof t.id !== "string") throw new Error(`trigger missing id`);
      if (validIds.has(t.id)) throw new Error(`duplicate trigger id "${t.id}"`);
      validIds.add(t.id);
      if (!t.region) throw new Error(`trigger "${t.id}" missing region`);
      if (t.region.x < 0 || t.region.y < 0 || t.region.w < 1 || t.region.h < 1) throw new Error(`trigger "${t.id}" has invalid region`);
      if (t.region.x + t.region.w > mapW || t.region.y + t.region.h > mapH) throw new Error(`trigger "${t.id}" region extends past map edge`);
      if (!t.kind) throw new Error(`trigger "${t.id}" missing kind`);
      if (!t.message || typeof t.message !== "string") throw new Error(`trigger "${t.id}" missing message`);
      if (t.kind === "perception") {
        if (t.dc === undefined) throw new Error(`perception trigger "${t.id}" missing dc`);
        if (!t.passMessage) throw new Error(`perception trigger "${t.id}" missing passMessage`);
      } else if (t.kind === "combat") {
        if (!t.defIds || t.defIds.length === 0) throw new Error(`combat trigger "${t.id}" missing defIds (the monsters to flip)`);
        // The model occasionally produces slot-role refs (`neutral_1`,
        // `enemy_2`, `ally_1`) when it's been looking at `placements[]`
        // entries shaped `{ role: "neutral", index: 1 }`. Combat triggers
        // flip by `defId` (the underlying `set_disposition_by_def_id`
        // action keys on def, not on instance), so we resolve those slot
        // refs back to the def at that index — accepting either 1-based
        // (most natural for an LLM) or 0-based — and dedupe. Anything
        // unrecognisable falls through to the error path below.
        const slotRefRe = /^(enemy|neutral|ally)_(\d+)$/;
        const listFor = (role: string): string[] => role === "enemy" ? effectiveEnemyIds
                                                  : role === "neutral" ? effectiveNeutralIds
                                                  : effectiveAllyIds;
        const seen = new Set<string>();
        const resolved: string[] = [];
        for (const raw of t.defIds) {
          let id = raw;
          const m = raw.match(slotRefRe);
          if (m) {
            const list = listFor(m[1]);
            const n = parseInt(m[2], 10);
            if (n - 1 >= 0 && n - 1 < list.length) id = list[n - 1];
            else if (n >= 0 && n < list.length)   id = list[n];
          }
          if (!seen.has(id)) { seen.add(id); resolved.push(id); }
        }
        t.defIds = resolved;
        for (const id of t.defIds) {
          if (!effectiveEnemyIds.includes(id) && !effectiveNeutralIds.includes(id) && !validMonsterIds.has(id) && !validNpcIds.has(id)) {
            throw new Error(`combat trigger "${t.id}" references unknown id "${id}" — use a defId from the encounter roster (e.g. "bandit"), not a slot ref like "neutral_1" or a combat label like "enemy_A".`);
          }
        }
      } else if (t.kind === "speech") {
        if (!t.entityRef) throw new Error(`speech trigger "${t.id}" missing entityRef`);
        // Slot-ref → instance-id rewrite. The model occasionally produces
        // `neutral_1` / `enemy_2` / `ally_1` for npc_speaks.entity, looking
        // at the placements array. The runtime entity-ref resolver doesn't
        // understand those; map them to the matching `npc_<instanceId>`
        // using the shared `spawnInstanceIds` helper so the algorithm stays
        // in lockstep with SpawnHelpers.populateNpcs.
        const slotMatch = t.entityRef.match(/^(enemy|neutral|ally)_(\d+)$/);
        if (slotMatch) {
          const role = slotMatch[1] as 'enemy' | 'neutral' | 'ally';
          const n = parseInt(slotMatch[2], 10);
          const list = role === 'enemy' ? effectiveEnemyIds
                     : role === 'neutral' ? effectiveNeutralIds
                     : effectiveAllyIds;
          // Accept either 1-based (most natural for an LLM) or 0-based.
          const idx = n - 1 >= 0 && n - 1 < list.length ? n - 1
                    : n >= 0 && n < list.length ? n
                    : -1;
          if (idx < 0) {
            throw new Error(`speech trigger "${t.id}" entityRef "${t.entityRef}" — slot index ${n} is out of range for role "${role}" (size ${list.length})`);
          }
          const instanceId = instanceIdForSlot(role, idx, {
            allyIds: effectiveAllyIds,
            enemyIds: effectiveEnemyIds,
            npcIds: effectiveNeutralIds,
          });
          if (instanceId === null) {
            throw new Error(`speech trigger "${t.id}" entityRef "${t.entityRef}" — could not resolve to an instance id`);
          }
          t.entityRef = `npc_${instanceId}`;
        } else if (!/^(player|npc_[a-z0-9_]+|enemy_[A-Z]|ally_[A-Z])$/.test(t.entityRef)) {
          // Anything that's not a recognised entity-ref shape is almost
          // certainly an authoring mistake; surface it loudly rather than
          // letting it no-op at runtime.
          throw new Error(`speech trigger "${t.id}" entityRef "${t.entityRef}" is not a valid entity reference (expected "player", "npc_<id>", "enemy_<A-Z>", "ally_<A-Z>", or a slot ref like "neutral_1")`);
        }
      } else if (t.kind === "xp") {
        if (!t.xpAmount || t.xpAmount <= 0) throw new Error(`xp trigger "${t.id}" needs positive xpAmount`);
      } else if (t.kind === "fade") {
        if (!t.fadeMode) throw new Error(`fade trigger "${t.id}" missing fadeMode`);
      } else if (t.kind === "set_flag") {
        if (!t.setFlagName) throw new Error(`set_flag trigger "${t.id}" missing setFlagName`);
      }
    }
  }
}
