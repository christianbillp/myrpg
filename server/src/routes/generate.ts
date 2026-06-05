/**
 * Generate routes — the `/generate/*` HTTP endpoints that author maps and
 * encounters. Three flavours:
 *
 *   1. Deterministic compose (`/generate/map/composed`, `/generate/encounter/composed`)
 *      — `MapComposer` runs offline; no Claude call.
 *   2. AI-driven generate (`/generate/map`, `/generate/encounter`)
 *      — Claude authors the layout (Sonnet for full encounters).
 *   3. Cleanup (`DELETE /generate/maps/all`) — dev-mode wipe of every
 *      `gen_*` file in maps + encounters dirs.
 *
 * The module exports a `registerGenerateRoutes` function that closes over
 * the shared server-wide deps (live `defs`, `loadDefs`, anthropic client,
 * data dir). Extracted from `index.ts` to keep that file focused on boot,
 * defs loading, and websocket wiring.
 */
import type { FastifyInstance } from "fastify";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile, readFile, readdir, unlink } from "fs/promises";
import { join } from "path";
import { Logger } from "../Logger.js";
import { composeMap, type Terrain, type Feature } from "../engine/MapComposer.js";
import { writeMapJson, isGeneratedId } from "../engine/MapPersistence.js";
import { generateEncounter, generateMap } from "../encounterGenerator.js";
import { refineEncounter, type EncounterDraftForRefine } from "../encounterRefiner.js";
import { refineAdventure, type AdventureDraftForRefine, type EncounterPoolEntry } from "../adventureRefiner.js";
import { refineNpc, type NpcDraftForRefine } from "../npcRefiner.js";
import type { GameDefs } from "../engine/types.js";
import { STARTING_ZONE_PLAYER } from "../../../shared/startingZones.js";
import { safeId, asString, asArray } from "../util/requestValidation.js";

type EditorActionKind =
  | "perception" | "log" | "aigm" | "combat" | "xp"
  | "announcement" | "speech" | "fade" | "set_flag"
  | "enable_long_rest" | "disable_long_rest"
  | "hide_npc" | "kill_npc" | "open_conversation"
  | "set_companion";

/** One author-facing action. Same shape used for the trigger's primary
 *  action AND for each entry in `extraActions[]`. Every per-kind field is
 *  optional — the server consults only the fields relevant to `kind`. */
interface EditorComposedAction {
  kind: EditorActionKind;
  dc?: number;
  passMessage?: string;
  message?: string;
  defId?: string;
  defIds?: string[];
  xpAmount?: number;
  durationMs?: number;
  entityRef?: string;
  fadeMode?: "in" | "out" | "dim";
  announcementMode?: "focused" | "unfocused";
  setFlagName?: string;
  hidden?: boolean;
  hideDC?: number;
  revealedBy?: "perception" | "trigger";
  dropInventory?: boolean;
  corpseSearchDc?: number;
  corpseSearchSuccess?: string;
  corpseSearchFail?: string;
  npcRef?: string;
  conversationId?: string;
  /** `set_companion` only. When true the matching NPC is promoted to a
   *  companion (ally disposition + sim runner enabled); when false they
   *  drop back to `returnDisposition`. */
  isCompanion?: boolean;
  followMode?: "tight" | "loose";
  returnDisposition?: "neutral" | "ally" | "enemy";
}

interface EditorComposedTrigger extends EditorComposedAction {
  id: string;
  region: { x: number; y: number; w: number; h: number };
  whenEvent?: "player_moved" | "enter_zone" | "encounter_started" | "encounter_completed" | "flag_set";
  whenFlagName?: string;
  whenZone?: { name: string; cells: string[] };
  // Required-on-trigger versions of the fields that are optional on
  // ComposedAction — keeps the original schemas accepting payloads from
  // existing clients without breaking.
  dc: number;
  passMessage: string;
  message: string;
  defId: string;
  /** Additional consequences appended to the trigger's `then` array
   *  after the primary action's expansion. */
  extraActions?: EditorComposedAction[];
}

const sanitiseFlagName = (s: unknown): string => asString(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

/**
 * Expand a single author-facing action into one or more TriggerAction
 * entries. Called once for the trigger's primary action AND for each
 * entry in `extraActions[]`; the caller flat-concats the results into the
 * trigger's `then` array.
 *
 * Empty / unrecognised inputs return an empty array so the caller can
 * skip them without re-checking shape. This matches the legacy behaviour
 * of the per-trigger expansion (an `aigm` cue with empty message
 * silently produces no action).
 */
function expandComposedAction(a: EditorComposedAction): Record<string, unknown>[] {
  switch (a.kind) {
    case "perception": {
      const dc = a.dc ?? 10;
      const pass = (a.passMessage ?? "").trim();
      return [{
        type: "player_ability_check",
        skill: "perception",
        dc,
        onPass: pass ? [{ type: "show_log", message: pass }] : [],
        onFail: [],
      }];
    }
    case "log": {
      const msg = (a.message ?? "").trim();
      return msg ? [{ type: "show_log", message: msg }] : [];
    }
    case "aigm": {
      const msg = (a.message ?? "").trim();
      return msg ? [{ type: "send_aigm_message", message: msg }] : [];
    }
    case "combat": {
      const out: Record<string, unknown>[] = [];
      const flipIds = new Set<string>();
      const single = (a.defId ?? "").trim();
      if (single) flipIds.add(single);
      for (const id of a.defIds ?? []) if (id.trim()) flipIds.add(id.trim());
      for (const id of flipIds) out.push({ type: "set_disposition_by_def_id", defId: id, disposition: "enemy" });
      out.push({ type: "trigger_combat" });
      return out;
    }
    case "xp": {
      const amount = Math.max(0, Math.floor(a.xpAmount ?? 0));
      return amount > 0 ? [{ type: "award_xp", amount }] : [];
    }
    case "announcement": {
      const text = (a.message ?? "").trim();
      return text ? [{
        type: "show_announcement",
        text,
        ...(a.durationMs && a.durationMs > 0 ? { durationMs: a.durationMs } : {}),
        ...(a.announcementMode ? { mode: a.announcementMode } : {}),
      }] : [];
    }
    case "speech": {
      const text = (a.message ?? "").trim();
      const entity = (a.entityRef ?? "").trim();
      return (text && entity) ? [{ type: "npc_speaks", entity, text }] : [];
    }
    case "fade": {
      const mode = a.fadeMode ?? "out";
      return [{
        type: "fade_screen",
        mode,
        ...(a.durationMs && a.durationMs > 0 ? { durationMs: a.durationMs } : {}),
      }];
    }
    case "set_flag": {
      const flag = (a.setFlagName ?? "").trim();
      return flag ? [{ type: "set_flag", name: sanitiseFlagName(flag), value: true }] : [];
    }
    case "enable_long_rest":
      return [{ type: "set_long_rest", allowed: true }];
    case "disable_long_rest":
      return [{ type: "set_long_rest", allowed: false }];
    case "hide_npc": {
      const defId = (a.defId ?? "").trim();
      if (!defId) return [];
      return [{
        type: "set_npc_hidden",
        defId,
        hidden: a.hidden !== false,
        ...(typeof a.hideDC === "number" ? { hideDC: a.hideDC } : {}),
        ...(a.revealedBy ? { revealedBy: a.revealedBy } : {}),
      }];
    }
    case "kill_npc": {
      const defId = (a.defId ?? "").trim();
      if (!defId) return [];
      const obj: Record<string, unknown> = { type: "set_npc_dead", defId };
      if (a.dropInventory === false) obj.dropInventory = false;
      if (typeof a.corpseSearchDc === "number") {
        obj.corpseSearch = {
          dc: a.corpseSearchDc,
          successText: (a.corpseSearchSuccess ?? "").trim(),
          failureText: (a.corpseSearchFail ?? "").trim(),
        };
      }
      return [obj];
    }
    case "open_conversation": {
      const npcRef = (a.npcRef ?? "").trim();
      if (!npcRef) return [];
      const obj: Record<string, unknown> = { type: "start_conversation", npcRef };
      const conv = (a.conversationId ?? "").trim();
      if (conv) obj.conversationId = conv;
      return [obj];
    }
    case "set_companion": {
      const defId = (a.defId ?? "").trim();
      if (!defId) return [];
      const obj: Record<string, unknown> = {
        type: "set_npc_companion",
        defId,
        isCompanion: a.isCompanion !== false,
      };
      if (a.followMode) obj.followMode = a.followMode;
      if (a.returnDisposition) obj.returnDisposition = a.returnDisposition;
      return [obj];
    }
  }
}

/** Expand a composed trigger into a full EncounterTrigger shape. Walks the
 *  primary action's expansion first, then concatenates each `extraActions`
 *  entry's expansion in order. */
function expandComposedTrigger(t: EditorComposedTrigger, fallbackId: string): Record<string, unknown> {
  const baseId = t.id || fallbackId;
  const whenEvent = t.whenEvent ?? "player_moved";
  const when: Record<string, unknown> = whenEvent === "player_moved"
    ? { event: "player_moved", in_area: t.region }
    : whenEvent === "enter_zone"
      ? { event: "player_moved", in_zone: t.whenZone ?? { name: "", cells: [] } }
      : whenEvent === "flag_set"
        ? { event: "flag_set", ...(t.whenFlagName && t.whenFlagName.trim() ? { name: sanitiseFlagName(t.whenFlagName) } : {}) }
        : { event: whenEvent };
  // Enter-zone triggers are also movement-gated to the exploration phase.
  const guards = (whenEvent === "player_moved" || whenEvent === "enter_zone")
    ? [{ type: "phase" as const, in: ["exploring"] as const }]
    : [];
  const then = [
    ...expandComposedAction(t),
    ...(t.extraActions ?? []).flatMap((a) => expandComposedAction(a)),
  ];
  return { id: baseId, when, if: guards, then, once: true };
}

export interface GenerateRoutesCtx {
  anthropic: Anthropic;
  /** Live reference — read on every request so freshly-loaded defs are visible. */
  getDefs: () => GameDefs;
  /** Re-load all JSON-backed defs from disk. Awaited after every file write. */
  loadDefs: () => Promise<void>;
  /**
   * Path resolver for the active setting's data folder
   * (`<DATA_DIR>/settings/<active-id>`). Read fresh on each request so a
   * runtime setting switch is picked up without re-registering routes.
   * Throws when no setting is active — generation requires a setting because
   * the output is persisted under that setting's `maps/` + `encounters/`.
   */
  getSettingDataDir: () => string;
}

export function registerGenerateRoutes(server: FastifyInstance, ctx: GenerateRoutesCtx): void {
  const { anthropic, getDefs, loadDefs, getSettingDataDir } = ctx;
  const dataDir = (): string => getSettingDataDir();

  /**
   * Compose a map from deterministic toggles (terrain + features) — the
   * Adjudicator-layer alternative to the AI map generator. Pure preview —
   * the result is NOT persisted. Call `/generate/map/save` to write the
   * preview to disk and assign it a stable id.
   */
  server.post<{
    Body: { terrain: Terrain; features: Feature[]; width?: number; height?: number; seed?: number; buildingsCount?: number };
  }>("/generate/map/composed", async (req, reply) => {
    const { terrain, features, width = 30, height = 22, seed, buildingsCount } = req.body;
    if (!terrain || (terrain !== 'grassland' && terrain !== 'forest' && terrain !== 'dungeon' && terrain !== 'tavern')) {
      return reply.code(400).send({ error: "terrain must be 'grassland', 'forest', 'dungeon', or 'tavern'" });
    }
    try {
      const composed = composeMap({ width, height, terrain, features: features ?? [], seed, buildingsCount });
      return reply.send({
        mapId: null,
        width: composed.width,
        height: composed.height,
        terrainData: composed.terrainData,
        objectData: composed.objectData,
        name: composed.name,
        description: composed.description,
        tilesets: composed.tilesets,
        anchors: composed.anchors,
        zones: composed.zones ?? [],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_map_composed_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Persist a previously-composed map preview to disk and reload defs so the
   * new id is immediately referenceable by the encounter-compose flow. The
   * caller supplies the full grid data returned by `/generate/map/composed`.
   */
  server.post<{
    Body: {
      name: string;
      description: string;
      width: number;
      height: number;
      terrainData: number[];
      objectData: number[];
      tilesets?: Array<{ firstgid: number; source: string }>;
      /** Author-time named tile regions — see `MapZoneJson`. */
      zones?: Array<{ id: string; name: string; color: string; cells: string[] }>;
      /** When set, overwrite an existing map instead of allocating a fresh
       *  `gen_<stamp>_<slug>` id. Used by the Map Editor's LOAD MAP → edit
       *  → SAVE MAP flow. */
      existingMapId?: string;
    };
  }>("/generate/map/save", async (req, reply) => {
    const { name, description, width, height, terrainData, objectData, tilesets, zones, existingMapId } = req.body;
    if (!Array.isArray(terrainData) || terrainData.length !== width * height) {
      return reply.code(400).send({ error: `terrainData length ${terrainData?.length} ≠ width*height (${width * height})` });
    }
    try {
      let mapId: string;
      if (existingMapId) {
        mapId = safeId(existingMapId);
      } else {
        const stamp = Date.now();
        const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'map';
        mapId = safeId(`gen_${stamp}_${slug}`);
      }
      await writeMapJson(dataDir(), {
        id: mapId,
        name,
        description,
        width,
        height,
        terrainData,
        objectData,
        tilesets,
        zones,
      });
      await loadDefs();
      return reply.send({ mapId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_map_save_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Promote a generated encounter (and its `gen_*` map, if any) to a premade
   * id. Renames the JSON files under `server/data/{encounters,maps}/`, drops
   * the `generated: true` flag, and reloads defs. The new slug defaults to a
   * sanitised version of the encounter title; a numeric suffix is appended if
   * a premade with that slug already exists.
   */
  server.post<{
    Body: { encounterId: string; slug?: string };
  }>("/generate/encounter/promote", async (req, reply) => {
    const { encounterId, slug: requestedSlug } = req.body;
    if (!encounterId) return reply.code(400).send({ error: "encounterId is required" });
    if (!isGeneratedId(encounterId)) return reply.code(400).send({ error: `encounter "${encounterId}" is not generated — nothing to promote` });
    try {
      const encDir = join(dataDir(), "encounters");
      const mapDir = join(dataDir(), "maps");
      const encPath = join(encDir, `${safeId(encounterId)}.json`);
      const encJson = JSON.parse(await readFile(encPath, "utf-8")) as Record<string, unknown> & {
        id: string; encounterTitle?: string; mapId?: string; generated?: boolean;
      };

      // Decide the encounter's new slug. Prefer the caller-provided value when
      // given (sanitised); otherwise derive from the title.
      const sanitise = (s: string): string =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "encounter";
      const baseSlug = sanitise(requestedSlug ?? encJson.encounterTitle ?? encounterId);

      // Make sure the slug is unique. If `<slug>.json` already exists, append
      // a numeric suffix until we find a free name. Same check for the map.
      const existingEncounters = new Set((await readdir(encDir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));
      const existingMaps = new Set((await readdir(mapDir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")));
      let encSlug = baseSlug;
      for (let i = 2; existingEncounters.has(encSlug); i++) encSlug = `${baseSlug}_${i}`;

      // If the encounter references a generated map, promote it too — same
      // slug as the encounter, with a numeric suffix if the map slug clashes.
      const oldMapId = encJson.mapId;
      let newMapId = oldMapId;
      if (oldMapId && isGeneratedId(oldMapId)) {
        let mapSlug = baseSlug;
        for (let i = 2; existingMaps.has(mapSlug); i++) mapSlug = `${baseSlug}_${i}`;
        const mapPath = join(mapDir, `${oldMapId}.json`);
        const mapJson = JSON.parse(await readFile(mapPath, "utf-8")) as Record<string, unknown>;
        mapJson.id = mapSlug;
        await writeFile(join(mapDir, `${safeId(mapSlug)}.json`), JSON.stringify(mapJson, null, 2));
        await unlink(mapPath);
        newMapId = mapSlug;
      }

      // Rewrite the encounter: new id, point at the (possibly renamed) map,
      // drop the `generated` flag so it loses the GENERATED badge.
      encJson.id = encSlug;
      if (newMapId !== oldMapId) encJson.mapId = newMapId;
      delete encJson.generated;
      await writeFile(join(encDir, `${safeId(encSlug)}.json`), JSON.stringify(encJson, null, 2));
      await unlink(encPath);
      await loadDefs();
      return reply.send({ encounterId: encSlug, mapId: newMapId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_encounter_promote_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Compose a full encounter (map + encounter shell) deterministically — no
   * Claude call. Reuses an `existingMapId` when supplied (typical after the
   * COMPOSE MAP iterate-and-accept flow), otherwise composes a fresh map.
   * The encounter wrapper carries the painted `startingZonesData` plus the
   * caller's hand-picked `allyIds` + `enemyIds`.
   */
  server.post<{
    Body: {
      existingMapId?: string;
      terrain?: Terrain;
      features?: Feature[];
      width?: number;
      height?: number;
      seed?: number;
      buildingsCount?: number;
      /** Player-facing card summary (writes to the encounter's `description`). */
      description?: string;
      /** Long-form AIGM scene context (writes to `customContext`). */
      aigmContext?: string;
      startingZonesData?: number[];
      /** Optional placement mode (zones | exact). When 'exact', `placements` is used. */
      placementMode?: 'zones' | 'exact';
      /** Per-entity exact-tile bindings (see EncounterDef.placements). */
      placements?: import("../../../shared/types.js").EncounterPlacement[];
      allyIds?: string[];
      enemyIds?: string[];
      /** Creatures placed as NEUTRAL NPCs (do not auto-attack). Stored under `npcIds`. */
      neutralIds?: string[];
      /** Optional author-supplied encounter title. Overrides the map name when set. */
      customTitle?: string;
      /** Optional author-supplied custom introduction text shown to the player on encounter start. */
      customIntroduction?: string;
      /** Optional author-supplied one-line player-facing objective. Overrides the auto-derived default. */
      customObjective?: string;
      /** Optional author-supplied completion-flag slug. Overrides the default `<slug>_resolved`. */
      completionFlag?: string;
      /** Author-painted triggers: rectangular region + one of the action templates. Each is expanded to a full `EncounterTrigger`. */
      triggers?: EditorComposedTrigger[];
    };
  }>("/generate/encounter/composed", async (req, reply) => {
    const { existingMapId, terrain, features, width = 30, height = 22, seed, buildingsCount, description, aigmContext, startingZonesData, placementMode, placements, allyIds, enemyIds, neutralIds, customTitle, customIntroduction, customObjective, completionFlag, triggers: composedTriggers } = req.body;
    const defs = getDefs();
    const hasEnemies = (enemyIds ?? []).length > 0;
    try {
      let mapId: string;
      let mapWidth: number;
      let mapHeight: number;
      let terrainData: number[];
      let objectData: number[];
      let mapName: string;
      let mapDescription: string;
      let slug: string;

      if (existingMapId) {
        const existing = defs.maps.find((m) => m.id === existingMapId);
        if (!existing) {
          return reply.code(400).send({ error: `Unknown existingMapId "${existingMapId}"` });
        }
        mapId = existing.id;
        mapWidth = existing.cols;
        mapHeight = existing.rows;
        terrainData = existing.gidGrid.flat();
        objectData = existing.objectGidGrid?.flat() ?? new Array<number>(mapWidth * mapHeight).fill(0);
        mapName = existing.name ?? mapId;
        mapDescription = existing.mapdescription ?? "";
        slug = mapId.replace(/^gen_\d+_/, '').slice(0, 32) || 'scene';
      } else {
        if (!terrain || (terrain !== 'grassland' && terrain !== 'forest')) {
          return reply.code(400).send({ error: "terrain must be 'grassland' or 'forest'" });
        }
        const composed = composeMap({ width, height, terrain, features: features ?? [], seed, buildingsCount });
        const stamp = Date.now();
        slug = composed.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'scene';
        mapId = `gen_${stamp}_${slug}`;
        mapWidth = composed.width;
        mapHeight = composed.height;
        terrainData = composed.terrainData;
        objectData = composed.objectData;
        mapName = composed.name;
        mapDescription = composed.description;
        await writeMapJson(dataDir(), {
          id: mapId,
          name: composed.name,
          description: composed.description,
          width: composed.width,
          height: composed.height,
          terrainData: composed.terrainData,
          objectData: composed.objectData,
          tilesets: composed.tilesets,
          zones: composed.zones,
        });
      }

      const cells = mapWidth * mapHeight;
      // A player start is required: either a painted zone OR (in exact mode)
      // an explicit `player` placement. The /generate/encounter/update
      // endpoint already accepts both — this endpoint now matches.
      const hasPlayerPlacement = placementMode === 'exact'
        && (placements ?? []).some((p) => p.role === 'player');
      let zoneData: number[];
      if (Array.isArray(startingZonesData) && startingZonesData.length > 0) {
        if (startingZonesData.length !== cells) {
          return reply.code(400).send({ error: `startingZonesData length ${startingZonesData.length} ≠ width*height (${cells})` });
        }
        const hasPlayerZone = startingZonesData.some((z) => z === STARTING_ZONE_PLAYER);
        if (!hasPlayerZone && !hasPlayerPlacement) {
          return reply.code(400).send({ error: `startingZonesData must include at least one player-start cell (or a 'player' placement in exact mode)` });
        }
        zoneData = startingZonesData;
      } else if (hasPlayerPlacement) {
        // Exact-mode draft with no painted zones at all — that's fine; the
        // engine resolves the player placement from `placements` directly.
        // Persist an empty zone layer so the saved encounter doesn't carry
        // a stale auto-zone.
        zoneData = new Array<number>(cells).fill(0);
      } else {
        zoneData = new Array<number>(cells).fill(0);
        const legend = defs.tileLegend.tiles;
        for (let i = 0; i < terrainData.length; i++) {
          const gid = terrainData[i] & 0x1fffffff;
          const objGid = (objectData[i] ?? 0) & 0x1fffffff;
          const groundPassable = (legend[String(gid)] as { blocksMovement?: boolean } | undefined)?.blocksMovement === false;
          const objectPassable = objGid === 0 || (legend[String(objGid)] as { blocksMovement?: boolean } | undefined)?.blocksMovement === false;
          if (groundPassable && objectPassable) { zoneData[i] = STARTING_ZONE_PLAYER; break; }
        }
      }

      const validIds = new Set([...defs.monsters.map((m) => m.id), ...defs.npcs.map((n) => n.id)]);
      for (const id of [...(allyIds ?? []), ...(enemyIds ?? []), ...(neutralIds ?? [])]) {
        if (!validIds.has(id)) {
          return reply.code(400).send({ error: `Unknown creature id "${id}" — not in monsters/ or npcs/` });
        }
      }

      const stamp = Date.now();
      const encounterId = `gen_${stamp}_${slug}`;
      const sanitiseFlag = sanitiseFlagName;

      // Expand each author-painted trigger to a proper EncounterTrigger via
      // the shared `expandComposedTrigger` helper. The helper walks the
      // primary action AND each entry in `extraActions[]` so multi-action
      // triggers round-trip with all consequences.
      const triggers = (composedTriggers ?? []).map((t, i) =>
        expandComposedTrigger(t, `gen_trigger_${i + 1}`));

      const encounterJson = {
        id: encounterId,
        encounterTitle: asString(customTitle).trim() || mapName,
        // Player-facing card summary. Author's `description` wins; we fall
        // back to the map's mapdescription so generated encounters still
        // have something on the card before the author touches it.
        description: asString(description).trim() || mapDescription,
        mapId,
        npcIds: asArray<string>(neutralIds).filter((id) => validIds.has(id)),
        allyIds: asArray<string>(allyIds).filter((id) => validIds.has(id)),
        enemyIds: asArray<string>(enemyIds).filter((id) => validIds.has(id)),
        customIntroduction: asString(customIntroduction).trim(),
        customContext: asString(aigmContext).trim(),
        objective: asString(customObjective).trim() || (asString(aigmContext).trim() ? asString(aigmContext).trim().split(/[.!?]/)[0].slice(0, 80) : (hasEnemies ? "Defeat the hostile creatures." : "Explore the area.")),
        completionFlag: asString(completionFlag).trim() ? sanitiseFlag(completionFlag) : (hasEnemies ? undefined : `${slug}_resolved`),
        generated: true,
        startingZones: { width: mapWidth, height: mapHeight, data: zoneData },
        ...(placementMode === 'exact' ? { placementMode: 'exact' as const } : {}),
        ...(Array.isArray(placements) && placements.length > 0 ? { placements } : {}),
        ...(triggers.length > 0 ? { triggers } : {}),
      };

      await mkdir(join(dataDir(), 'encounters'), { recursive: true });
      await writeFile(join(dataDir(), 'encounters', `${encounterId}.json`), JSON.stringify(encounterJson, null, 2));
      await loadDefs();
      return reply.send({
        mapId,
        encounterId,
        width: mapWidth,
        height: mapHeight,
        terrainData,
        objectData,
        name: mapName,
        description: mapDescription,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_encounter_composed_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Update an existing encounter in place. Used by `EncounterEditorScene` —
   * the user opens an encounter, edits its title / story / monsters / zones /
   * triggers, and clicks SAVE ENCOUNTER. The endpoint rewrites the file at
   * `server/data/encounters/<encounterId>.json` preserving any fields not
   * exposed by the editor (e.g. `environment`, `tileProperties`, `generated`).
   *
   * Body mirrors `/generate/encounter/composed` minus map-composition fields
   * (the editor doesn't compose a new map — it reuses the encounter's `mapId`
   * by default, or accepts a new `existingMapId` if the user picked one in
   * the editor's map selector).
   */
  server.post<{
    Body: {
      encounterId: string;
      mapId?: string;
      /** Player-facing card summary (writes to the encounter's `description`). */
      description?: string;
      /** Long-form AIGM scene context (writes to `customContext`). */
      aigmContext?: string;
      startingZonesData?: number[];
      placementMode?: 'zones' | 'exact';
      placements?: import("../../../shared/types.js").EncounterPlacement[];
      allyIds?: string[];
      enemyIds?: string[];
      neutralIds?: string[];
      customTitle?: string;
      customIntroduction?: string;
      customObjective?: string;
      completionFlag?: string;
      triggers?: EditorComposedTrigger[];
    };
  }>("/generate/encounter/update", async (req, reply) => {
    const { encounterId, mapId: requestedMapId, description, aigmContext, startingZonesData, placementMode, placements, allyIds, enemyIds, neutralIds, customTitle, customIntroduction, customObjective, completionFlag, triggers: composedTriggers } = req.body;
    if (!encounterId) return reply.code(400).send({ error: "encounterId is required" });
    const defs = getDefs();
    try {
      const encDir = join(dataDir(), "encounters");
      const encPath = join(encDir, `${safeId(encounterId)}.json`);
      let existing: Record<string, unknown>;
      try {
        existing = JSON.parse(await readFile(encPath, "utf-8")) as Record<string, unknown>;
      } catch {
        return reply.code(404).send({ error: `encounter "${encounterId}" not found` });
      }

      // Resolve the map — caller may swap to a different saved map via the
      // editor's PICK MAP overlay; if omitted we keep the existing reference.
      const mapId = requestedMapId ?? (existing.mapId as string);
      const map = defs.maps.find((m) => m.id === mapId);
      if (!map) return reply.code(400).send({ error: `Unknown mapId "${mapId}"` });
      const mapWidth = map.cols;
      const mapHeight = map.rows;
      const cells = mapWidth * mapHeight;

      // Validate creature ids against the live def registry.
      const validIds = new Set([...defs.monsters.map((m) => m.id), ...defs.npcs.map((n) => n.id)]);
      for (const id of [...(allyIds ?? []), ...(enemyIds ?? []), ...(neutralIds ?? [])]) {
        if (!validIds.has(id)) return reply.code(400).send({ error: `Unknown creature id "${id}"` });
      }

      // Snake-case slug helper used both inside the trigger expansion below
      // and by the `completionFlag` write. Declared up here so the trigger
      // `set_flag` action can call it without hitting a TDZ error (it used
      // to be declared further down, which broke saves that included any
      // SET FLAG trigger).
      const sanitiseFlag = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

      // Starting zones — if omitted, preserve the existing layer; otherwise
      // require it to match the (possibly new) map's cell count. A player
      // start is required: in zones mode that means a painted PLAYER cell;
      // in exact mode an explicit `player` placement satisfies it instead.
      let zonesLayer: { width: number; height: number; data: number[] };
      if (Array.isArray(startingZonesData) && startingZonesData.length > 0) {
        if (startingZonesData.length !== cells) {
          return reply.code(400).send({ error: `startingZonesData length ${startingZonesData.length} ≠ width*height (${cells})` });
        }
        const hasPlayerZone = startingZonesData.some((z) => z === STARTING_ZONE_PLAYER);
        const hasPlayerPlacement = placementMode === 'exact'
          && (placements ?? []).some((p) => p.role === 'player');
        if (!hasPlayerZone && !hasPlayerPlacement) {
          return reply.code(400).send({ error: `startingZonesData must include at least one player-start cell (or a 'player' placement in exact mode)` });
        }
        zonesLayer = { width: mapWidth, height: mapHeight, data: startingZonesData };
      } else {
        zonesLayer = (existing.startingZones ?? { width: mapWidth, height: mapHeight, data: new Array<number>(cells).fill(0) }) as { width: number; height: number; data: number[] };
      }

      // Expand the editor's per-trigger blobs into full EncounterTriggers
      // via the shared helper (multi-action triggers round-trip via
      // `expandComposedTrigger` walking `extraActions[]`).
      const triggers = (composedTriggers ?? []).map((t, i) =>
        expandComposedTrigger(t, `edit_trigger_${i + 1}`));

      // Build the updated JSON — preserve all unrecognised top-level fields
      // (environment, tileProperties, generated, customContext from a prior
      // session, etc.) by spreading `existing` first and overwriting just the
      // editable slots.
      const updated: Record<string, unknown> = {
        ...existing,
        id: encounterId,
        mapId,
        startingZones: zonesLayer,
      };
      if (customTitle !== undefined)        updated.encounterTitle    = asString(customTitle).trim() || (existing.encounterTitle ?? encounterId);
      if (customIntroduction !== undefined) updated.customIntroduction = asString(customIntroduction).trim();
      if (aigmContext !== undefined)        updated.customContext     = asString(aigmContext).trim();
      if (description !== undefined)        updated.description       = asString(description).trim();
      if (customObjective !== undefined)    updated.objective         = asString(customObjective).trim() || (existing.objective ?? "Complete the encounter.");
      if (completionFlag !== undefined) {
        const cf = asString(completionFlag).trim();
        if (cf) updated.completionFlag = sanitiseFlag(cf);
        else delete updated.completionFlag;
      }
      if (allyIds    !== undefined) updated.allyIds = asArray<string>(allyIds).filter((id) => validIds.has(id));
      if (enemyIds   !== undefined) updated.enemyIds = asArray<string>(enemyIds).filter((id) => validIds.has(id));
      if (neutralIds !== undefined) updated.npcIds  = asArray<string>(neutralIds).filter((id) => validIds.has(id));
      if (placementMode !== undefined) {
        // Persist 'exact' explicitly; collapse 'zones' (the default) back to
        // omitting the field so existing-encounter JSON stays diff-clean.
        if (placementMode === 'exact') updated.placementMode = 'exact';
        else delete updated.placementMode;
      }
      if (placements !== undefined) {
        if (Array.isArray(placements) && placements.length > 0) updated.placements = placements;
        else delete updated.placements;
      }
      if (composedTriggers !== undefined) {
        // Editor-expressible action types — every action kind the
        // `TriggerEditor` can author through a chip (primary action OR
        // extraActions entry). Triggers whose `then` mixes ONLY these
        // types round-trip cleanly; anything else has at least one
        // action the editor would silently drop, and we preserve those
        // triggers verbatim so opening + saving doesn't nuke them.
        const editorExpressibleTypes = new Set([
          'player_ability_check', 'show_log', 'send_aigm_message',
          'award_xp', 'show_announcement', 'npc_speaks', 'fade_screen',
          'set_flag', 'set_long_rest',
          'set_npc_hidden', 'set_npc_dead', 'start_conversation',
          'set_npc_companion',
          // Combat editor kind expands to these two:
          'set_disposition_by_def_id', 'trigger_combat',
        ]);
        const isEditorExpressible = (t: import('../../../shared/types.js').EncounterTrigger): boolean => {
          if (t.then.length === 0) return false;
          // Every action must be one the editor knows how to author. The
          // `combat` template's two actions are covered by the same set,
          // so the "all members in set" check handles them automatically.
          if (!t.then.every((a) => editorExpressibleTypes.has(a.type))) return false;
          // `player_ability_check` only round-trips through the
          // `perception` editor chip — non-perception checks (history,
          // arcana, etc.) need to survive via the preservation path.
          for (const a of t.then) {
            if (a.type === 'player_ability_check' && a.skill !== 'perception') return false;
          }
          return true;
        };
        const existingTriggers = Array.isArray(existing.triggers) ? existing.triggers as import('../../../shared/types.js').EncounterTrigger[] : [];
        const preserved = existingTriggers.filter((t) => !isEditorExpressible(t));
        const finalTriggers = [...preserved, ...triggers];
        if (finalTriggers.length > 0) updated.triggers = finalTriggers;
        else delete updated.triggers;
      }

      await writeFile(encPath, JSON.stringify(updated, null, 2));
      await loadDefs();
      return reply.send({ encounterId, mapId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_encounter_update_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Generate just a map (no encounter wrapper) via Claude. Used by the
   * GENERATE MAP ONLY iterate-and-preview flow on `GenerateSetupScene`.
   */
  server.post<{
    Body: { prompt: string };
  }>("/generate/map", async (req, reply) => {
    const { prompt } = req.body;
    if (typeof prompt !== "string" || prompt.trim().length < 8) {
      return reply.code(400).send({ error: "prompt must be at least 8 characters" });
    }
    try {
      const result = await generateMap(anthropic, getDefs(), { prompt });
      await loadDefs();
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_map_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Generate a brand-new encounter (map + EncounterDef) via Claude Sonnet.
   * Validates GIDs, npcIds, allyIds, and startingZones against the live
   * rosters before persisting both files under the `gen_*` namespace.
   */
  server.post<{
    Body: { prompt: string; playerName?: string; playerClassName?: string };
  }>("/generate/encounter", async (req, reply) => {
    const { prompt, playerName, playerClassName } = req.body;
    if (typeof prompt !== "string" || prompt.trim().length < 8) {
      return reply.code(400).send({ error: "prompt must be at least 8 characters" });
    }
    try {
      const result = await generateEncounter(anthropic, getDefs(), { prompt, playerName, playerClassName });
      await loadDefs();
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_encounter_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Refine an in-progress encounter draft. Returns a partial patch
   * (only fields the model wants to change) plus a short rationale.
   * The frontend computes the diff vs the current draft and presents
   * Accept/Reject — nothing is persisted by this endpoint.
   */
  server.post<{
    Body: { draft: EncounterDraftForRefine; prompt: string };
  }>("/generate/encounter/refine", async (req, reply) => {
    const { draft, prompt } = req.body;
    if (!draft || typeof draft !== "object") {
      return reply.code(400).send({ error: "draft must be an object" });
    }
    if (typeof prompt !== "string" || prompt.trim().length < 4) {
      return reply.code(400).send({ error: "prompt must be at least 4 characters" });
    }
    try {
      const result = await refineEncounter(anthropic, getDefs(), { draft, prompt });
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_encounter_refine_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Refine an in-progress adventure draft. Mirrors the encounter refine route
   * shape: the model returns only the fields it wants to change plus a
   * rationale; the frontend computes the diff and presents Accept / Reject.
   * The encounter pool is built fresh from disk so newly authored encounters
   * are immediately pickable as chapters or rest stops.
   */
  server.post<{
    Body: { draft: AdventureDraftForRefine; prompt: string };
  }>("/generate/adventure/refine", async (req, reply) => {
    const { draft, prompt } = req.body;
    if (!draft || typeof draft !== "object") {
      return reply.code(400).send({ error: "draft must be an object" });
    }
    if (typeof prompt !== "string" || prompt.trim().length < 4) {
      return reply.code(400).send({ error: "prompt must be at least 4 characters" });
    }
    try {
      const pool = await loadEncounterPool();
      const result = await refineAdventure(anthropic, getDefs(), { draft, prompt, encounterPool: pool });
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_adventure_refine_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Refine an in-progress NPC draft. Same shape as the encounter / adventure
   * routes: the model returns the fields it wants to change plus a rationale.
   * The pool of valid monster ids, faction ids, and conversation ids is read
   * from `getDefs()` so freshly authored content is immediately referenceable.
   */
  server.post<{
    Body: { draft: NpcDraftForRefine; prompt: string };
  }>("/generate/npc/refine", async (req, reply) => {
    const { draft, prompt } = req.body;
    if (!draft || typeof draft !== "object") {
      return reply.code(400).send({ error: "draft must be an object" });
    }
    if (typeof prompt !== "string" || prompt.trim().length < 4) {
      return reply.code(400).send({ error: "prompt must be at least 4 characters" });
    }
    try {
      const defs = getDefs();
      const pool = {
        monsters: defs.monsters.map((m) => ({
          id: m.id,
          name: m.name,
          type: m.type ?? "—",
          cr: String(m.cr ?? "0"),
          hp: m.maxHp ?? 0,
        })),
        factions: defs.factions.map((f) => ({
          id: f.id,
          name: f.name,
          description: f.description ?? "",
        })),
        conversations: defs.conversations.map((c) => ({ id: c.id })),
      };
      const result = await refineNpc(anthropic, defs, { draft, prompt, pool });
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_npc_refine_failed", { error: msg }, "error");
      return reply.code(400).send({ error: msg });
    }
  });

  /** Read every `encounters/*.json` in the active setting and project to the
   *  one-line summaries the adventure refiner ships to the model. Filters out
   *  empty / unreadable files silently. */
  async function loadEncounterPool(): Promise<EncounterPoolEntry[]> {
    const dir = join(dataDir(), "encounters");
    let files: string[] = [];
    try { files = await readdir(dir); } catch { return []; }
    const out: EncounterPoolEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(dir, f), "utf-8");
        const enc = JSON.parse(raw) as {
          id: string;
          encounterTitle?: string;
          encounterTypes?: string[];
          description?: string;
        };
        if (!enc?.id) continue;
        out.push({
          id: enc.id,
          title: enc.encounterTitle ?? "",
          types: (enc.encounterTypes ?? []).join(","),
          description: enc.description ?? "",
        });
      } catch { /* skip unreadable file */ }
    }
    return out;
  }

  /**
   * Delete every generated map and encounter — the `gen_*` namespace. Used by
   * the dev-mode "Delete all generated maps" button. Hand-authored ids MUST
   * NOT begin with `gen_` (see `isGeneratedId` in MapPersistence) or they'd
   * be wiped here.
   */
  server.delete("/generate/maps/all", async (_req, reply) => {
    const mapsDir = join(dataDir(), "maps");
    const encDir = join(dataDir(), "encounters");
    let mapsDeleted = 0;
    let encountersDeleted = 0;
    try {
      const mapFiles = await readdir(mapsDir);
      for (const f of mapFiles) {
        if (isGeneratedId(f) && f.endsWith(".json")) {
          await unlink(join(mapsDir, f));
          mapsDeleted++;
        }
      }
      const encFiles = await readdir(encDir);
      for (const f of encFiles) {
        if (isGeneratedId(f) && f.endsWith(".json")) {
          await unlink(join(encDir, f));
          encountersDeleted++;
        }
      }
      await loadDefs();
      return reply.send({ mapsDeleted, encountersDeleted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.log("anomaly.generate_maps_all_failed", { error: msg }, "error");
      return reply.code(500).send({ error: msg });
    }
  });
}
