import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { SavedMapDef } from "../net/types";
import type { MonsterDef, NPCDef } from "../data/monsters";
import { gameClient } from "../net/GameClient";
import { ConnectionMonitor } from "../net/ConnectionMonitor";
import { TILE_SIZE } from "../constants";
import { tokenAssetForPlayer, tokenAssetForMonster, tokenAssetForNpc } from "../data/tokens";

const API_URL = "http://localhost:3000";

/** Stable Phaser texture key for a server-served tileset image URL. */
export function tilesetTextureKey(imageUrl: string): string {
  return `tileset:${imageUrl}`;
}

/** Stable Phaser texture key for an entity's token SVG. The asset path comes
 *  from `PlayerDef.tokenAsset` / `MonsterDef.tokenAsset` / `NPCDef.tokenAsset`. */
export function tokenTextureKey(asset: string): string {
  return `token:${asset}`;
}
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
const abilityMod = (score: number) => Math.floor((score - 10) / 2);

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: "BootScene" });
  }

  preload(): void {
    this.load.on("loaderror", (file: { key: string; url: string }) => {
      this.add.text(20, 20, `Load error: ${file.key} (${file.url})`, {
        fontSize: "14px", color: "#ff4444", fontFamily: "monospace",
      });
    });
    this.load.json("characters",         `${API_URL}/characters`);
    this.load.json("monsters",           `${API_URL}/monsters`);
    this.load.json("npcs",               `${API_URL}/npcs`);
    this.load.json("equipment",          `${API_URL}/equipment`);
    this.load.json("feats",              `${API_URL}/feats`);
    this.load.json("backgrounds",        `${API_URL}/backgrounds`);
    this.load.json("species",            `${API_URL}/species`);
    this.load.json("spells",             `${API_URL}/spells`);
    this.load.json("features",           `${API_URL}/features`);
    this.load.json("maps",               `${API_URL}/maps`);
    this.load.json("encounters",          `${API_URL}/encounters`);
    this.load.json("adventures",          `${API_URL}/adventures`);
    this.load.json("tilesets",            `${API_URL}/tilesets`);
    this.load.json("tileLegend",          `${API_URL}/tilesets/legends`);
    this.load.json("factions",            `${API_URL}/factions`);
    this.load.json("conversations",       `${API_URL}/conversations`);
  }

  async create(): Promise<void> {
    try {
      const rawChars = this.cache.json.get("characters") as PlayerDef[];
      if (!rawChars) throw new Error("Failed to load /characters — check server is running on :3000");
      const characters = rawChars.map((c) => ({
        ...c,
        savingThrows: Object.fromEntries(
          ABILITIES.map((a) => [
            a,
            abilityMod(c[a]) + (c.savingThrowProficiencies?.includes(a) ? c.proficiencyBonus : 0),
          ]),
        ),
      }));
      this.registry.set("characters",         characters);
      this.registry.set("monsters",           this.cache.json.get("monsters"));
      this.registry.set("npcs",               this.cache.json.get("npcs"));
      this.registry.set("equipment",          this.cache.json.get("equipment"));
      this.registry.set("feats",              this.cache.json.get("feats"));
      this.registry.set("backgrounds",        this.cache.json.get("backgrounds"));
      this.registry.set("species",            this.cache.json.get("species"));
      this.registry.set("spells",             this.cache.json.get("spells"));
      this.registry.set("features",           this.cache.json.get("features"));
      this.registry.set("maps",               this.cache.json.get("maps"));
      this.registry.set("encounters",          this.cache.json.get("encounters"));
      this.registry.set("adventures",          this.cache.json.get("adventures"));
      this.registry.set("factions",            this.cache.json.get("factions"));
      this.registry.set("conversations",       this.cache.json.get("conversations") ?? []);
      // `tileLegend` is the per-tileset payload from /tilesets/legends — each
      // entry has its own LOCAL gid keys, so the client can keep scribble's
      // tile "1" distinct from water's tile "1". Used by the Map Editor's
      // EDIT tab. `tilesetMeta` is the simpler /tilesets summary (image url +
      // tile dimensions) used to render thumbnails.
      this.registry.set("tileLegend",         this.cache.json.get("tileLegend") ?? { tilesets: [] });
      this.registry.set("tilesetMeta",        this.cache.json.get("tilesets") ?? []);

      // Preload every spritesheet on the server (from /tilesets) so the map
      // preview overlay can render any composed map immediately — including
      // tilesets that no saved map references yet. Falls back to enumerating
      // each saved map's tilesets if the server endpoint is missing.
      const queued = new Set<string>();
      type TilesetDescriptor = { imageUrl: string; tilewidth: number; tileheight: number; margin: number; spacing: number };
      const allTilesets = (this.cache.json.get("tilesets") as TilesetDescriptor[] | null) ?? [];
      for (const ts of allTilesets) {
        const key = tilesetTextureKey(ts.imageUrl);
        if (queued.has(key)) continue;
        queued.add(key);
        this.load.spritesheet(key, `${API_URL}${ts.imageUrl}`, {
          frameWidth: ts.tilewidth,
          frameHeight: ts.tileheight,
          margin: ts.margin,
          spacing: ts.spacing,
        });
      }
      // Fallback: also enumerate tilesets referenced by saved maps, in case a
      // map points at a custom tileset the server's listing missed.
      const maps = this.cache.json.get("maps") as SavedMapDef[];
      for (const map of maps ?? []) {
        for (const ts of map.tilesets ?? []) {
          const key = tilesetTextureKey(ts.imageUrl);
          if (queued.has(key)) continue;
          queued.add(key);
          this.load.spritesheet(key, `${API_URL}${ts.imageUrl}`, {
            frameWidth: ts.tilewidth,
            frameHeight: ts.tileheight,
            margin: ts.margin,
            spacing: ts.spacing,
          });
        }
      }

      // Token SVGs — every PlayerDef and MonsterDef declares its asset path
      // explicitly; NPCs may declare their own or implicitly reuse their
      // monsterClass's. Rasterised at 2× the logical tile size so it stays
      // crisp on retina displays without looking pixellated when zoomed in.
      // `setDisplaySize` at render time scales the rasterised bitmap down to
      // the in-game token diameter.
      const tokenSize = TILE_SIZE * 2;
      const queueToken = (asset: string) => {
        const key = tokenTextureKey(asset);
        if (queued.has(key)) return;
        queued.add(key);
        this.load.svg(key, `${API_URL}${asset}`, { width: tokenSize, height: tokenSize });
      };
      for (const c of characters)                                              queueToken(tokenAssetForPlayer(c));
      for (const m of (this.cache.json.get("monsters") as MonsterDef[]) ?? []) queueToken(tokenAssetForMonster(m));
      for (const n of (this.cache.json.get("npcs")     as NPCDef[])     ?? []) {
        const asset = tokenAssetForNpc(n);
        if (asset) queueToken(asset);
      }

      if (queued.size > 0) {
        await new Promise<void>((resolve, reject) => {
          this.load.once("complete", resolve);
          this.load.once("loaderror", (file: { key: string; url: string }) =>
            reject(new Error(`Failed to load tileset ${file.key} (${file.url})`)),
          );
          this.load.start();
        });
      }

      const world = await gameClient.loadWorld();
      if (world) {
        const playerDef = (characters as PlayerDef[]).find(c => c.id === world.state.player.defId)
          ?? (characters as PlayerDef[])[0];
        gameClient.resumeSession(world.sessionId);
        this.scene.start("GameScene", { sessionId: world.sessionId, playerDef, gmHistory: world.gmHistory, isResume: true });
      } else {
        this.scene.start("MainMenuScene");
      }
    } catch {
      ConnectionMonitor.notifyDisconnected();
    }
  }
}
