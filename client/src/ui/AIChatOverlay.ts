import Phaser from "phaser";
import {
  PLAYER_PANEL_WIDTH,
  GRID_COLS,
  GRID_ROWS,
  TILE_SIZE,
  TARGET_PANEL_WIDTH,
} from "../constants";
import { BaseOverlay } from "./BaseOverlay";

const DPR = window.devicePixelRatio;
const API_URL = "http://localhost:3000";
const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const GRID_H = GRID_ROWS * TILE_SIZE;
const LINE_H = 16; // game-unit line height: 11px font + 5px lineSpacing

export interface ChatPlayerState {
  name: string;
  className: string;
  level: number;
  hp: number;
  maxHp: number;
  xp: number;
  gold: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export class AIChatOverlay extends BaseOverlay {
  private readonly scene: Phaser.Scene;
  private historyText: Phaser.GameObjects.Text;
  private statusText: Phaser.GameObjects.Text;
  private inputText: Phaser.GameObjects.Text;
  private scrollThumb: Phaser.GameObjects.Rectangle;
  private maskShape: Phaser.GameObjects.Graphics;
  private inputValue = "";
  private history: ChatMessage[] = [];
  private thinking = false;
  private readonly npcName: string;
  private onFirstReply: () => void;
  private onFallback?: () => void;
  private firstReplySent = false;
  private scrollPos = 0;
  private readonly areaTop: number;
  private readonly areaBottom: number;
  private readonly visibleH: number;
  private keyHandler: (e: KeyboardEvent) => void;
  private wheelHandler: (e: WheelEvent) => void;

  constructor(
    scene: Phaser.Scene,
    npcId: string,
    npcName: string,
    playerState: ChatPlayerState,
    initialHistory: ChatMessage[],
    onFirstReply: () => void,
    onClose: (history: ChatMessage[]) => void,
    onFallback?: () => void,
  ) {
    super(scene, 580, 420, 0x9b59b6, () => {
      scene.input.keyboard?.enableGlobalCapture();
      window.removeEventListener("keydown", this.keyHandler);
      window.removeEventListener("wheel", this.wheelHandler);
      if (this.maskShape.active) this.maskShape.destroy();
      onClose(this.history);
    });

    this.scene = scene;
    this.npcName = npcName;
    this.onFirstReply = onFirstReply;
    this.onFallback = onFallback;
    this.history = [...initialHistory];

    scene.input.keyboard?.disableGlobalCapture();

    const panelW = this.panelW;
    const top = this.top;
    const historyAreaH = this.panelH - 150;

    // Visible text area in local (container-relative) coordinates.
    this.areaTop = top + 52;
    this.areaBottom = top + 48 + historyAreaH;
    this.visibleH = this.areaBottom - this.areaTop;

    const titleText = scene.add
      .text(0, top + 20, npcName, {
        fontSize: "15px",
        color: "#c39bd3",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const sep1 = scene.add.rectangle(0, top + 44, panelW - 32, 1, 0x334455);

    const historyBg = scene.add.rectangle(
      0,
      top + 44 + historyAreaH / 2 + 4,
      panelW - 32,
      historyAreaH,
      0x080812,
    );

    this.historyText = scene.add.text(
      -(panelW / 2 - 24),
      this.areaTop,
      "",
      {
        fontSize: "11px",
        color: "#ccddee",
        fontFamily: "monospace",
        resolution: DPR,
        wordWrap: { width: panelW - 56 },
        lineSpacing: 5,
      },
    );

    // Geometry mask clips historyText to the history area (world-space coords).
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

    // Scrollbar: track + thumb positioned inside the history area.
    const sbX = panelW / 2 - 20;
    const sbCY = (this.areaTop + this.areaBottom) / 2;
    const scrollTrack = scene.add
      .rectangle(sbX, sbCY, 4, this.visibleH, 0x1a1a2e)
      .setAlpha(0.8);
    this.scrollThumb = scene.add
      .rectangle(sbX, this.areaTop + 10, 4, 20, 0x9b59b6)
      .setAlpha(0.7)
      .setVisible(false);

    this.statusText = scene.add
      .text(0, top + this.panelH - 104, "", {
        fontSize: "10px",
        color: "#667788",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0);

    const sep2 = scene.add.rectangle(0, top + this.panelH - 90, panelW - 32, 1, 0x334455);

    const inputAreaY = top + this.panelH - 54;
    const sendBtnX = panelW / 2 - 60;
    const inputLeft = -(panelW / 2 - 24);
    const inputRight = sendBtnX - 56;
    const inputW = inputRight - inputLeft;
    const inputCX = inputLeft + inputW / 2;

    const inputBg = scene.add
      .rectangle(inputCX, inputAreaY, inputW, 30, 0x111122)
      .setStrokeStyle(1, 0x445566);

    this.inputText = scene.add
      .text(inputLeft + 6, inputAreaY, "█", {
        fontSize: "12px",
        color: "#e0e8f0",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0, 0.5);

    const sendBg = scene.add
      .rectangle(sendBtnX, inputAreaY, 96, 30, 0x2a1a4a)
      .setStrokeStyle(1, 0x9b59b6)
      .setInteractive({ useHandCursor: true });
    const sendLabel = scene.add
      .text(sendBtnX, inputAreaY, "SEND", {
        fontSize: "12px",
        color: "#c39bd3",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);
    sendBg.on("pointerover", () => sendBg.setAlpha(0.75));
    sendBg.on("pointerout",  () => sendBg.setAlpha(1));
    sendBg.on("pointerdown", () => this.send(npcId, playerState));

    this.container.add([
      titleText, sep1, historyBg,
      this.historyText, scrollTrack, this.scrollThumb,
      this.statusText, sep2,
      inputBg, this.inputText,
      sendBg, sendLabel,
    ]);

    if (this.history.length > 0) this.renderHistory();

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        this.send(npcId, playerState);
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
      } else if (e.key.length === 1 && this.inputValue.length < 200) {
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
    if (maxScroll <= 0) {
      this.scrollThumb.setVisible(false);
      return;
    }
    this.scrollThumb.setVisible(true);
    const thumbH = Math.max(20, (this.visibleH * this.visibleH) / textH);
    const thumbRange = this.visibleH - thumbH;
    const thumbCY = this.areaTop + (this.scrollPos / maxScroll) * thumbRange + thumbH / 2;
    this.scrollThumb.setSize(4, thumbH).setY(thumbCY);
  }

  private renderInput(): void {
    this.inputText.setText(this.inputValue + "█");
  }

  private async send(npcId: string, playerState: ChatPlayerState): Promise<void> {
    const text = this.inputValue.trim();
    if (!text || this.thinking) return;

    this.inputValue = "";
    this.renderInput();
    this.thinking = true;
    this.history.push({ role: "user", content: text });
    this.renderHistory();
    this.statusText.setText(`${this.npcName} is thinking…`);

    try {
      const res = await fetch(`${API_URL}/npc/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          npcId,
          playerMessage: text,
          history: this.history.slice(0, -1),
          playerState,
        }),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok || !data.reply) throw new Error(data.error ?? `HTTP ${res.status}`);
      this.history.push({ role: "assistant", content: data.reply });
      if (!this.firstReplySent) {
        this.firstReplySent = true;
        this.onFirstReply();
      }
    } catch {
      if (!this.firstReplySent && this.onFallback) {
        this.onFallback();
        return;
      }
      this.history.push({ role: "assistant", content: "(The NPC falls silent.)" });
    }

    this.thinking = false;
    this.statusText.setText("");
    this.renderHistory();
    this.scene.input.keyboard?.disableGlobalCapture();
  }

  private renderHistory(): void {
    const lines = this.history.map((m) =>
      m.role === "user" ? `> ${m.content}` : `  ${m.content}`,
    );
    this.historyText.setText(lines.join("\n"));
    // Always scroll to the bottom when a new message arrives.
    const textH = this.historyText.height;
    const maxScroll = Math.max(0, textH - this.visibleH);
    this.scrollPos = maxScroll;
    this.historyText.setY(this.areaTop - this.scrollPos);
    this.updateScrollThumb(textH, maxScroll);
  }
}
