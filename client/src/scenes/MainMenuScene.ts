import Phaser from "phaser";
import { createHtmlButton, createHtmlText, type HtmlButtonHandle, type HtmlTextHandle } from "../ui/htmlButtons";

/**
 * MainMenuScene — top-level entry point shown after Boot completes when there
 * is no active world save. Routes to either AdventureSetupScene (run a string
 * of encounters with persistent cross-chapter state) or EncounterSetupScene
 * (run a single one-off encounter).
 *
 * Kept deliberately minimal: title + four large buttons. Adding settings,
 * credits, etc. happens here in future. All chrome is HTML so titles + button
 * labels stay crisp at non-integer canvas scale factors.
 */
export class MainMenuScene extends Phaser.Scene {
  private htmlTexts: HtmlTextHandle[] = [];
  private htmlButtons: HtmlButtonHandle[] = [];

  constructor() {
    super({ key: "MainMenuScene" });
  }

  create(): void {
    const w = this.scale.width;
    const h = this.scale.height;

    this.add.rectangle(0, 0, w, h, 0x0a0e1a).setOrigin(0, 0);

    this.htmlTexts.push(createHtmlText({
      scene: this, sceneWidth: w,
      x: 0, y: h * 0.22 - 50, w, h: 80,
      text: "MyRPG",
      fontFamily: "serif",
      fontSize: 72,
      color: "#e8d8a8",
      align: "center",
      fontWeight: "bold",
    }));

    this.htmlTexts.push(createHtmlText({
      scene: this, sceneWidth: w,
      x: 0, y: h * 0.32 - 12, w, h: 24,
      text: "A browser RPG built on the SRD",
      fontFamily: "serif",
      fontSize: 18,
      color: "#8a8270",
      align: "center",
    }));

    this.makeMenuButton(w / 2, h * 0.32, "ADVENTURE", "A string of encounters with overarching narrative", () => {
      this.scene.start("AdventureSetupScene");
    });

    this.makeMenuButton(w / 2, h * 0.40, "SINGLE ENCOUNTER", "Play a one-off scenario", () => {
      this.scene.start("EncounterSetupScene");
    });

    this.makeMenuButton(w / 2, h * 0.48, "MAP EDITOR", "Generate and save maps; the Encounter Creator picks them up", () => {
      this.scene.start("MapEditorScene");
    });

    this.makeMenuButton(w / 2, h * 0.56, "ENCOUNTER CREATOR", "Build an encounter manually or with AI assistance — title, monsters, zones, triggers", () => {
      this.scene.start("EncounterCreatorScene");
    });

    this.makeMenuButton(w / 2, h * 0.64, "ADVENTURE CREATOR", "String encounters into an adventure with overarching story, AI context, and a rest stop", () => {
      this.scene.start("AdventureCreatorScene");
    });

    this.makeMenuButton(w / 2, h * 0.72, "NPC CREATOR", "Author an NPC on top of an existing monster — name, faction, persona, token", () => {
      this.scene.start("NpcCreatorScene");
    });

    this.makeMenuButton(w / 2, h * 0.80, "TOKEN CREATOR", "Mix and match parts (hair, eyes, beard, …) to build an NPC token", () => {
      this.scene.start("TokenCreatorScene");
    });

    this.makeMenuButton(w / 2, h * 0.88, "CONFIGURATION", "Choose the active setting; future game-wide options live here", () => {
      this.scene.start("ConfigurationScene");
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
    this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
  }

  private makeMenuButton(cx: number, cy: number, label: string, hint: string, onClick: () => void): void {
    const W = 460;
    const H = 92;
    const w = this.scale.width;

    const btn = createHtmlButton({
      scene: this, sceneWidth: w,
      x: cx - W / 2, y: cy - H / 2, w: W, h: H,
      label,
      variant: "secondary",
      fontSize: 22,
      onClick,
    });
    // Override base styling: serif label, more padding, room for the hint.
    btn.el.style.fontFamily = "sans-serif";
    btn.el.style.fontWeight = "bold";
    btn.el.style.letterSpacing = "1px";
    btn.el.style.background = "#1a2238";
    btn.el.style.borderColor = "#4a6a9a";
    btn.el.style.color = "#e8d8a8";
    btn.el.style.display = "flex";
    btn.el.style.flexDirection = "column";
    btn.el.style.justifyContent = "center";
    btn.el.style.alignItems = "center";
    btn.el.style.gap = "6px";
    btn.el.textContent = "";

    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    labelEl.style.fontSize = "inherit";
    labelEl.style.color = "inherit";
    btn.el.appendChild(labelEl);

    const hintEl = document.createElement("span");
    hintEl.textContent = hint;
    hintEl.style.fontSize = "0.55em";
    hintEl.style.color = "#9aaad0";
    hintEl.style.fontWeight = "normal";
    hintEl.style.letterSpacing = "0";
    hintEl.style.whiteSpace = "normal";
    hintEl.style.textAlign = "center";
    hintEl.style.lineHeight = "1.3";
    btn.el.appendChild(hintEl);

    btn.el.addEventListener("mouseenter", () => { btn.el.style.background = "#243250"; labelEl.style.color = "#fff4d8"; });
    btn.el.addEventListener("mouseleave", () => { btn.el.style.background = "#1a2238"; labelEl.style.color = "#e8d8a8"; });

    this.htmlButtons.push(btn);
  }

  private teardown(): void {
    for (const t of this.htmlTexts) t.dispose();
    for (const b of this.htmlButtons) b.dispose();
    this.htmlTexts = [];
    this.htmlButtons = [];
  }
}
