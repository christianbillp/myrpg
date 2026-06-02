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
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import type { AppCtx } from "./ctx.js";

async function readDir<T>(dir: string): Promise<T[]> {
  const files = await readdir(dir);
  return Promise.all(
    files.filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as T),
  );
}

export function registerDefsRoutes(server: FastifyInstance, ctx: AppCtx): void {
  const { getDefs, settingSubDir } = ctx;
  server.get("/characters",    async () => getDefs().playerDefs);
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
