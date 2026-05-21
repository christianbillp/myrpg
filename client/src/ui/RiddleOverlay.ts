import Phaser from "phaser";
import { Riddle } from "../data/encounterContext";
import { PLAYER_PANEL_WIDTH, GRID_COLS, TILE_SIZE, TARGET_PANEL_WIDTH } from "../constants";
import { BaseOverlay } from "./BaseOverlay";

const DPR = window.devicePixelRatio;
const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;

export class RiddleOverlay extends BaseOverlay {
  constructor(
    scene: Phaser.Scene,
    npcName: string,
    riddle: Riddle,
    onAnswer: (correct: boolean) => void,
    onClose: () => void,
  ) {
    super(scene, 580, 400, 0xe2b96f, onClose);

    const panelW = this.panelW;
    const top = this.top;

    const title = scene.add
      .text(0, top + 24, "RIDDLE", {
        fontSize: "16px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const sep1 = scene.add.rectangle(0, top + 50, panelW - 40, 1, 0x334455);

    const prompt = scene.add
      .text(0, top + 62, `${npcName} says:`, {
        fontSize: "11px", color: "#667788", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const question = scene.add
      .text(0, top + 82, riddle.question, {
        fontSize: "14px", color: "#ccddef", fontFamily: "monospace", resolution: DPR,
        align: "center", lineSpacing: 6,
      })
      .setOrigin(0.5, 0);

    const btnW = panelW - 60;
    const btnH = 40;
    const btnStartY = top + 220;
    const btnGap = 52;

    const resultText = scene.add
      .text(0, top + 220, "", {
        fontSize: "14px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
        align: "center", lineSpacing: 6,
      })
      .setOrigin(0.5, 0)
      .setVisible(false);

    const closeBg = scene.add
      .rectangle(0, top + this.panelH - 36, 120, 32, 0x1a2a3a)
      .setStrokeStyle(1, 0x556677)
      .setInteractive({ useHandCursor: true })
      .setVisible(false);
    const closeLabel = scene.add
      .text(0, top + this.panelH - 36, "CLOSE", {
        fontSize: "12px", color: "#ffffff", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5)
      .setVisible(false);
    closeBg.on("pointerover", () => closeBg.setFillStyle(0x2a3a4a));
    closeBg.on("pointerout",  () => closeBg.setFillStyle(0x1a2a3a));
    closeBg.on("pointerdown", () => this.close());

    const answerBtns = riddle.options.map((label, i) => {
      const by = btnStartY + i * btnGap;
      const bg = scene.add
        .rectangle(0, 0, btnW, btnH, 0x1a2030)
        .setStrokeStyle(1, 0x445566);
      const txt = scene.add
        .text(0, 0, label, {
          fontSize: "13px", color: "#ffffff", fontFamily: "monospace", resolution: DPR,
        })
        .setOrigin(0.5);
      bg.setInteractive({ useHandCursor: true })
        .on("pointerover", () => bg.setFillStyle(0x2a3050))
        .on("pointerout",  () => bg.setFillStyle(0x1a2030))
        .on("pointerdown", () => {
          answerBtns.forEach((b) => b.destroy());
          const correct = i === riddle.correctIndex;
          resultText
            .setText(
              correct
                ? "Correct!\nThe villager rewards you with +10 GP."
                : "Wrong answer.\nThe villager shakes their head.",
            )
            .setColor(correct ? "#7ec87e" : "#cc7777")
            .setVisible(true);
          closeBg.setVisible(true);
          closeLabel.setVisible(true);
          onAnswer(correct);
        });
      return scene.add.container(0, by, [bg, txt]);
    });

    this.container.add([
      title, sep1, prompt, question,
      resultText, closeBg, closeLabel,
      ...answerBtns,
    ]);
  }
}
