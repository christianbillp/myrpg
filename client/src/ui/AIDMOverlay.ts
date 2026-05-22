import Phaser from "phaser";
import {
  PLAYER_PANEL_WIDTH,
  GRID_COLS,
  GRID_ROWS,
  TILE_SIZE,
  TARGET_PANEL_WIDTH,
} from "../constants";
import { BaseOverlay } from "./BaseOverlay";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type DMPersona = "regular" | "dev";

const DPR = window.devicePixelRatio;
const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const GRID_H = GRID_ROWS * TILE_SIZE;
const LINE_H = 16;
const ACCENT = 0xe2b96f;

export class AIDMOverlay extends BaseOverlay {
  private readonly scene: Phaser.Scene;
  private historyText: Phaser.GameObjects.Text;
  private statusText: Phaser.GameObjects.Text;
  private inputText: Phaser.GameObjects.Text;
  private scrollThumb: Phaser.GameObjects.Rectangle;
  private maskShape: Phaser.GameObjects.Graphics;
  private inputValue = "";
  private history: ChatMessage[] = [];
  private thinking = false;
  private scrollPos = 0;
  private readonly areaTop: number;
  private readonly areaBottom: number;
  private readonly visibleH: number;
  private keyHandler: (e: KeyboardEvent) => void;
  private wheelHandler: (e: WheelEvent) => void;
  private dmPersona: DMPersona;
  private readonly onSend: (playerMessage: string, history: ChatMessage[], dmPersona: DMPersona) => Promise<string>;

  constructor(
    scene: Phaser.Scene,
    initialHistory: ChatMessage[],
    initialPersona: DMPersona,
    onSend: (playerMessage: string, history: ChatMessage[], dmPersona: DMPersona) => Promise<string>,
    onClose: (history: ChatMessage[], persona: DMPersona) => void,
  ) {
    super(scene, 640, 480, ACCENT, () => {
      scene.input.keyboard?.enableGlobalCapture();
      window.removeEventListener("keydown", this.keyHandler);
      window.removeEventListener("wheel", this.wheelHandler);
      if (this.maskShape.active) this.maskShape.destroy();
      onClose(this.history, this.dmPersona);
    });

    this.dmPersona = initialPersona;
    this.onSend = onSend;
    this.scene = scene;
    this.history = [...initialHistory];

    scene.input.keyboard?.disableGlobalCapture();

    const panelW = this.panelW;
    const top = this.top;
    const historyAreaH = this.panelH - 160;

    this.areaTop = top + 52;
    this.areaBottom = top + 48 + historyAreaH;
    this.visibleH = this.areaBottom - this.areaTop;

    const titleText = scene.add
      .text(0, top + 20, "DUNGEON MASTER", {
        fontSize: "15px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const chipY = top + 27;
    const chipW = 56;
    const chipH = 18;
    const chipGap = 6;
    const chipRightEdge = panelW / 2 - 56;
    const chipDevX = chipRightEdge - chipW / 2;
    const chipStoryX = chipDevX - chipW - chipGap;

    const storyBg = scene.add.rectangle(chipStoryX, chipY, chipW, chipH, 0x1a1a00).setInteractive({ useHandCursor: true });
    const storyTxt = scene.add.text(chipStoryX, chipY, "STORY", { fontSize: "9px", fontFamily: "monospace", resolution: DPR }).setOrigin(0.5);
    const devBg = scene.add.rectangle(chipDevX, chipY, chipW, chipH, 0x001a00).setInteractive({ useHandCursor: true });
    const devTxt = scene.add.text(chipDevX, chipY, "DEV", { fontSize: "9px", fontFamily: "monospace", resolution: DPR }).setOrigin(0.5);

    const refreshChips = () => {
      storyBg.setStrokeStyle(1, this.dmPersona === "regular" ? ACCENT : 0x443300);
      storyTxt.setColor(this.dmPersona === "regular" ? "#e2b96f" : "#665533");
      devBg.setStrokeStyle(1, this.dmPersona === "dev" ? 0x44cc44 : 0x224422);
      devTxt.setColor(this.dmPersona === "dev" ? "#66ee66" : "#336633");
    };
    refreshChips();

    storyBg.on("pointerdown", () => { this.dmPersona = "regular"; refreshChips(); });
    devBg.on("pointerdown",   () => { this.dmPersona = "dev";     refreshChips(); });

    const sep1 = scene.add.rectangle(0, top + 44, panelW - 32, 1, 0x334455);

    const historyBg = scene.add.rectangle(0, top + 44 + historyAreaH / 2 + 4, panelW - 32, historyAreaH, 0x080812);

    this.historyText = scene.add.text(
      -(panelW / 2 - 24),
      this.areaTop,
      "",
      {
        fontSize: "11px", color: "#ccddee", fontFamily: "monospace", resolution: DPR,
        wordWrap: { width: panelW - 64 }, lineSpacing: 5,
      },
    );

    this.maskShape = scene.add.graphics();
    this.maskShape.fillStyle(0xffffff);
    this.maskShape.fillRect(
      W / 2 - (panelW - 32) / 2,
      GRID_H / 2 + top + 48,
      panelW - 32,
      historyAreaH,
    );
    this.maskShape.setVisible(false);
    this.historyText.setMask(this.maskShape.createGeometryMask());

    const sbX = panelW / 2 - 20;
    const sbCY = (this.areaTop + this.areaBottom) / 2;
    scene.add.rectangle(sbX, sbCY, 4, this.visibleH, 0x1a1a2e).setAlpha(0.8);
    this.scrollThumb = scene.add
      .rectangle(sbX, this.areaTop + 10, 4, 20, ACCENT)
      .setAlpha(0.7)
      .setVisible(false);

    this.statusText = scene.add
      .text(0, top + this.panelH - 112, "", {
        fontSize: "10px", color: "#b8960c", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const sep2 = scene.add.rectangle(0, top + this.panelH - 98, panelW - 32, 1, 0x334455);

    const inputAreaY = top + this.panelH - 60;
    const sendBtnX = panelW / 2 - 60;
    const inputLeft = -(panelW / 2 - 24);
    const inputRight = sendBtnX - 56;
    const inputW = inputRight - inputLeft;
    const inputCX = inputLeft + inputW / 2;

    const inputBg = scene.add.rectangle(inputCX, inputAreaY, inputW, 30, 0x111122).setStrokeStyle(1, 0x554422);

    this.inputText = scene.add
      .text(inputLeft + 6, inputAreaY, "█", {
        fontSize: "12px", color: "#e0d0a0", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0, 0.5);

    const sendBg = scene.add
      .rectangle(sendBtnX, inputAreaY, 96, 30, 0x2a1e08)
      .setStrokeStyle(1, ACCENT)
      .setInteractive({ useHandCursor: true });
    const sendLabel = scene.add
      .text(sendBtnX, inputAreaY, "SEND", {
        fontSize: "12px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
      })
      .setOrigin(0.5);
    sendBg.on("pointerover", () => sendBg.setAlpha(0.75));
    sendBg.on("pointerout",  () => sendBg.setAlpha(1));
    sendBg.on("pointerdown", () => this.send());

    this.container.add([
      titleText, storyBg, storyTxt, devBg, devTxt, sep1,
      historyBg, this.historyText, this.scrollThumb,
      this.statusText, sep2,
      inputBg, this.inputText,
      sendBg, sendLabel,
    ]);

    if (this.history.length > 0) this.renderHistory();

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        this.send();
      } else if (e.key === "Backspace") {
        this.inputValue = this.inputValue.slice(0, -1);
        this.renderInput();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        this.scroll(-1);
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        this.scroll(1);
        e.preventDefault();
      } else if (e.key.length === 1 && this.inputValue.length < 300) {
        this.inputValue += e.key;
        this.renderInput();
      }
    };
    window.addEventListener("keydown", this.keyHandler);

    this.wheelHandler = (e: WheelEvent) => {
      this.scroll(e.deltaY > 0 ? 3 : -3);
      e.preventDefault();
    };
    window.addEventListener("wheel", this.wheelHandler, { passive: false });
  }

  override destroy(): void {
    window.removeEventListener("keydown", this.keyHandler);
    window.removeEventListener("wheel", this.wheelHandler);
    if (this.maskShape.active) this.maskShape.destroy();
    this.scene.input.keyboard?.enableGlobalCapture();
    super.destroy();
  }

  private scroll(lines: number): void {
    const textH = this.historyText.height;
    const maxScroll = Math.max(0, textH - this.visibleH);
    this.scrollPos = Phaser.Math.Clamp(this.scrollPos + lines * LINE_H, 0, maxScroll);
    this.historyText.setY(this.areaTop - this.scrollPos);
    this.updateScrollThumb(textH, maxScroll);
  }

  private updateScrollThumb(textH: number, maxScroll: number): void {
    if (maxScroll <= 0) { this.scrollThumb.setVisible(false); return; }
    this.scrollThumb.setVisible(true);
    const thumbH = Math.max(20, (this.visibleH * this.visibleH) / textH);
    const thumbRange = this.visibleH - thumbH;
    const thumbCY = this.areaTop + (this.scrollPos / maxScroll) * thumbRange + thumbH / 2;
    this.scrollThumb.setSize(4, thumbH).setY(thumbCY);
  }

  private renderInput(): void {
    this.inputText.setText(this.inputValue + "█");
  }

  private async send(): Promise<void> {
    const text = this.inputValue.trim();
    if (!text || this.thinking) return;
    this.inputValue = "";
    this.renderInput();
    await this.sendText(text);
  }

  private async sendText(text: string): Promise<void> {
    if (this.thinking) return;
    this.thinking = true;
    this.history.push({ role: "user", content: text });
    this.renderHistory();
    this.statusText.setText("The Dungeon Master considers…");

    try {
      const reply = await this.onSend(text, this.history.slice(0, -1), this.dmPersona);
      this.history.push({ role: "assistant", content: reply });
    } catch {
      this.history.push({ role: "assistant", content: "(The Dungeon Master is silent.)" });
    }

    this.thinking = false;
    this.statusText.setText("");
    this.renderHistory();
    this.scene.input.keyboard?.disableGlobalCapture();
  }

  private renderHistory(): void {
    const lines = this.history.map(m =>
      m.role === "user" ? `> ${m.content}` : `  ${m.content}`,
    );
    this.historyText.setText(lines.join("\n"));
    const textH = this.historyText.height;
    const maxScroll = Math.max(0, textH - this.visibleH);
    this.scrollPos = maxScroll;
    this.historyText.setY(this.areaTop - this.scrollPos);
    this.updateScrollThumb(textH, maxScroll);
  }
}
