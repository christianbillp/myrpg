import Phaser from "phaser";

const API_URL = "http://localhost:3000";

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: "BootScene" });
  }

  preload(): void {
    this.load.json("characters", `${API_URL}/characters`);
  }

  create(): void {
    this.registry.set("characters", this.cache.json.get("characters"));
    this.scene.start("EncounterSetupScene");
  }
}
