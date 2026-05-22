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

const DPR = window.devicePixelRatio;
const API_URL = "http://localhost:3000";
const W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const GRID_H = GRID_ROWS * TILE_SIZE;
const LINE_H = 16;
const ACCENT = 0xe2b96f;

export interface AIDMGameState {
  player: {
    name: string; className: string; level: number;
    hp: number; maxHp: number; xp: number; gold: number;
    ac: number; tileX: number; tileY: number; inventory: string[];
    hidden: boolean; actionUsed: boolean; bonusActionUsed: boolean;
    movesLeft: number; secondWindUses: number;
    equippedArmor: string | null; equippedWeapon: string | null; equippedShield: string | null;
    skills: Record<string, number>;
  };
  enemies: Array<{
    label?: string; id: string; name: string;
    hp: number; maxHp: number; ac: number;
    tileX: number; tileY: number; alive: boolean;
    isActive: boolean; vexed: boolean; hidden: boolean;
  }>;
  npcs: Array<{ id: string; name: string; tileX: number; tileY: number }>;
  selectedTarget?: { type: "enemy" | "npc"; name: string; id: string; label?: string };
  quests: Array<{ id: string; title: string; progress: number; target: number; completed: boolean }>;
  mapItems: Array<{ name: string; tileX: number; tileY: number }>;
  secretsRemaining: number;
  combatLog: string[];
  encounterTypes: string[];
  mapName: string;
  combatPhase: string;
}

export interface AIDMNpcPersona { id: string; name: string; persona: string; }

export interface AIDMAction { type: string; [key: string]: unknown; }

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

  constructor(
    scene: Phaser.Scene,
    getGameState: () => AIDMGameState,
    npcPersonas: AIDMNpcPersona[],
    encounterContext: string,
    initialHistory: ChatMessage[],
    onAction: (action: AIDMAction) => string | void,
    onClose: (history: ChatMessage[]) => void,
  ) {
    super(scene, 640, 480, ACCENT, () => {
      scene.input.keyboard?.enableGlobalCapture();
      window.removeEventListener("keydown", this.keyHandler);
      window.removeEventListener("wheel", this.wheelHandler);
      if (this.maskShape.active) this.maskShape.destroy();
      onClose(this.history);
    });

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

    const sep1 = scene.add.rectangle(0, top + 44, panelW - 32, 1, 0x334455);

    scene.add.rectangle(0, top + 44 + historyAreaH / 2 + 4, panelW - 32, historyAreaH, 0x080812);

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

    scene.add.rectangle(inputCX, inputAreaY, inputW, 30, 0x111122).setStrokeStyle(1, 0x554422);

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
    sendBg.on("pointerdown", () => this.send(getGameState, npcPersonas, encounterContext, onAction));

    this.container.add([
      titleText, sep1,
      this.historyText, this.scrollThumb,
      this.statusText, sep2,
      this.inputText,
      sendBg, sendLabel,
    ]);

    if (this.history.length > 0) this.renderHistory();

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        this.send(getGameState, npcPersonas, encounterContext, onAction);
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

  private async send(
    getGameState: () => AIDMGameState,
    npcPersonas: AIDMNpcPersona[],
    encounterContext: string,
    onAction: (action: AIDMAction) => string | void,
  ): Promise<void> {
    const text = this.inputValue.trim();
    if (!text || this.thinking) return;

    this.inputValue = "";
    this.renderInput();
    await this.sendText(text, getGameState, npcPersonas, encounterContext, onAction);
  }

  private async sendText(
    text: string,
    getGameState: () => AIDMGameState,
    npcPersonas: AIDMNpcPersona[],
    encounterContext: string,
    onAction: (action: AIDMAction) => string | void,
  ): Promise<void> {
    if (this.thinking) return;

    this.thinking = true;
    this.history.push({ role: "user", content: text });
    this.renderHistory();
    this.statusText.setText("The Dungeon Master considers…");

    const followUps: string[] = [];
    try {
      const res = await fetch(`${API_URL}/aidm/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerMessage: text,
          history: this.history.slice(0, -1),
          gameState: getGameState(),
          encounterContext,
          npcPersonas,
        }),
      });
      const data = (await res.json()) as { reply?: string; actions?: AIDMAction[]; error?: string };
      if (!res.ok || !data.reply) throw new Error(data.error ?? `HTTP ${res.status}`);

      for (const action of data.actions ?? []) {
        const followUp = onAction(action);
        if (followUp) followUps.push(followUp);
      }
      this.history.push({ role: "assistant", content: data.reply });
    } catch {
      this.history.push({ role: "assistant", content: "(The Dungeon Master is silent.)" });
    }

    this.thinking = false;
    this.statusText.setText("");
    this.renderHistory();
    this.scene.input.keyboard?.disableGlobalCapture();

    for (const followUp of followUps) {
      await this.sendText(followUp, getGameState, npcPersonas, encounterContext, onAction);
    }
  }

  private renderHistory(): void {
    const lines = this.history.map((m) =>
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
