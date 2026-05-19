import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Enemy } from "../entities/Enemy";
import { PlayerPanel } from "../ui/PlayerPanel";
import { TargetPanel } from "../ui/TargetPanel";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HUD_HEIGHT,
  PLAYER_PANEL_WIDTH,
  TARGET_PANEL_WIDTH,
} from "../constants";
import { ALDRIC, PlayerDef } from "../data/player";
import { GOBLIN_MINION, BANDIT } from "../data/enemies";
import { HEALTH_POTION } from "../data/items";
import { MapItem } from "../entities/MapItem";
import { CombatManager } from "../systems/CombatManager";
import { EnemyAI, chebyshev } from "../systems/EnemyAI";
import { generateMap, GameMap } from "../systems/MapGenerator";
import { generateRoomsMap } from "../systems/RoomsMapGenerator";
import { NPC } from "../entities/NPC";
import { COMMONER } from "../data/npcs";
import { pickRiddle, Riddle } from "../data/riddles";

const GRID_H = GRID_ROWS * TILE_SIZE;
const GRID_W = GRID_COLS * TILE_SIZE;
const W = PLAYER_PANEL_WIDTH + GRID_W + TARGET_PANEL_WIDTH;
const DPR = window.devicePixelRatio;

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private enemies: Enemy[] = [];
  private mapItems: MapItem[] = [];
  private combat!: CombatManager;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };

  private enemyInfoText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private logText!: Phaser.GameObjects.Text;
  private logScrollHint!: Phaser.GameObjects.Text;
  private attackBtn!: Phaser.GameObjects.Container;
  private secondWindBtn!: Phaser.GameObjects.Container;
  private hideBtn!: Phaser.GameObjects.Container;
  private endTurnBtn!: Phaser.GameObjects.Container;
  private deathSaveBtn!: Phaser.GameObjects.Container;
  private riddleOverlay: Phaser.GameObjects.Container | null = null;

  private highlightLayer!: Phaser.GameObjects.Graphics;
  private mapContainer!: Phaser.GameObjects.Container;
  private gameMap!: GameMap;
  private gridZoom = 1;
  private isPanning = false;
  private panStartedInGameMap = false;
  private panLastX = 0;
  private panLastY = 0;
  private playerPanel!: PlayerPanel;
  private targetPanel!: TargetPanel;
  private selectedEnemy: Enemy | null = null;
  private selectedNPC: NPC | null = null;
  private npc: NPC | null = null;
  private npcTalkedTo = false;

  constructor() {
    super({ key: "GameScene" });
  }

  private mapType: "open" | "rooms" = "open";
  private encounterTypes: ("simple_combat" | "social_interaction")[] = ["simple_combat"];

  init(data: { playerDef?: PlayerDef; mapType?: "open" | "rooms"; encounterTypes?: ("simple_combat" | "social_interaction")[] }): void {
    this.mapType = data?.mapType ?? "open";
    this.encounterTypes = data?.encounterTypes ?? ["simple_combat"];
    const def = data?.playerDef ?? ALDRIC;
    this.combat = new CombatManager(
      def,
      () => this.updateHUD(),
      (delay) => this.time.delayedCall(delay, () => this.runEnemyTurn()),
      (enemy) => {
        if (this.selectedEnemy === enemy) this.selectEnemy(null);
        enemy.destroy();
        this.enemies = this.enemies.filter((e) => e !== enemy);
        this.highlightLayer.clear();
      },
    );
  }

  create(): void {
    this.enemies = [];
    this.mapItems = [];
    this.selectedEnemy = null;
    this.selectedNPC = null;
    this.npc = null;
    this.npcTalkedTo = false;
    this.riddleOverlay = null;
    this.gridZoom = 1;
    this.isPanning = false;
    this.panStartedInGameMap = false;

    this.gameMap = this.mapType === "rooms" ? generateRoomsMap() : generateMap();

    this.mapContainer = this.add.container(PLAYER_PANEL_WIDTH, 0);
    this.mapContainer.add(this.drawMapTiles());
    this.highlightLayer = this.add.graphics();
    this.mapContainer.add(this.highlightLayer);

    const [startX, startY] = this.findPlayerSpawn();
    this.player = new Player(this, startX, startY, this.combat.playerDef.color);
    this.mapContainer.add(this.player.gameObject);

    if (this.encounterTypes.includes("simple_combat")) {
      this.spawnEnemies();
      this.spawnItems();
    }
    if (this.encounterTypes.includes("social_interaction")) {
      this.spawnNPC();
    }

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    this.input.on(
      "wheel",
      (
        pointer: Phaser.Input.Pointer,
        _go: unknown,
        _dx: number,
        dy: number,
      ) => {
        if (
          pointer.x < PLAYER_PANEL_WIDTH ||
          pointer.x >= PLAYER_PANEL_WIDTH + GRID_W
        )
          return;
        if (pointer.y < 0 || pointer.y >= GRID_H) return;
        const newZoom = Phaser.Math.Clamp(
          this.gridZoom * (dy < 0 ? 1.15 : 1 / 1.15),
          0.5,
          3,
        );
        const pivotX = pointer.x - this.mapContainer.x;
        const pivotY = pointer.y - this.mapContainer.y;
        this.mapContainer.x = pointer.x - pivotX * (newZoom / this.gridZoom);
        this.mapContainer.y = pointer.y - pivotY * (newZoom / this.gridZoom);
        this.gridZoom = newZoom;
        this.mapContainer.setScale(newZoom);
        this.clampGridPan();
      },
    );

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      this.panStartedInGameMap = false;
      if (!pointer.leftButtonDown()) return;
      if (!this.isPointerInGameMap(pointer)) return;
      this.panStartedInGameMap = true;
      this.isPanning = false;
      this.panLastX = pointer.x;
      this.panLastY = pointer.y;
    });

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!this.panStartedInGameMap) return;
      if (!pointer.leftButtonDown()) return;
      const dx = pointer.x - this.panLastX;
      const dy = pointer.y - this.panLastY;
      if (!this.isPanning && (Math.abs(dx) > 3 || Math.abs(dy) > 3))
        this.isPanning = true;
      if (this.isPanning) {
        this.mapContainer.x += dx;
        this.mapContainer.y += dy;
        this.clampGridPan();
      }
      this.panLastX = pointer.x;
      this.panLastY = pointer.y;
    });

    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
      if (
        this.panStartedInGameMap &&
        !this.isPanning &&
        this.isPointerInGameMap(pointer)
      ) {
        const localX = (pointer.x - this.mapContainer.x) / this.gridZoom;
        const localY = (pointer.y - this.mapContainer.y) / this.gridZoom;
        const tileX = Math.floor(localX / TILE_SIZE);
        const tileY = Math.floor(localY / TILE_SIZE);
        if (
          tileX >= 0 &&
          tileX < this.gameMap.cols &&
          tileY >= 0 &&
          tileY < this.gameMap.rows
        ) {
          const enemy = this.enemies.find((e) => e.tileX === tileX && e.tileY === tileY) ?? null;
          if (enemy) {
            this.selectEnemy(enemy);
          } else if (this.npc?.tileX === tileX && this.npc?.tileY === tileY) {
            this.selectNPC(this.npc);
          } else {
            this.selectEnemy(null);
          }
        } else {
          this.selectEnemy(null);
        }
      }
      this.isPanning = false;
      this.panStartedInGameMap = false;
    });

    this.buildHUD();
    this.updateHUD();
  }

  update(): void {
    if (this.combat.mode !== "exploring" && this.combat.mode !== "player_turn")
      return;

    const leftJust = Phaser.Input.Keyboard.JustDown(this.cursors.left) || Phaser.Input.Keyboard.JustDown(this.wasd.left);
    const rightJust = Phaser.Input.Keyboard.JustDown(this.cursors.right) || Phaser.Input.Keyboard.JustDown(this.wasd.right);
    const upJust = Phaser.Input.Keyboard.JustDown(this.cursors.up) || Phaser.Input.Keyboard.JustDown(this.wasd.up);
    const downJust = Phaser.Input.Keyboard.JustDown(this.cursors.down) || Phaser.Input.Keyboard.JustDown(this.wasd.down);

    let dx = 0;
    let dy = 0;
    if (leftJust && !rightJust) dx = -1;
    else if (rightJust && !leftJust) dx = 1;
    if (upJust && !downJust) dy = -1;
    else if (downJust && !upJust) dy = 1;

    if (dx === 0 && dy === 0) return;

    const nx = this.player.tileX + dx;
    const ny = this.player.tileY + dy;

    if (nx < 0 || ny < 0 || nx >= this.gameMap.cols || ny >= this.gameMap.rows) return;
    if (!this.gameMap.passable[ny][nx]) return;
    if (dx !== 0 && dy !== 0) {
      const adjX = this.gameMap.passable[this.player.tileY][nx];
      const adjY = this.gameMap.passable[ny][this.player.tileX];
      if (!adjX && !adjY) return;
    }
    if (this.enemies.some((e) => e.tileX === nx && e.tileY === ny)) return;
    if (this.combat.mode === "player_turn" && this.combat.movesLeft <= 0)
      return;

    this.player.move(dx, dy, this.gameMap.cols, this.gameMap.rows);
    this.checkItemPickup();

    if (this.combat.mode === "player_turn") {
      this.combat.movesLeft--;
    } else {
      this.checkCombatTrigger();
    }
    this.updateHUD();
  }

  private checkCombatTrigger(): void {
    for (const enemy of this.enemies) {
      if (
        chebyshev(
          this.player.tileX,
          this.player.tileY,
          enemy.tileX,
          enemy.tileY,
        ) <= 2
      ) {
        this.combat.startCombat(enemy);
        this.selectEnemy(enemy);
        return;
      }
    }
  }

  private runEnemyTurn(): void {
    if (!this.combat.activeEnemy) {
      this.combat.enterPlayerTurn();
      return;
    }

    EnemyAI.runTurn(
      this.combat.activeEnemy,
      {
        playerTileX: this.player.tileX,
        playerTileY: this.player.tileY,
        playerAc: this.combat.playerDef.ac,
        playerHp: this.combat.playerHp,
        playerHidden: this.combat.playerHidden,
        enemyVexed: this.combat.enemyVexed,
        enemyCurrentlyHidden: this.combat.enemyHidden,
        passivePerception: 10 + this.combat.playerDef.perceptionBonus,
        passable: this.gameMap.passable,
        mapCols: this.gameMap.cols,
        mapRows: this.gameMap.rows,
      },
      (result) => this.combat.applyEnemyTurnResult(result),
    );
  }

  // --- Action Button Handlers ---

  private onAttack(): void {
    if (!this.combat.activeEnemy || this.combat.mode !== "player_turn") return;
    if (
      chebyshev(
        this.player.tileX,
        this.player.tileY,
        this.combat.activeEnemy.tileX,
        this.combat.activeEnemy.tileY,
      ) > 1
    )
      return;
    this.combat.onAttack();
  }

  private onHide(): void {
    this.combat.onHide();
  }

  private onSecondWind(): void {
    this.combat.onSecondWind();
  }

  private onEndTurn(): void {
    this.combat.onEndTurn();
  }

  private onDeathSave(): void {
    this.combat.onDeathSave();
  }

  private selectEnemy(enemy: Enemy | null): void {
    if (this.selectedNPC) { this.selectedNPC.setSelected(false); this.selectedNPC = null; }
    if (this.selectedEnemy) this.selectedEnemy.setSelected(false);
    this.selectedEnemy = enemy;
    if (enemy) {
      enemy.setSelected(true);
      this.targetPanel.show(enemy.def, enemy.hp);
    } else {
      this.targetPanel.hide();
    }
  }

  private selectNPC(npc: NPC | null): void {
    if (this.selectedEnemy) { this.selectedEnemy.setSelected(false); this.selectedEnemy = null; }
    if (this.selectedNPC) this.selectedNPC.setSelected(false);
    this.selectedNPC = npc;
    if (npc) {
      npc.setSelected(true);
      const canTalk = !this.npcTalkedTo && chebyshev(
        this.player.tileX, this.player.tileY, npc.tileX, npc.tileY,
      ) <= 1;
      this.targetPanel.showNPC(npc.def, canTalk, () => this.onTalk());
    } else {
      this.targetPanel.hide();
    }
  }

  // --- HUD ---

  private buildHUD(): void {
    const y = GRID_H;
    const cx = PLAYER_PANEL_WIDTH + GRID_W / 2;
    const lx = PLAYER_PANEL_WIDTH + 12;

    this.playerPanel = new PlayerPanel(this, this.combat.playerDef, () => this.combat.usePotion());
    this.targetPanel = new TargetPanel(this);

    this.add
      .rectangle(W / 2, y + HUD_HEIGHT / 2, W, HUD_HEIGHT, 0x0d0d1e)
      .setDepth(10);
    this.add.rectangle(W / 2, y + 1, W, 2, 0x445566).setDepth(10);

    this.enemyInfoText = this.add
      .text(W - 12, y + 10, "", {
        fontSize: "12px",
        color: "#e74c3c",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(1, 0)
      .setDepth(11);

    this.phaseText = this.add
      .text(cx, y + 10, "", {
        fontSize: "13px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 0)
      .setDepth(11);

    this.logText = this.add
      .text(lx, y + 30, "", {
        fontSize: "11px",
        color: "#aabbcc",
        fontFamily: "monospace",
        resolution: DPR,
        wordWrap: { width: GRID_W - 24 },
        lineSpacing: 4,
      })
      .setDepth(11);

    this.logScrollHint = this.add
      .text(W - 12, y + 114, "", {
        fontSize: "10px",
        color: "#445566",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(1, 0)
      .setDepth(12);

    const logZone = this.add
      .zone(cx, y + 72, GRID_W, 90)
      .setInteractive()
      .setDepth(13);
    logZone.on("wheel", (_p: unknown, _dx: number, dy: number) => {
      this.combat.scrollLog(dy > 0 ? -1 : 1);
      this.updateLogDisplay();
    });

    this.add.rectangle(W / 2, y + 122, W, 1, 0x334455).setDepth(11);

    const btnY = y + 148;
    this.makeButton(
      PLAYER_PANEL_WIDTH + 80,
      y + 10,
      "RESET VIEW",
      0x1a2a3a,
      () => this.resetGridView(),
    );
    this.attackBtn = this.makeButton(
      PLAYER_PANEL_WIDTH + 130,
      btnY,
      "ATTACK",
      0x1a4a1e,
      () => this.onAttack(),
    );
    this.secondWindBtn = this.makeButton(
      cx,
      btnY,
      "SECOND WIND",
      0x1a3a5a,
      () => this.onSecondWind(),
    );
    this.hideBtn = this.makeButton(cx, btnY, "HIDE", 0x1a3a1a, () =>
      this.onHide(),
    );
    this.endTurnBtn = this.makeButton(W - 130, btnY, "END TURN", 0x3a3020, () =>
      this.onEndTurn(),
    );
    this.deathSaveBtn = this.makeButton(
      cx,
      btnY,
      "ROLL DEATH SAVE",
      0x5a1a1a,
      () => this.onDeathSave(),
    );
  }

  private makeButton(
    x: number,
    y: number,
    label: string,
    color: number,
    onClick: () => void,
  ): Phaser.GameObjects.Container {
    const bg = this.add
      .rectangle(0, 0, 160, 34, color)
      .setStrokeStyle(1, 0x556677);
    const text = this.add
      .text(0, 0, label, {
        fontSize: "12px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);
    const container = this.add.container(x, y, [bg, text]).setDepth(12);
    bg.setInteractive({ useHandCursor: true });
    bg.on("pointerover", () => bg.setAlpha(0.75));
    bg.on("pointerout", () => bg.setAlpha(1));
    bg.on("pointerdown", onClick);
    return container;
  }

  private updatePanel(): void {
    this.playerPanel.refresh(
      this.combat.playerHp,
      this.combat.playerDef.maxHp,
      this.combat.playerXp,
      this.combat.playerGold,
      this.combat.inventory,
    );
  }

  private updateHUD(): void {
    this.updatePanel();
    if (this.selectedEnemy)
      this.targetPanel.refresh(this.selectedEnemy.hp, this.selectedEnemy.maxHp);
    if (this.selectedNPC) {
      const canTalk = !this.npcTalkedTo && chebyshev(
        this.player.tileX, this.player.tileY,
        this.selectedNPC.tileX, this.selectedNPC.tileY,
      ) <= 1;
      this.targetPanel.refreshNPC(canTalk);
    }

    if (this.combat.activeEnemy) {
      const vexedPart = this.combat.enemyVexed ? "  [VEXED]" : "";
      const hiddenPart = this.combat.enemyHidden ? "  [HIDDEN]" : "";
      this.enemyInfoText.setText(
        `${this.combat.activeEnemy.def.name}  ${this.combat.activeEnemy.hp}/${this.combat.activeEnemy.maxHp} HP${hiddenPart}${vexedPart}`,
      );
    } else {
      this.enemyInfoText.setText("");
    }

    this.updateLogDisplay();
    this.drawHighlights();

    this.attackBtn.setVisible(false);
    this.secondWindBtn.setVisible(false);
    this.hideBtn.setVisible(false);
    this.endTurnBtn.setVisible(false);
    this.deathSaveBtn.setVisible(false);
    this.phaseText.setColor("#e2b96f");

    switch (this.combat.mode) {
      case "exploring":
        this.phaseText.setText("Exploring — WASD / arrow keys to move");
        break;

      case "player_turn": {
        const hiddenLabel = this.combat.playerHidden ? "  [HIDDEN]" : "";
        this.phaseText.setText(
          `Your turn — ${this.combat.movesLeft}/${this.combat.playerDef.speed} moves${hiddenLabel}`,
        );
        this.endTurnBtn.setVisible(true);

        const adjEnemy =
          this.combat.activeEnemy !== null &&
          chebyshev(
            this.player.tileX,
            this.player.tileY,
            this.combat.activeEnemy.tileX,
            this.combat.activeEnemy.tileY,
          ) <= 1;
        if (adjEnemy) this.attackBtn.setVisible(true);

        if (
          this.combat.playerDef.secondWindMaxUses > 0 &&
          this.combat.secondWindUses > 0 &&
          this.combat.playerHp < this.combat.playerDef.maxHp
        ) {
          this.secondWindBtn.setVisible(true);
        }
        if (
          this.combat.playerDef.sneakAttackDice > 0 &&
          !this.combat.playerHidden &&
          this.combat.activeEnemy
        ) {
          this.hideBtn.setVisible(true);
        }
        break;
      }

      case "enemy_turn":
        this.phaseText.setText(
          `${this.combat.activeEnemy?.def.name ?? "Enemy"}'s turn...`,
        );
        break;

      case "death_saves":
        this.phaseText.setColor("#ff7777");
        this.phaseText.setText(
          `${this.combat.playerDef.name} is unconscious!  ✓ ${this.combat.deathSaveSuccesses}/3  ✗ ${this.combat.deathSaveFailures}/3`,
        );
        this.deathSaveBtn.setVisible(true);
        break;

      case "defeat":
        this.phaseText.setColor("#ff4444");
        this.phaseText.setText(
          this.combat.deathSaveSuccesses >= 3
            ? "💀 Stabilized — combat over."
            : "☠ You have died.",
        );
        break;
    }
  }

  private updateLogDisplay(): void {
    const total = this.combat.combatLog.length;
    const offset = Math.min(
      this.combat.logScrollOffset,
      Math.max(0, total - 6),
    );
    this.combat.logScrollOffset = offset;
    const end = total - offset;
    const start = Math.max(0, end - 6);
    this.logText.setText(this.combat.combatLog.slice(start, end).join("\n"));

    if (offset > 0) {
      this.logScrollHint.setText(`▼ ${offset} newer`);
    } else if (total > 6) {
      this.logScrollHint.setText("↑ scroll for history");
    } else {
      this.logScrollHint.setText("");
    }
  }

  private drawHighlights(): void {
    this.highlightLayer.clear();
    if (this.combat.mode !== "player_turn" || this.combat.movesLeft <= 0)
      return;

    const { cols, rows, passable } = this.gameMap;
    const px = this.player.tileX;
    const py = this.player.tileY;

    const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
    dist[py][px] = 0;
    const queue: [number, number][] = [[py, px]];
    const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

    while (queue.length > 0) {
      const [cy, cx] = queue.shift()!;
      if (dist[cy][cx] >= this.combat.movesLeft) continue;
      for (const [dr, dc] of dirs) {
        const nr = cy + dr, nc = cx + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (!passable[nr][nc]) continue;
        if (this.enemies.some((e) => e.tileX === nc && e.tileY === nr)) continue;
        if (dist[nr][nc] !== -1) continue;
        dist[nr][nc] = dist[cy][cx] + 1;
        queue.push([nr, nc]);
      }
    }

    this.highlightLayer.fillStyle(0x4fc3f7, 0.15);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (dist[row][col] > 0) {
          this.highlightLayer.fillRect(
            col * TILE_SIZE + 1,
            row * TILE_SIZE + 1,
            TILE_SIZE - 2,
            TILE_SIZE - 2,
          );
        }
      }
    }
  }

  private clampGridPan(): void {
    const margin = TILE_SIZE;
    const contentW = this.gameMap.cols * TILE_SIZE;
    const contentH = this.gameMap.rows * TILE_SIZE;
    this.mapContainer.x = Phaser.Math.Clamp(
      this.mapContainer.x,
      PLAYER_PANEL_WIDTH + margin - contentW * this.gridZoom,
      PLAYER_PANEL_WIDTH + contentW - margin,
    );
    this.mapContainer.y = Phaser.Math.Clamp(
      this.mapContainer.y,
      margin - contentH * this.gridZoom,
      contentH - margin,
    );
  }

  private isPointerInGameMap(pointer: Phaser.Input.Pointer): boolean {
    return (
      pointer.x >= PLAYER_PANEL_WIDTH &&
      pointer.x < PLAYER_PANEL_WIDTH + GRID_W &&
      pointer.y >= 0 &&
      pointer.y < GRID_H
    );
  }

  private resetGridView(): void {
    this.gridZoom = 1;
    this.mapContainer.setScale(1);
    this.mapContainer.setPosition(PLAYER_PANEL_WIDTH, 0);
  }

  private spawnItems(): void {
    const { cols, rows, passable } = this.gameMap;
    const candidates: [number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (
          passable[r][c] &&
          chebyshev(c, r, this.player.tileX, this.player.tileY) >= 3 &&
          !this.enemies.some((e) => e.tileX === c && e.tileY === r)
        ) {
          candidates.push([r, c]);
        }
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const count = Math.min(3, candidates.length);
    for (let i = 0; i < count; i++) {
      const [r, c] = candidates[i];
      const item = new MapItem(this, HEALTH_POTION, c, r);
      this.mapItems.push(item);
      this.mapContainer.add(item.gameObject);
    }
  }

  private checkItemPickup(): void {
    const idx = this.mapItems.findIndex(
      (i) => i.tileX === this.player.tileX && i.tileY === this.player.tileY,
    );
    if (idx === -1) return;
    const item = this.mapItems[idx];
    this.combat.addItem(item.def);
    item.destroy();
    this.mapItems.splice(idx, 1);
  }

  private findPlayerSpawn(): [number, number] {
    const { cols, rows, passable } = this.gameMap;
    const candidates: [number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < Math.floor(cols / 3); c++) {
        if (passable[r][c]) candidates.push([c, r]);
      }
    }
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (passable[r][c]) return [c, r];
      }
    }
    return [0, 0];
  }

  private spawnEnemies(): void {
    const { cols, rows, passable } = this.gameMap;
    const candidates: [number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (passable[r][c] && chebyshev(c, r, this.player.tileX, this.player.tileY) >= 5) {
          candidates.push([r, c]);
        }
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const defs = [GOBLIN_MINION, BANDIT];
    const count = Math.min(2, candidates.length);
    for (let i = 0; i < count; i++) {
      const [r, c] = candidates[i];
      const enemy = new Enemy(this, defs[i % defs.length], c, r);
      this.enemies.push(enemy);
      this.mapContainer.add(enemy.gameObject);
    }
  }

  private spawnNPC(): void {
    const { cols, rows, passable } = this.gameMap;
    const candidates: [number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (
          passable[r][c] &&
          chebyshev(c, r, this.player.tileX, this.player.tileY) >= 5 &&
          !this.enemies.some((e) => e.tileX === c && e.tileY === r)
        ) {
          candidates.push([c, r]);
        }
      }
    }
    if (candidates.length === 0) return;
    const [nx, ny] = candidates[Math.floor(Math.random() * candidates.length)];
    this.npc = new NPC(this, COMMONER, nx, ny);
    this.mapContainer.add(this.npc.gameObject);
  }

  private onTalk(): void {
    if (!this.npc || this.npcTalkedTo || this.riddleOverlay) return;
    this.showRiddleOverlay(pickRiddle());
  }

  private showRiddleOverlay(riddle: Riddle): void {
    const panelW = 580;
    const panelH = 400;
    const panelX = W / 2;
    const panelY = GRID_H / 2;

    const backdrop = this.add.rectangle(W / 2, (GRID_H + HUD_HEIGHT) / 2, W, GRID_H + HUD_HEIGHT, 0x000000, 0.7);
    const panel = this.add.rectangle(0, 0, panelW, panelH, 0x0d0d1e).setStrokeStyle(2, 0xe2b96f);

    const top = -panelH / 2;

    const title = this.add.text(0, top + 24, "RIDDLE", {
      fontSize: "16px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    const sep1 = this.add.rectangle(0, top + 50, panelW - 40, 1, 0x334455);

    const prompt = this.add.text(0, top + 62, `${this.npc!.def.name} says:`, {
      fontSize: "11px", color: "#667788", fontFamily: "monospace", resolution: DPR,
    }).setOrigin(0.5, 0);

    const question = this.add.text(0, top + 82, riddle.question, {
      fontSize: "14px", color: "#ccddef", fontFamily: "monospace", resolution: DPR,
      align: "center", lineSpacing: 6,
    }).setOrigin(0.5, 0);

    const btnW = panelW - 60;
    const btnH = 40;
    const btnStartY = top + 220;
    const btnGap = 52;

    const answerObjects: Phaser.GameObjects.GameObject[] = [title, sep1, prompt, question];
    const resultText = this.add.text(0, top + 220, "", {
      fontSize: "14px", color: "#e2b96f", fontFamily: "monospace", resolution: DPR,
      align: "center", lineSpacing: 6,
    }).setOrigin(0.5, 0).setVisible(false);

    const closeBtn = this.add.container(0, top + panelH - 36, [
      this.add.rectangle(0, 0, 120, 32, 0x1a2a3a).setStrokeStyle(1, 0x556677),
      this.add.text(0, 0, "CLOSE", { fontSize: "12px", color: "#ffffff", fontFamily: "monospace", resolution: DPR }).setOrigin(0.5),
    ]).setVisible(false);
    (closeBtn.getAt(0) as Phaser.GameObjects.Rectangle).setInteractive({ useHandCursor: true })
      .on("pointerdown", () => {
        this.riddleOverlay?.destroy();
        this.riddleOverlay = null;
        this.updateHUD();
      });

    const onAnswer = (chosenIndex: number): void => {
      answerBtns.forEach((b) => b.destroy());
      const correct = chosenIndex === riddle.correctIndex;
      if (correct) {
        this.combat.playerGold += 10;
        this.combat.combatLog.push("Correct! The villager rewards you with +10 GP.");
        resultText.setText("Correct!\nThe villager rewards you with +10 GP.").setColor("#7ec87e");
      } else {
        this.combat.combatLog.push("Wrong answer — the villager shakes their head.");
        resultText.setText("Wrong answer.\nThe villager shakes their head.").setColor("#cc7777");
      }
      resultText.setVisible(true);
      closeBtn.setVisible(true);
      this.npcTalkedTo = true;
      this.npc?.setInteractionHint(false);
      this.updateHUD();
    };

    const answerBtns = riddle.options.map((label, i) => {
      const btnY = btnStartY + i * btnGap;
      const bg = this.add.rectangle(0, 0, btnW, btnH, 0x1a2030).setStrokeStyle(1, 0x445566);
      const txt = this.add.text(0, 0, label, {
        fontSize: "13px", color: "#ffffff", fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0.5);
      bg.setInteractive({ useHandCursor: true })
        .on("pointerover", () => bg.setFillStyle(0x2a3050))
        .on("pointerout", () => bg.setFillStyle(0x1a2030))
        .on("pointerdown", () => onAnswer(i));
      return this.add.container(0, btnY, [bg, txt]);
    });

    this.riddleOverlay = this.add.container(panelX, panelY, [
      backdrop, panel, ...answerObjects, resultText, closeBtn, ...answerBtns,
    ]).setDepth(100);
  }

  private drawMapTiles(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    const { cols, rows, passable } = this.gameMap;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        g.fillStyle(passable[row][col] ? 0x16213e : 0x05080f);
        g.fillRect(
          col * TILE_SIZE + 1,
          row * TILE_SIZE + 1,
          TILE_SIZE - 2,
          TILE_SIZE - 2,
        );
      }
    }
    return g;
  }
}
