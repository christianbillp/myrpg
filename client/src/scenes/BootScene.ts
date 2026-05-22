import Phaser from "phaser";
import { PlayerDef } from "../data/player";

const API_URL = "http://localhost:3000";
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
const abilityMod = (score: number) => Math.floor((score - 10) / 2);

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: "BootScene" });
  }

  preload(): void {
    this.load.json("characters",         `${API_URL}/characters`);
    this.load.json("monsters",           `${API_URL}/monsters`);
    this.load.json("npcs",               `${API_URL}/npcs`);
    this.load.json("items",              `${API_URL}/items`);
    this.load.json("maps",               `${API_URL}/maps`);
    this.load.json("premade-encounters", `${API_URL}/premade-encounters`);
  }

  create(): void {
    const rawChars = this.cache.json.get("characters") as PlayerDef[];
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
    this.registry.set("items",              this.cache.json.get("items"));
    this.registry.set("maps",               this.cache.json.get("maps"));
    this.registry.set("premade-encounters", this.cache.json.get("premade-encounters"));
    this.scene.start("EncounterSetupScene");
  }
}
