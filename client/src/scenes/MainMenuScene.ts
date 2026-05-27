import Phaser from "phaser";

/**
 * MainMenuScene — top-level entry point shown after Boot completes when there
 * is no active world save. Routes to either AdventureSetupScene (run a string
 * of encounters with persistent cross-chapter state) or EncounterSetupScene
 * (run a single one-off encounter).
 *
 * Kept deliberately minimal: title + two large buttons. Adding settings,
 * credits, etc. happens here in future.
 */
export class MainMenuScene extends Phaser.Scene {
  constructor() {
    super({ key: "MainMenuScene" });
  }

  create(): void {
    const w = this.scale.width;
    const h = this.scale.height;

    this.add.rectangle(0, 0, w, h, 0x0a0e1a).setOrigin(0, 0);

    this.add.text(w / 2, h * 0.22, "MyRPG", {
      fontFamily: "serif",
      fontSize: "72px",
      color: "#e8d8a8",
    }).setOrigin(0.5);

    this.add.text(w / 2, h * 0.32, "A browser RPG built on the SRD", {
      fontFamily: "serif",
      fontSize: "18px",
      color: "#8a8270",
    }).setOrigin(0.5);

    this.makeMenuButton(w / 2, h * 0.45, "ADVENTURE", "A string of encounters with overarching narrative", () => {
      this.scene.start("AdventureSetupScene");
    });

    this.makeMenuButton(w / 2, h * 0.59, "SINGLE ENCOUNTER", "Play a one-off scenario", () => {
      this.scene.start("EncounterSetupScene");
    });

    this.makeMenuButton(w / 2, h * 0.73, "GENERATE ENCOUNTER", "Describe a scene; the GM authors a one-off encounter just for you", () => {
      this.scene.start("GenerateSetupScene");
    });
  }

  private makeMenuButton(cx: number, cy: number, label: string, hint: string, onClick: () => void): void {
    const W = 460;
    const H = 92;
    const bg = this.add.rectangle(cx, cy, W, H, 0x1a2238)
      .setStrokeStyle(2, 0x4a6a9a)
      .setInteractive({ useHandCursor: true });

    const text = this.add.text(cx, cy - 14, label, {
      fontFamily: "sans-serif",
      fontSize: "26px",
      color: "#e8d8a8",
      fontStyle: "bold",
    }).setOrigin(0.5);

    this.add.text(cx, cy + 20, hint, {
      fontFamily: "sans-serif",
      fontSize: "14px",
      color: "#9aaad0",
    }).setOrigin(0.5);

    bg.on("pointerover", () => { bg.setFillStyle(0x243250); text.setColor("#fff4d8"); });
    bg.on("pointerout",  () => { bg.setFillStyle(0x1a2238); text.setColor("#e8d8a8"); });
    bg.on("pointerdown", onClick);
  }
}
