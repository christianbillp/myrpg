import Phaser from "phaser";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "../constants";
import { CombatMode, LogEntry, LogEntryStyle } from "../net/types";
import { makeButton } from "./UIButton";
import { NpcToken } from "../entities/NpcToken";
import { PlayerDef } from "../data/player";
import { TurnOrderBar, TurnChip } from "./TurnOrderBar";

const GRID_H = GRID_ROWS * TILE_SIZE;
const GRID_W = GRID_COLS * TILE_SIZE;
const W = PLAYER_PANEL_WIDTH + GRID_W + TARGET_PANEL_WIDTH;
const DPR = window.devicePixelRatio;

const LOG_ROWS = 6;
const ROW_H = 14;

function styleColor(style?: LogEntryStyle): string {
  switch (style) {
    case 'hit':    return '#7ec8a0';
    case 'crit':   return '#ffe080';
    case 'kill':   return '#ff8888';
    case 'heal':   return '#88dd88';
    case 'status': return '#88aacc';
    case 'header': return '#ddeeff';
    case 'miss':   return '#667788';
    default:       return '#aabbcc';
  }
}

function styleColorDim(style?: LogEntryStyle): string {
  switch (style) {
    case 'hit':    return '#5a9070';
    case 'crit':   return '#b8a050';
    case 'kill':   return '#b86060';
    case 'heal':   return '#60a060';
    case 'status': return '#607890';
    case 'header': return '#99bbcc';
    case 'miss':   return '#445566';
    default:       return '#778899';
  }
}

export interface HUDState {
  mode: CombatMode;
  playerDef: PlayerDef;
  playerHp: number;
  movesLeft: number;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  playerHidden: boolean;
  playerConditions: string[];
  activeNpc: NpcToken | null;
  combatNpcs: NpcToken[];
  enemyVexed: boolean;
  enemyHidden: boolean;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
  combatLog: LogEntry[];
  logScrollOffset: number;
  selectedNpc: NpcToken | null;
  searchAvailable: boolean;
}

export interface HUDCallbacks {
  onOpenDM: () => void;
  onNewEncounter: () => void;
  onScrollLog: (dy: number) => void;
}

export class HUD {
  private readonly phaseText: Phaser.GameObjects.Text;
  private readonly enemyInfoText: Phaser.GameObjects.Text;
  private readonly logLeftTexts: Phaser.GameObjects.Text[];
  private readonly logRightTexts: Phaser.GameObjects.Text[];
  private readonly logScrollHint: Phaser.GameObjects.Text;
  private readonly turnOrderBar: TurnOrderBar;

  constructor(scene: Phaser.Scene, callbacks: HUDCallbacks) {
    const y = GRID_H;
    const cx = PLAYER_PANEL_WIDTH + GRID_W / 2;
    const lx = PLAYER_PANEL_WIDTH + 12;
    const rx = PLAYER_PANEL_WIDTH + GRID_W - 12;

    this.turnOrderBar = new TurnOrderBar(scene);

    scene.add.rectangle(W / 2, y + HUD_HEIGHT / 2, W, HUD_HEIGHT, 0x0d0d1e).setDepth(10);
    scene.add.rectangle(W / 2, y + 1, W, 2, 0x445566).setDepth(10);

    this.enemyInfoText = scene.add
      .text(W - 12, y + 10, "", { fontSize: "12px", color: "#e74c3c", fontFamily: "monospace", resolution: DPR })
      .setOrigin(1, 0).setDepth(11);

    this.phaseText = scene.add
      .text(cx, y + 10, "", { fontSize: "13px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR })
      .setOrigin(0.5, 0).setDepth(11);

    this.logLeftTexts = [];
    this.logRightTexts = [];
    for (let i = 0; i < LOG_ROWS; i++) {
      const rowY = y + 30 + i * ROW_H;
      this.logLeftTexts.push(
        scene.add.text(lx, rowY, "", { fontSize: "11px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR })
          .setDepth(11),
      );
      this.logRightTexts.push(
        scene.add.text(rx, rowY, "", { fontSize: "10px", color: "#778899", fontFamily: "monospace", resolution: DPR })
          .setOrigin(1, 0).setDepth(11),
      );
    }

    this.logScrollHint = scene.add
      .text(W - 12, y + 114, "", { fontSize: "10px", color: "#445566", fontFamily: "monospace", resolution: DPR })
      .setOrigin(1, 0).setDepth(12);

    const logZone = scene.add.zone(cx, y + 72, GRID_W, 90).setInteractive().setDepth(13);
    logZone.on("wheel", (_p: unknown, _dx: number, dy: number) => callbacks.onScrollLog(dy));

    makeButton(scene, PLAYER_PANEL_WIDTH + 80,  y + 10, "NEW ENCOUNTER", 0x2a1a1a, callbacks.onNewEncounter);
    makeButton(scene, W - TARGET_PANEL_WIDTH - 250, y + 10, "DUNGEON MASTER", 0x1a1020, callbacks.onOpenDM);
  }

  refresh(state: HUDState): void {
    this.refreshEnemyInfo(state);
    this.refreshTurnOrderBar(state);
    this.updateLogDisplay(state.combatLog, state.logScrollOffset);
    this.phaseText.setColor("#e2b96f");
    switch (state.mode) {
      case "exploring":    this.refreshExploring(state);   break;
      case "player_turn":  this.refreshPlayerTurn(state);  break;
      case "enemy_turn":   this.refreshEnemyTurn(state);   break;
      case "death_saves":  this.refreshDeathSaves(state);  break;
      case "defeat":       this.refreshDefeat(state);      break;
    }
  }

  private refreshEnemyInfo(state: HUDState): void {
    const displayNpc =
      state.selectedNpc && !state.selectedNpc.isDead()
        ? state.selectedNpc
        : state.activeNpc;
    if (displayNpc) {
      const isActive = displayNpc === state.activeNpc;
      const vexedPart = isActive && state.enemyVexed ? "  [VEXED]" : "";
      const hiddenPart = isActive && state.enemyHidden ? "  [HIDDEN]" : "";
      this.enemyInfoText.setText(
        `${displayNpc.def.name}  ${displayNpc.hp}/${displayNpc.maxHp} HP${hiddenPart}${vexedPart}`,
      );
    } else {
      this.enemyInfoText.setText("");
    }
  }

  private refreshTurnOrderBar(state: HUDState): void {
    const inCombat = state.mode !== "exploring" && state.combatNpcs.length > 0;
    this.turnOrderBar.setVisible(inCombat);
    if (!inCombat) return;
    const chips: TurnChip[] = [
      {
        label: "",
        name: state.playerDef.name,
        color: state.playerDef.color,
        isActive: state.mode === "player_turn" || state.mode === "death_saves",
        isDead: state.playerHp <= 0,
      },
      ...state.combatNpcs.map((n) => ({
        label: n.label,
        name: n.def.name,
        color: n.def.color,
        isActive: state.activeNpc === n,
        isDead: n.isDead(),
      })),
    ];
    this.turnOrderBar.refresh(chips);
  }

  private refreshExploring(state: HUDState): void {
    const hint = state.searchAvailable ? "  ·  search available" : "";
    this.phaseText.setText(`Exploring — WASD / arrow keys to move${hint}`);
  }

  private refreshPlayerTurn(state: HUDState): void {
    const hiddenLabel = state.playerHidden ? "  [HIDDEN]" : "";
    const condLabel   = state.playerConditions.filter(c => c !== 'dashing').map(c => `  [${c.toUpperCase()}]`).join("");
    const actedLabel  = state.actionUsed     ? "  · action used"  : "";
    const bonusLabel  = state.bonusActionUsed ? "  · bonus used"  : "";
    this.phaseText.setText(
      `Your turn — ${state.movesLeft}/${state.playerDef.speed} moves${hiddenLabel}${condLabel}${actedLabel}${bonusLabel}`,
    );
  }

  private refreshEnemyTurn(state: HUDState): void {
    const an = state.activeNpc;
    const labelPart = an?.label ? `${an.label} · ` : "";
    this.phaseText.setText(`${labelPart}${an?.def.name ?? "Enemy"}'s turn...`);
  }

  private refreshDeathSaves(state: HUDState): void {
    this.phaseText.setColor("#ff7777");
    this.phaseText.setText(
      `${state.playerDef.name} is unconscious!  ✓ ${state.deathSaveSuccesses}/3  ✗ ${state.deathSaveFailures}/3`,
    );
  }

  private refreshDefeat(state: HUDState): void {
    this.phaseText.setColor("#ff4444");
    this.phaseText.setText(
      state.deathSaveSuccesses >= 3 ? "💀 Stabilized — combat over." : "☠ You have died.",
    );
  }

  private updateLogDisplay(combatLog: LogEntry[], logScrollOffset: number): void {
    const total = combatLog.length;
    const offset = Math.min(logScrollOffset, Math.max(0, total - LOG_ROWS));
    const end = total - offset;
    const start = Math.max(0, end - LOG_ROWS);
    const visible = combatLog.slice(start, end);

    for (let i = 0; i < LOG_ROWS; i++) {
      const entry = visible[i];
      if (!entry) {
        this.logLeftTexts[i].setText("");
        this.logRightTexts[i].setText("");
        continue;
      }
      const color = styleColor(entry.style);
      const dimColor = styleColorDim(entry.style);
      this.logLeftTexts[i].setText(entry.left).setColor(color);
      this.logRightTexts[i].setText(entry.right ?? "").setColor(dimColor);
    }

    if (offset > 0) {
      this.logScrollHint.setText(`▼ ${offset} newer`);
    } else if (total > LOG_ROWS) {
      this.logScrollHint.setText("↑ scroll for history");
    } else {
      this.logScrollHint.setText("");
    }
  }
}
