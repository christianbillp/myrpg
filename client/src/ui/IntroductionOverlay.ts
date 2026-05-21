import Phaser from "phaser";
import { BaseOverlay } from "./BaseOverlay";
import { EncounterContext, EncounterType } from "../data/encounterContext";
import { PlayerDef } from "../data/player";

const DPR = window.devicePixelRatio;
const ACCENT = 0xe2b96f;

const TYPE_LABEL: Record<EncounterType, string> = {
  simple_combat:      "Combat",
  social_interaction: "Social Interaction",
  exploration:        "Exploration",
  ai_dialogue:        "AI Dialogue",
};

export class IntroductionOverlay extends BaseOverlay {
  constructor(
    scene: Phaser.Scene,
    encounterTypes: EncounterType[],
    player: PlayerDef,
    context: EncounterContext,
    onContinue: () => void,
  ) {
    super(scene, 680, 400, ACCENT, onContinue);

    const panelW = this.panelW;
    const top = this.top;
    const accentHex = "#" + ACCENT.toString(16).padStart(6, "0");

    const typeChips = encounterTypes.map((t) => TYPE_LABEL[t]).join("  ·  ");
    const typeLabel = scene.add
      .text(0, top + 20, typeChips, {
        fontSize: "10px",
        color: accentHex,
        fontFamily: "monospace",
        resolution: DPR,
        letterSpacing: 1,
      })
      .setOrigin(0.5, 0);

    const nameText = scene.add
      .text(0, top + 48, player.name, {
        fontSize: "20px",
        color: "#e8e8f8",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const classText = scene.add
      .text(0, top + 74, `${player.speciesName}  ·  ${player.className}`, {
        fontSize: "11px",
        color: "#556677",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const sep1 = scene.add.rectangle(0, top + 100, panelW - 40, 1, 0x334455);

    const introText = scene.add
      .text(0, top + 116, context.introduction, {
        fontSize: "13px",
        color: "#c8d8e8",
        fontFamily: "monospace",
        resolution: DPR,
        wordWrap: { width: panelW - 64 },
        lineSpacing: 7,
        align: "center",
      })
      .setOrigin(0.5, 0);

    const sep2 = scene.add.rectangle(0, top + 320, panelW - 40, 1, 0x334455);

    const btnY = top + 354;
    const btnBg = scene.add
      .rectangle(0, btnY, 200, 34, 0x1a1006)
      .setStrokeStyle(1, ACCENT)
      .setInteractive({ useHandCursor: true });
    const btnLabel = scene.add
      .text(0, btnY, "CONTINUE", {
        fontSize: "13px",
        color: accentHex,
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);
    btnBg.on("pointerover", () => btnBg.setAlpha(0.75));
    btnBg.on("pointerout",  () => btnBg.setAlpha(1));
    btnBg.on("pointerdown", () => this.close());

    this.container.add([
      typeLabel, nameText, classText, sep1,
      introText, sep2,
      btnBg, btnLabel,
    ]);
  }
}
