/**
 * Defs routes — read-only GETs that return whatever lives in `GameDefs`. The
 * Map Editor, character carousel, and every UI that needs the SRD catalog
 * fetches through these.
 *
 * `/encounters` and `/adventures` reload from disk on every request since
 * the editor scenes can author new files between requests; the rest are
 * straight reads off `getDefs()`.
 */
import type { FastifyInstance } from "fastify";
import { readFile, readdir, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { AppCtx } from "./ctx.js";
import { buildPlayerDef, type CharacterCreationChoices } from "../engine/CharacterBuilder.js";

async function readDir<T>(dir: string): Promise<T[]> {
  const files = await readdir(dir);
  return Promise.all(
    files.filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as T),
  );
}

export function registerDefsRoutes(server: FastifyInstance, ctx: AppCtx): void {
  const { getDefs, settingSubDir, loadDefs } = ctx;
  server.get("/characters",    async () => getDefs().playerDefs);

  // Character creation (US-122): build a complete PlayerDef from the player's
  // choices, persist it into the active setting's `characters/` dir so it joins
  // the roster on the next `loadDefs`, and return the created def.
  server.post("/characters", async (request, reply) => {
    const choices = request.body as CharacterCreationChoices;
    const defs = getDefs();
    const result = buildPlayerDef(choices, defs);
    if (!result.ok) return reply.code(400).send({ error: result.error });

    const dir = settingSubDir("characters");
    if (!dir) return reply.code(409).send({ error: "No active setting to save the character into." });
    await mkdir(dir, { recursive: true });

    // Ensure a unique id so two same-named characters don't overwrite.
    let id = result.playerDef.id;
    let n = 2;
    while (existsSync(join(dir, `${id}.json`))) id = `${result.playerDef.id}-${n++}`;
    const playerDef = { ...result.playerDef, id };

    await writeFile(join(dir, `${id}.json`), JSON.stringify(playerDef, null, 2));
    await loadDefs();
    return { playerDef };
  });

  // Delete a character definition from the active setting's `characters/` dir.
  // Only ids in the live roster are accepted, which keeps the id free of path
  // traversal. The session save (and NPC memory) is wiped separately by the
  // caller via `DELETE /save/:characterId`.
  server.delete("/characters/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const dir = settingSubDir("characters");
    if (!dir) return reply.code(409).send({ error: "No active setting to delete the character from." });
    if (!getDefs().playerDefs.some((p) => p.id === id)) return reply.code(404).send({ error: "Character not found." });
    await unlink(join(dir, `${id}.json`)).catch(() => { /* already gone */ });
    await loadDefs();
    return { ok: true };
  });
  server.get("/monsters",      async () => getDefs().monsters);
  server.get("/npcs",          async () => getDefs().npcs);
  server.get("/factions",      async () => getDefs().factions);
  server.get("/conversations", async () => getDefs().conversations);
  server.get("/equipment",     async () => getDefs().equipment);
  server.get("/feats",         async () => getDefs().feats);
  server.get("/backgrounds",   async () => getDefs().backgrounds);
  server.get("/species",       async () => getDefs().species);
  server.get("/spells",        async () => getDefs().spells);
  server.get("/features",      async () => getDefs().features);
  server.get("/quests",        async () => getDefs().quests);
  server.get("/classes",       async () => getDefs().classes);
  server.get("/subclasses",    async () => getDefs().subclasses);
  server.get("/maps",          async () => getDefs().maps);
  server.get("/health",        async () => ({ ok: true }));
  server.get("/encounters",    async () => {
    const dir = settingSubDir("encounters");
    return dir ? readDir(dir) : [];
  });
  server.get("/adventures",    async () => {
    const dir = settingSubDir("adventures");
    return dir ? readDir(dir) : [];
  });
}
