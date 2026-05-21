import Phaser from "phaser";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "../constants";
import { CombatMode } from "../systems/EncounterManager";
import { Enemy } from "../entities/Enemy";
import { PlayerDef } from "../data/player";
import { EncounterType } from "../data/encounterContext";
import { TurnOrderBar, TurnChip } from "./TurnOrderBar";
import { chebyshev } from "../systems/EnemyAI";

const GRID_H = GRID_ROWS * TILE_SIZE;
const GRID_W = GRID_COLS * TILE_SIZE;
const W = PLAYER_PANEL_WIDTH + GRID_W + TARGET_PANEL_WIDTH;
const DPR = window.devicePixelRatio;

export interface HUDState {
  mode: CombatMode;
  playerDef: PlayerDef;
  playerHp: number;
  movesLeft: number;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  playerHidden: boolean;
  secondWindUses: number;
  activeEnemy: Enemy | null;
  combatEnemies: Enemy[];
  enemyVexed: boolean;
  enemyHidden: boolean;
  deathSaveSuccesses: number;
  deathSaveFailures: number;
  combatLog: string[];
  logScrollOffset: number;
  selectedEnemy: Enemy | null;
  playerTileX: number;
  playerTileY: number;
  encounterTypes: EncounterType[];
  secretsRemaining: number;
}

export interface HUDCallbacks {
  onAttack: () => void;
  onHide: () => void;
  onSecondWind: () => void;
  onEndTurn: () => void;
  onDeathSave: () => void;
  onSearch: () => void;
  onCommunicate: () => void;
  onResetView: () => void;
  onNewEncounter: () => void;
  onScrollLog: (dy: number) => void;
}

export class HUD {
  private readonly phaseText: Phaser.GameObjects.Text;
  private readonly enemyInfoText: Phaser.GameObjects.Text;
  private readonly logText: Phaser.GameObjects.Text;
  private readonly logScrollHint: Phaser.GameObjects.Text;
  private readonly turnOrderBar: TurnOrderBar;
  private readonly attackBtn: Phaser.GameObjects.Container;
  private readonly secondWindBtn: Phaser.GameObjects.Container;
  private readonly hideBtn: Phaser.GameObjects.Container;
  private readonly endTurnBtn: Phaser.GameObjects.Container;
  private readonly deathSaveBtn: Phaser.GameObjects.Container;
  private readonly searchBtn: Phaser.GameObjects.Container;
  private readonly communicateBtn: Phaser.GameObjects.Container;

  constructor(scene: Phaser.Scene, callbacks: HUDCallbacks) {
    const y = GRID_H;
    const cx = PLAYER_PANEL_WIDTH + GRID_W / 2;
    const lx = PLAYER_PANEL_WIDTH + 12;
    const btnY = y + 148;

    this.turnOrderBar = new TurnOrderBar(scene);

    scene.add.rectangle(W / 2, y + HUD_HEIGHT / 2, W, HUD_HEIGHT, 0x0d0d1e).setDepth(10);
    scene.add.rectangle(W / 2, y + 1, W, 2, 0x445566).setDepth(10);

    this.enemyInfoText = scene.add
      .text(W - 12, y + 10, "", { fontSize: "12px", color: "#e74c3c", fontFamily: "monospace", resolution: DPR })
      .setOrigin(1, 0).setDepth(11);

    this.phaseText = scene.add
      .text(cx, y + 10, "", { fontSize: "13px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR })
      .setOrigin(0.5, 0).setDepth(11);

    this.logText = scene.add
      .text(lx, y + 30, "", { fontSize: "11px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, wordWrap: { width: GRID_W - 24 }, lineSpacing: 4 })
      .setDepth(11);

    this.logScrollHint = scene.add
      .text(W - 12, y + 114, "", { fontSize: "10px", color: "#445566", fontFamily: "monospace", resolution: DPR })
      .setOrigin(1, 0).setDepth(12);

    const logZone = scene.add.zone(cx, y + 72, GRID_W, 90).setInteractive().setDepth(13);
    logZone.on("wheel", (_p: unknown, _dx: number, dy: number) => callbacks.onScrollLog(dy));

    scene.add.rectangle(W / 2, y + 122, W, 1, 0x334455).setDepth(11);

    HUD.makeButton(scene, PLAYER_PANEL_WIDTH + 80,  y + 10, "RESET VIEW",    0x1a2a3a, callbacks.onResetView);
    HUD.makeButton(scene, PLAYER_PANEL_WIDTH + 250, y + 10, "NEW ENCOUNTER", 0x2a1a1a, callbacks.onNewEncounter);

    this.attackBtn    = HUD.makeButton(scene, PLAYER_PANEL_WIDTH + 130, btnY, "ATTACK",          0x1a4a1e, callbacks.onAttack);
    this.secondWindBtn = HUD.makeButton(scene, cx,                       btnY, "SECOND WIND",     0x1a3a5a, callbacks.onSecondWind);
    this.hideBtn      = HUD.makeButton(scene, cx,                       btnY, "HIDE",             0x1a3a1a, callbacks.onHide);
    this.endTurnBtn   = HUD.makeButton(scene, W - 130,                  btnY, "END TURN",         0x3a3020, callbacks.onEndTurn);
    this.deathSaveBtn = HUD.makeButton(scene, cx,                       btnY, "ROLL DEATH SAVE",  0x5a1a1a, callbacks.onDeathSave);
    this.searchBtn    = HUD.makeButton(scene, W - 130,                  btnY, "SEARCH",           0x1a2a3a, callbacks.onSearch);
    this.communicateBtn = HUD.makeButton(scene, cx,                     btnY, "COMMUNICATE",      0x2a1a3a, callbacks.onCommunicate);
  }

  refresh(state: HUDState): void {
    // Enemy info text (prefer selected if alive, else active)
    const displayEnemy =
      state.selectedEnemy && !state.selectedEnemy.isDead()
        ? state.selectedEnemy
        : state.activeEnemy;
    if (displayEnemy) {
      const isActive = displayEnemy === state.activeEnemy;
      const vexedPart = isActive && state.enemyVexed ? "  [VEXED]" : "";
      const hiddenPart = isActive && state.enemyHidden ? "  [HIDDEN]" : "";
      this.enemyInfoText.setText(
        `${displayEnemy.def.name}  ${displayEnemy.hp}/${displayEnemy.maxHp} HP${hiddenPart}${vexedPart}`,
      );
    } else {
      this.enemyInfoText.setText("");
    }

    // Turn order bar
    const inCombat = state.mode !== "exploring" && state.combatEnemies.length > 0;
    this.turnOrderBar.setVisible(inCombat);
    if (inCombat) {
      const chips: TurnChip[] = [
        {
          label: "",
          name: state.playerDef.name,
          color: state.playerDef.color,
          isActive: state.mode === "player_turn" || state.mode === "death_saves",
          isDead: state.playerHp <= 0,
        },
        ...state.combatEnemies.map((e) => ({
          label: e.label,
          name: e.def.name,
          color: e.def.color,
          isActive: state.activeEnemy === e,
          isDead: e.isDead(),
        })),
      ];
      this.turnOrderBar.refresh(chips);
    }

    this.updateLogDisplay(state.combatLog, state.logScrollOffset);

    // Reset buttons and phase colour
    this.attackBtn.setVisible(false);
    this.secondWindBtn.setVisible(false);
    this.hideBtn.setVisible(false);
    this.endTurnBtn.setVisible(false);
    this.deathSaveBtn.setVisible(false);
    this.searchBtn.setVisible(false);
    this.communicateBtn.setVisible(false);
    this.phaseText.setColor("#e2b96f");

    switch (state.mode) {
      case "exploring":
        this.phaseText.setText("Exploring — WASD / arrow keys to move");
        if (state.encounterTypes.includes("exploration") && state.secretsRemaining > 0)
          this.searchBtn.setVisible(true);
        if (state.encounterTypes.includes("social_interaction"))
          this.communicateBtn.setVisible(true);
        break;

      case "player_turn": {
        const hiddenLabel = state.playerHidden ? "  [HIDDEN]" : "";
        const actedLabel  = state.actionUsed   ? "  · action used" : "";
        const bonusLabel  = state.bonusActionUsed ? "  · bonus used" : "";
        this.phaseText.setText(
          `Your turn — ${state.movesLeft}/${state.playerDef.speed} moves${hiddenLabel}${actedLabel}${bonusLabel}`,
        );
        this.endTurnBtn.setVisible(true);

        if (!state.actionUsed) {
          const hasAdjacentTarget = state.combatEnemies.some(
            (e) => !e.isDead() && chebyshev(state.playerTileX, state.playerTileY, e.tileX, e.tileY) <= 1,
          );
          if (hasAdjacentTarget) this.attackBtn.setVisible(true);
        }

        if (!state.bonusActionUsed && state.playerDef.secondWindMaxUses > 0 && state.secondWindUses > 0 && state.playerHp < state.playerDef.maxHp)
          this.secondWindBtn.setVisible(true);

        if (!state.bonusActionUsed && state.playerDef.sneakAttackDice > 0 && !state.playerHidden && state.combatEnemies.some((e) => !e.isDead()))
          this.hideBtn.setVisible(true);
        break;
      }

      case "enemy_turn": {
        const ae = state.activeEnemy;
        const labelPart = ae?.label ? `${ae.label} · ` : "";
        this.phaseText.setText(`${labelPart}${ae?.def.name ?? "Enemy"}'s turn...`);
        break;
      }

      case "death_saves":
        this.phaseText.setColor("#ff7777");
        this.phaseText.setText(
          `${state.playerDef.name} is unconscious!  ✓ ${state.deathSaveSuccesses}/3  ✗ ${state.deathSaveFailures}/3`,
        );
        this.deathSaveBtn.setVisible(true);
        break;

      case "defeat":
        this.phaseText.setColor("#ff4444");
        this.phaseText.setText(
          state.deathSaveSuccesses >= 3 ? "💀 Stabilized — combat over." : "☠ You have died.",
        );
        break;
    }
  }

  private updateLogDisplay(combatLog: string[], logScrollOffset: number): void {
    const total = combatLog.length;
    const offset = Math.min(logScrollOffset, Math.max(0, total - 6));
    const end = total - offset;
    const start = Math.max(0, end - 6);
    this.logText.setText(combatLog.slice(start, end).join("\n"));

    if (offset > 0) {
      this.logScrollHint.setText(`▼ ${offset} newer`);
    } else if (total > 6) {
      this.logScrollHint.setText("↑ scroll for history");
    } else {
      this.logScrollHint.setText("");
    }
  }

  private static makeButton(
    scene: Phaser.Scene,
    x: number,
    y: number,
    label: string,
    color: number,
    onClick: () => void,
  ): Phaser.GameObjects.Container {
    const bg = scene.add.rectangle(0, 0, 160, 34, color).setStrokeStyle(1, 0x556677);
    const text = scene.add
      .text(0, 0, label, { fontSize: "12px", color: "#ffffff", fontFamily: "monospace", resolution: DPR })
      .setOrigin(0.5);
    const container = scene.add.container(x, y, [bg, text]).setDepth(12);
    bg.setInteractive({ useHandCursor: true });
    bg.on("pointerover", () => bg.setAlpha(0.75));
    bg.on("pointerout",  () => bg.setAlpha(1));
    bg.on("pointerdown", onClick);
    return container;
  }
}
