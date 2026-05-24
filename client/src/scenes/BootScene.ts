import Phaser from "phaser";
import { PlayerDef } from "../data/player";
import { gameClient } from "../net/GameClient";
import { ConnectionMonitor } from "../net/ConnectionMonitor";

const API_URL = "http://localhost:3000";
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
    this.load.json("maps",               `${API_URL}/maps`);
    this.load.json("encounters",          `${API_URL}/encounters`);
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
      this.registry.set("maps",               this.cache.json.get("maps"));
      this.registry.set("encounters",          this.cache.json.get("encounters"));

      const world = await gameClient.loadWorld();
      if (world) {
        const playerDef = (characters as PlayerDef[]).find(c => c.id === world.state.player.defId)
          ?? (characters as PlayerDef[])[0];
        gameClient.resumeSession(world.sessionId);
        this.scene.start("GameScene", { sessionId: world.sessionId, playerDef, dmHistory: world.dmHistory, isResume: true });
      } else {
        this.scene.start("EncounterSetupScene");
      }
    } catch {
      ConnectionMonitor.notifyDisconnected();
    }
  }
}
