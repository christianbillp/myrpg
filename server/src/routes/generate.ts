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
import { composeMap, type Terrain, type Feature } from "../engine/MapComposer.js";
import { writeMapJson, isGeneratedId } from "../engine/MapPersistence.js";
import { generateEncounter, generateMap } from "../encounterGenerator.js";
import { refineEncounter, type EncounterDraftForRefine } from "../encounterRefiner.js";
import type { GameDefs } from "../engine/types.js";
import { STARTING_ZONE_PLAYER } from "../../../shared/startingZones.js";

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
    Body: { terrain: Terrain; features: Feature[]; width?: number; height?: number; seed?: number };
  }>("/generate/map/composed", async (req, reply) => {
    const { terrain, features, width = 30, height = 22, seed } = req.body;
    if (!terrain || (terrain !== 'grassland' && terrain !== 'forest' && terrain !== 'dungeon')) {
      return reply.code(400).send({ error: "terrain must be 'grassland', 'forest', or 'dungeon'" });
    }
    try {
      const composed = composeMap({ width, height, terrain, features: features ?? [], seed });
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
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[generate/map/composed] failed', msg);
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
      /** When set, overwrite an existing map instead of allocating a fresh
       *  `gen_<stamp>_<slug>` id. Used by the Map Editor's LOAD MAP → edit
       *  → SAVE MAP flow. */
      existingMapId?: string;
    };
  }>("/generate/map/save", async (req, reply) => {
    const { name, description, width, height, terrainData, objectData, tilesets, existingMapId } = req.body;
    if (!Array.isArray(terrainData) || terrainData.length !== width * height) {
      return reply.code(400).send({ error: `terrainData length ${terrainData?.length} ≠ width*height (${width * height})` });
    }
    try {
      let mapId: string;
      if (existingMapId) {
        mapId = existingMapId;
      } else {
        const stamp = Date.now();
        const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'map';
        mapId = `gen_${stamp}_${slug}`;
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
      });
      await loadDefs();
      return reply.send({ mapId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[generate/map/save] failed', msg);
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
      const encPath = join(encDir, `${encounterId}.json`);
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
        await writeFile(join(mapDir, `${mapSlug}.json`), JSON.stringify(mapJson, null, 2));
        await unlink(mapPath);
        newMapId = mapSlug;
      }

      // Rewrite the encounter: new id, point at the (possibly renamed) map,
      // drop the `generated` flag so it loses the GENERATED badge.
      encJson.id = encSlug;
      if (newMapId !== oldMapId) encJson.mapId = newMapId;
      delete encJson.generated;
      await writeFile(join(encDir, `${encSlug}.json`), JSON.stringify(encJson, null, 2));
      await unlink(encPath);
      await loadDefs();
      return reply.send({ encounterId: encSlug, mapId: newMapId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[generate/encounter/promote] failed', msg);
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
      description?: string;
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
      triggers?: Array<{
        id: string;
        region: { x: number; y: number; w: number; h: number };
        whenEvent?: "player_moved" | "encounter_started" | "encounter_completed" | "flag_set";
        kind:
          | "perception" | "log" | "aigm" | "combat" | "xp"
          | "announcement" | "speech" | "fade" | "set_flag"
          | "enable_long_rest" | "disable_long_rest";
        dc: number;
        passMessage: string;
        message: string;
        defId: string;
        /** Flag name the `flag_set` WHEN matcher listens for; blank = any. */
        whenFlagName?: string;
        /** Flag name the `set_flag` THEN action writes (always to `true`). */
        setFlagName?: string;
        /**
         * Optional list of def ids to flip to enemy alongside `defId` when a
         * `combat`-kind trigger fires. Used by the RANDOMIZE flow, which
         * spawns rolled monsters as neutral and needs the combat trigger to
         * flip every rolled type at once. Empty / undefined → only `defId`
         * is flipped (existing single-defId behavior).
         */
        defIds?: string[];
        /** Amount granted by an `xp` trigger. Defaults to 0 (no-op). */
        xpAmount?: number;
        /** Hold time (ms) for `supertitle` / `announcement`; fade time for `fade`. */
        durationMs?: number;
        /** Entity ref for `speech` (e.g. `player`, `npc_<id>`, `enemy_A`). */
        entityRef?: string;
        /** Direction for `fade`. */
        fadeMode?: "in" | "out" | "dim";
        announcementMode?: "focused" | "unfocused";
      }>;
    };
  }>("/generate/encounter/composed", async (req, reply) => {
    const { existingMapId, terrain, features, width = 30, height = 22, seed, description, startingZonesData, placementMode, placements, allyIds, enemyIds, neutralIds, customTitle, customIntroduction, customObjective, completionFlag, triggers: composedTriggers } = req.body;
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
        if (!terrain || (terrain !== 'grassland' && terrain !== 'forest' && terrain !== 'dungeon')) {
          return reply.code(400).send({ error: "terrain must be 'grassland', 'forest', or 'dungeon'" });
        }
        const composed = composeMap({ width, height, terrain, features: features ?? [], seed });
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
        });
      }

      const cells = mapWidth * mapHeight;
      // A player start is required: either a painted zone OR (in exact mode)
      // an explicit `player` placement. The /generate/encounter/update
      // endpoint already accepts both — this endpoint now matches.
      const hasPlayerPlacement = placementMode === 'exact'
        && (placements ?? []).some((p) => p.role === 'player');
      let zoneData: number[];
      if (startingZonesData && startingZonesData.length > 0) {
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
          const groundPassable = (legend[String(gid)] as { passable?: boolean } | undefined)?.passable === true;
          const objectPassable = objGid === 0 || (legend[String(objGid)] as { passable?: boolean } | undefined)?.passable === true;
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
      const sanitiseFlag = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

      // Expand each author-painted trigger to a proper EncounterTrigger. All
      // composed triggers fire on player_moved inside their region, gated on
      // the exploring phase, and use `once: true` so they're spent on first
      // entry. The body depends on the chosen action template.
      const triggers = (composedTriggers ?? []).map((t, i) => {
        const baseId = `${t.id || `gen_trigger_${i + 1}`}`;
        const whenEvent = t.whenEvent ?? 'player_moved';
        // `flag_set` listens on flag writes; optionally narrowed by name.
        // Region triggers use the painted rectangle; everything else fires on
        // a lifecycle event with no body shape.
        const when: Record<string, unknown> = whenEvent === 'player_moved'
          ? { event: 'player_moved', in_area: t.region }
          : whenEvent === 'flag_set'
            ? { event: 'flag_set', ...(t.whenFlagName && t.whenFlagName.trim() ? { name: sanitiseFlag(t.whenFlagName) } : {}) }
            : { event: whenEvent };
        // `phase: exploring` guard only applies to region-walk triggers —
        // lifecycle triggers fire on engine events, not phase transitions.
        const guards = whenEvent === 'player_moved'
          ? [{ type: 'phase' as const, in: ['exploring'] as const }]
          : [];
        let then: Record<string, unknown>[];
        switch (t.kind) {
          case 'perception':
            then = [{
              type: 'player_ability_check',
              skill: 'perception',
              dc: t.dc,
              onPass: t.passMessage.trim() ? [{ type: 'show_log', message: t.passMessage.trim() }] : [],
              onFail: [],
            }];
            break;
          case 'log':
            then = t.message.trim() ? [{ type: 'show_log', message: t.message.trim() }] : [];
            break;
          case 'aigm':
            then = t.message.trim() ? [{ type: 'send_aigm_message', message: t.message.trim() }] : [];
            break;
          case 'combat': {
            then = [];
            // Collect every defId to flip: the single legacy `defId` plus the
            // bulk `defIds` list the RANDOMIZE flow uses. De-dup so we don't
            // emit two flips for the same id when a hand-author types one
            // that also happens to be in the rolled bulk list.
            const flipIds = new Set<string>();
            if (t.defId.trim()) flipIds.add(t.defId.trim());
            for (const id of t.defIds ?? []) if (id.trim()) flipIds.add(id.trim());
            for (const id of flipIds) then.push({ type: 'set_disposition_by_def_id', defId: id, disposition: 'enemy' });
            then.push({ type: 'trigger_combat' });
            break;
          }
          case 'xp': {
            const amount = Math.max(0, Math.floor(t.xpAmount ?? 0));
            then = amount > 0 ? [{ type: 'award_xp', amount }] : [];
            break;
          }
          case 'announcement': {
            const text = t.message.trim();
            then = text ? [{
              type: 'show_announcement',
              text,
              ...(t.durationMs && t.durationMs > 0 ? { durationMs: t.durationMs } : {}),
              ...(t.announcementMode ? { mode: t.announcementMode } : {}),
            }] : [];
            break;
          }
          case 'speech': {
            const text = t.message.trim();
            const entity = (t.entityRef ?? '').trim();
            then = (text && entity) ? [{ type: 'npc_speaks', entity, text }] : [];
            break;
          }
          case 'fade': {
            const mode = t.fadeMode ?? 'out';
            then = [{
              type: 'fade_screen',
              mode,
              ...(t.durationMs && t.durationMs > 0 ? { durationMs: t.durationMs } : {}),
            }];
            break;
          }
          case 'set_flag': {
            const flag = (t.setFlagName ?? '').trim();
            then = flag ? [{ type: 'set_flag', name: sanitiseFlag(flag), value: true }] : [];
            break;
          }
          case 'enable_long_rest':
            then = [{ type: 'set_long_rest', allowed: true }];
            break;
          case 'disable_long_rest':
            then = [{ type: 'set_long_rest', allowed: false }];
            break;
        }
        return { id: baseId, when, if: guards, then, once: true };
      });

      const encounterJson = {
        id: encounterId,
        encounterTitle: customTitle?.trim() || mapName,
        description: mapDescription,
        mapId,
        npcIds: (neutralIds ?? []).filter((id) => validIds.has(id)),
        allyIds: (allyIds ?? []).filter((id) => validIds.has(id)),
        enemyIds: (enemyIds ?? []).filter((id) => validIds.has(id)),
        customIntroduction: customIntroduction?.trim() ?? "",
        customContext: description?.trim() ?? "",
        objective: customObjective?.trim() || (description?.trim() ? description.trim().split(/[.!?]/)[0].slice(0, 80) : (hasEnemies ? "Defeat the hostile creatures." : "Explore the area.")),
        completionFlag: completionFlag?.trim() ? sanitiseFlag(completionFlag) : (hasEnemies ? undefined : `${slug}_resolved`),
        generated: true,
        startingZones: { width: mapWidth, height: mapHeight, data: zoneData },
        ...(placementMode === 'exact' ? { placementMode: 'exact' as const } : {}),
        ...(placements && placements.length > 0 ? { placements } : {}),
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
      console.error('[generate/encounter/composed] failed', msg);
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
      description?: string;
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
      triggers?: Array<{
        id: string;
        region: { x: number; y: number; w: number; h: number };
        whenEvent?: "player_moved" | "encounter_started" | "encounter_completed" | "flag_set";
        kind:
          | "perception" | "log" | "aigm" | "combat" | "xp"
          | "announcement" | "speech" | "fade" | "set_flag"
          | "enable_long_rest" | "disable_long_rest";
        dc: number;
        passMessage: string;
        message: string;
        defId: string;
        /** Flag name the `flag_set` WHEN matcher listens for; blank = any. */
        whenFlagName?: string;
        /** Flag name the `set_flag` THEN action writes (always to `true`). */
        setFlagName?: string;
        defIds?: string[];
        xpAmount?: number;
        durationMs?: number;
        entityRef?: string;
        fadeMode?: "in" | "out" | "dim";
        announcementMode?: "focused" | "unfocused";
      }>;
    };
  }>("/generate/encounter/update", async (req, reply) => {
    const { encounterId, mapId: requestedMapId, description, startingZonesData, placementMode, placements, allyIds, enemyIds, neutralIds, customTitle, customIntroduction, customObjective, completionFlag, triggers: composedTriggers } = req.body;
    if (!encounterId) return reply.code(400).send({ error: "encounterId is required" });
    const defs = getDefs();
    try {
      const encDir = join(dataDir(), "encounters");
      const encPath = join(encDir, `${encounterId}.json`);
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

      // Starting zones — if omitted, preserve the existing layer; otherwise
      // require it to match the (possibly new) map's cell count. A player
      // start is required: in zones mode that means a painted PLAYER cell;
      // in exact mode an explicit `player` placement satisfies it instead.
      let zonesLayer: { width: number; height: number; data: number[] };
      if (startingZonesData && startingZonesData.length > 0) {
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
      // using the same logic as `/generate/encounter/composed`.
      const triggers = (composedTriggers ?? []).map((t, i) => {
        const baseId = `${t.id || `edit_trigger_${i + 1}`}`;
        const whenEvent = t.whenEvent ?? 'player_moved';
        const when: Record<string, unknown> = whenEvent === 'player_moved'
          ? { event: 'player_moved', in_area: t.region }
          : { event: whenEvent };
        const guards = whenEvent === 'player_moved'
          ? [{ type: 'phase' as const, in: ['exploring'] as const }]
          : [];
        let then: Record<string, unknown>[];
        switch (t.kind) {
          case 'perception':
            then = [{
              type: 'player_ability_check',
              skill: 'perception',
              dc: t.dc,
              onPass: t.passMessage.trim() ? [{ type: 'show_log', message: t.passMessage.trim() }] : [],
              onFail: [],
            }];
            break;
          case 'log':
            then = t.message.trim() ? [{ type: 'show_log', message: t.message.trim() }] : [];
            break;
          case 'aigm':
            then = t.message.trim() ? [{ type: 'send_aigm_message', message: t.message.trim() }] : [];
            break;
          case 'combat': {
            then = [];
            const flipIds = new Set<string>();
            if (t.defId.trim()) flipIds.add(t.defId.trim());
            for (const id of t.defIds ?? []) if (id.trim()) flipIds.add(id.trim());
            for (const id of flipIds) then.push({ type: 'set_disposition_by_def_id', defId: id, disposition: 'enemy' });
            then.push({ type: 'trigger_combat' });
            break;
          }
          case 'xp': {
            const amount = Math.max(0, Math.floor(t.xpAmount ?? 0));
            then = amount > 0 ? [{ type: 'award_xp', amount }] : [];
            break;
          }
          case 'announcement': {
            const text = t.message.trim();
            then = text ? [{
              type: 'show_announcement',
              text,
              ...(t.durationMs && t.durationMs > 0 ? { durationMs: t.durationMs } : {}),
              ...(t.announcementMode ? { mode: t.announcementMode } : {}),
            }] : [];
            break;
          }
          case 'speech': {
            const text = t.message.trim();
            const entity = (t.entityRef ?? '').trim();
            then = (text && entity) ? [{ type: 'npc_speaks', entity, text }] : [];
            break;
          }
          case 'fade': {
            const mode = t.fadeMode ?? 'out';
            then = [{
              type: 'fade_screen',
              mode,
              ...(t.durationMs && t.durationMs > 0 ? { durationMs: t.durationMs } : {}),
            }];
            break;
          }
          case 'set_flag': {
            const flag = (t.setFlagName ?? '').trim();
            then = flag ? [{ type: 'set_flag', name: sanitiseFlag(flag), value: true }] : [];
            break;
          }
          case 'enable_long_rest':
            then = [{ type: 'set_long_rest', allowed: true }];
            break;
          case 'disable_long_rest':
            then = [{ type: 'set_long_rest', allowed: false }];
            break;
        }
        return { id: baseId, when, if: guards, then, once: true };
      });

      const sanitiseFlag = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

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
      if (customTitle !== undefined)        updated.encounterTitle    = customTitle.trim() || (existing.encounterTitle ?? encounterId);
      if (customIntroduction !== undefined) updated.customIntroduction = customIntroduction.trim();
      if (description !== undefined)        updated.customContext     = description.trim();
      if (customObjective !== undefined)    updated.objective         = customObjective.trim() || (existing.objective ?? "Complete the encounter.");
      if (completionFlag !== undefined) {
        const cf = completionFlag.trim();
        if (cf) updated.completionFlag = sanitiseFlag(cf);
        else delete updated.completionFlag;
      }
      if (allyIds    !== undefined) updated.allyIds = allyIds.filter((id) => validIds.has(id));
      if (enemyIds   !== undefined) updated.enemyIds = enemyIds.filter((id) => validIds.has(id));
      if (neutralIds !== undefined) updated.npcIds  = neutralIds.filter((id) => validIds.has(id));
      if (placementMode !== undefined) {
        // Persist 'exact' explicitly; collapse 'zones' (the default) back to
        // omitting the field so existing-encounter JSON stays diff-clean.
        if (placementMode === 'exact') updated.placementMode = 'exact';
        else delete updated.placementMode;
      }
      if (placements !== undefined) {
        if (placements.length > 0) updated.placements = placements;
        else delete updated.placements;
      }
      if (composedTriggers !== undefined) {
        if (triggers.length > 0) updated.triggers = triggers;
        else delete updated.triggers;
      }

      await writeFile(encPath, JSON.stringify(updated, null, 2));
      await loadDefs();
      return reply.send({ encounterId, mapId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[generate/encounter/update] failed', msg);
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
    if (!prompt || prompt.trim().length < 8) {
      return reply.code(400).send({ error: "prompt must be at least 8 characters" });
    }
    try {
      const result = await generateMap(anthropic, getDefs(), { prompt });
      await loadDefs();
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[generate/map] failed", msg);
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
    if (!prompt || prompt.trim().length < 8) {
      return reply.code(400).send({ error: "prompt must be at least 8 characters" });
    }
    try {
      const result = await generateEncounter(anthropic, getDefs(), { prompt, playerName, playerClassName });
      await loadDefs();
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[generate/encounter] failed", msg);
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
    if (!prompt || prompt.trim().length < 4) {
      return reply.code(400).send({ error: "prompt must be at least 4 characters" });
    }
    try {
      const result = await refineEncounter(anthropic, getDefs(), { draft, prompt });
      return reply.send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[generate/encounter/refine] failed", msg);
      return reply.code(400).send({ error: msg });
    }
  });

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
      console.error("[generate/maps/all] failed", msg);
      return reply.code(500).send({ error: msg });
    }
  });
}
