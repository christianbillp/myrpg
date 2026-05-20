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
import { PlayerDef } from "../data/player";
import { MonsterDef } from "../data/monsters";
import { ItemDef } from "../data/items";
import { MapItem } from "../entities/MapItem";
import { EncounterManager, ResumeState } from "../systems/EncounterManager";
import { SaveSystem, SaveData } from "../systems/SaveSystem";
import { EnemyAI, chebyshev } from "../systems/EnemyAI";
import { generateMap, GameMap } from "../systems/MapGenerator";
import { generateRoomsMap } from "../systems/RoomsMapGenerator";
import { shuffle } from "../systems/MapUtils";
import { NPC } from "../entities/NPC";
import { pickRiddle } from "../data/riddles";
import { SecretDef, pickSecrets } from "../data/secrets";
import { d20 } from "../systems/Dice";
import { EncounterType } from "../data/encounterTypes";
import { RiddleOverlay } from "../ui/RiddleOverlay";
import { HUD, HUDState } from "../ui/HUD";
import { QuestDisplay, combatQuests, explorationQuests, socialQuests } from "../data/quests";
import { QuestManager } from "../systems/QuestManager";

const GRID_H = GRID_ROWS * TILE_SIZE;
const GRID_W = GRID_COLS * TILE_SIZE;

export class GameScene extends Phaser.Scene {
  private player!: Player;
  private enemies: Enemy[] = [];
  private mapItems: MapItem[] = [];
  private combat!: EncounterManager;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };

  private riddleOverlay: RiddleOverlay | null = null;
  private hud!: HUD;
  private quests!: QuestManager;

  private mapSecrets: { tileX: number; tileY: number; def: SecretDef }[] = [];

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

  private mapType: "open" | "rooms" | "saved" = "open";
  private savedMap: GameMap | null = null;
  private encounterTypes: EncounterType[] = ["simple_combat"];

  init(data: { playerDef?: PlayerDef; mapType?: "open" | "rooms" | "saved"; encounterTypes?: EncounterType[]; savedMap?: GameMap; resumeState?: ResumeState }): void {
    this.mapType = data?.mapType ?? "open";
    this.savedMap = data?.savedMap ?? null;
    this.encounterTypes = data?.encounterTypes ?? ["simple_combat"];
    const characters = this.registry.get("characters") as PlayerDef[];
    const def = data?.playerDef ?? characters[0];
    this.combat = new EncounterManager(
      def,
      () => this.updateHUD(),
      (delay) => this.time.delayedCall(delay, () => this.runEnemyTurn()),
      (enemy) => {
        if (this.selectedEnemy === enemy) {
          const next = this.enemies.find((e) => e !== enemy && !e.isDead()) ?? null;
          this.selectEnemy(next);
        }
        enemy.destroy();
        this.enemies = this.enemies.filter((e) => e !== enemy);
        this.highlightLayer.clear();
        this.quests.onKill();
      },
      data?.resumeState,
    );
  }

  shutdown(): void {
    SaveSystem.save(this.buildSaveData());
  }

  private buildSaveData(): SaveData {
    return {
      playerDefId: this.combat.playerDef.id,
      hp: this.combat.playerHp,
      xp: this.combat.playerXp,
      gold: this.combat.playerGold,
      inventoryIds: this.combat.inventory.map((i) => i.id),
      secondWindUses: this.combat.secondWindUses,
    };
  }

  create(): void {
    this.enemies = [];
    this.mapItems = [];
    this.mapSecrets = [];
    this.selectedEnemy = null;
    this.selectedNPC = null;
    this.npc = null;
    this.npcTalkedTo = false;
    this.riddleOverlay = null;
    this.gridZoom = 1;
    this.isPanning = false;
    this.panStartedInGameMap = false;

    this.gameMap =
      this.savedMap ??
      (this.mapType === "rooms" ? generateRoomsMap() : generateMap());

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
    if (this.encounterTypes.includes("exploration")) {
      this.spawnSecrets();
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

    const questDefs = [
      ...(this.encounterTypes.includes("simple_combat") ? combatQuests(this.enemies.length) : []),
      ...(this.encounterTypes.includes("exploration") ? explorationQuests() : []),
      ...(this.encounterTypes.includes("social_interaction") ? socialQuests() : []),
    ];
    this.quests = new QuestManager(
      questDefs,
      (quest) => {
        this.combat.awardXP(quest.rewardXp);
        this.combat.awardGold(quest.rewardGp);
        this.combat.addLogs([`Quest complete: ${quest.title}! +${quest.rewardXp} XP  +${quest.rewardGp} GP`]);
        this.updateHUD();
      },
      () => this.updateHUD(),
    );

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
    if (this.npc && this.npc.tileX === nx && this.npc.tileY === ny) return;
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
        if (this.enemies.length > 1) {
          this.enemies.forEach((e, i) =>
            e.setLabel(String.fromCharCode(65 + i)),
          );
        }
        this.combat.startCombat(this.enemies);
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
    const acting = this.combat.activeEnemy;
    EnemyAI.runTurn(
      acting,
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
        occupiedTiles: this.enemies
          .filter((e) => e !== acting && !e.isDead())
          .map((e) => [e.tileX, e.tileY] as [number, number]),
      },
      (result) => this.combat.applyEnemyTurnResult(result),
    );
  }

  // --- Action Button Handlers ---

  private onAttack(): void {
    if (this.combat.mode !== "player_turn") return;
    const isAdjacent = (e: Enemy) =>
      !e.isDead() &&
      chebyshev(this.player.tileX, this.player.tileY, e.tileX, e.tileY) <= 1;
    const target =
      (this.selectedEnemy && isAdjacent(this.selectedEnemy)
        ? this.selectedEnemy
        : this.combat.combatEnemies.find(isAdjacent)) ?? null;
    if (!target) return;
    this.combat.activeEnemy = target;
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
      this.targetPanel.show(npc.def, npc.def.maxHp);
    } else {
      this.targetPanel.hide();
    }
  }

  // --- HUD ---

  private buildHUD(): void {
    this.playerPanel = new PlayerPanel(this, this.combat.playerDef, () => this.combat.usePotion());
    this.targetPanel = new TargetPanel(this);
    this.hud = new HUD(this, {
      onAttack:      () => this.onAttack(),
      onHide:        () => this.onHide(),
      onSecondWind:  () => this.onSecondWind(),
      onEndTurn:     () => this.onEndTurn(),
      onDeathSave:   () => this.onDeathSave(),
      onSearch:      () => this.onSearch(),
      onCommunicate: () => this.onCommunicate(),
      onResetView:      () => this.resetGridView(),
      onNewEncounter:   () => {
        const saveData = this.buildSaveData();
        SaveSystem.save(saveData);
        this.scene.start("EncounterSetupScene", { saveData });
      },
      onScrollLog:      (dy) => {
        this.combat.scrollLog(dy > 0 ? -1 : 1);
        this.updateHUD();
      },
    });
  }

  private buildHUDState(): HUDState {
    return {
      mode:               this.combat.mode,
      playerDef:          this.combat.playerDef,
      playerHp:           this.combat.playerHp,
      movesLeft:          this.combat.movesLeft,
      actionUsed:         this.combat.actionUsed,
      bonusActionUsed:    this.combat.bonusActionUsed,
      playerHidden:       this.combat.playerHidden,
      secondWindUses:     this.combat.secondWindUses,
      activeEnemy:        this.combat.activeEnemy,
      combatEnemies:      this.combat.combatEnemies,
      enemyVexed:         this.combat.enemyVexed,
      enemyHidden:        this.combat.enemyHidden,
      deathSaveSuccesses: this.combat.deathSaveSuccesses,
      deathSaveFailures:  this.combat.deathSaveFailures,
      combatLog:          this.combat.combatLog,
      logScrollOffset:    this.combat.logScrollOffset,
      selectedEnemy:      this.selectedEnemy,
      playerTileX:        this.player.tileX,
      playerTileY:        this.player.tileY,
      encounterTypes:     this.encounterTypes,
      secretsRemaining:   this.mapSecrets.length,
      npcTalkedTo:        this.npcTalkedTo,
    };
  }

  private updatePanel(): void {
    const questDisplays: QuestDisplay[] = this.quests.quests.map(q => ({
      title: q.def.title,
      progress: q.progress,
      target: q.def.goal.target,
      completed: q.completed,
    }));
    this.playerPanel.refresh(
      this.combat.playerHp,
      this.combat.playerDef.maxHp,
      this.combat.playerXp,
      this.combat.playerGold,
      this.combat.inventory,
      this.combat.mode === "player_turn" && this.combat.bonusActionUsed,
      questDisplays,
    );
  }

  private updateHUD(): void {
    this.updatePanel();
    if (this.selectedEnemy)
      this.targetPanel.refresh(this.selectedEnemy.hp, this.selectedEnemy.maxHp);
    this.hud.refresh(this.buildHUDState());
    this.drawHighlights();
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
        if (this.npc && this.npc.tileX === nc && this.npc.tileY === nr) continue;
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
    const items = this.registry.get("items") as ItemDef[];
    const healthPotion = items.find((i) => i.id === "health_potion") ?? items[0];
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
    shuffle(candidates);
    const count = Math.min(3, candidates.length);
    for (let i = 0; i < count; i++) {
      const [r, c] = candidates[i];
      const item = new MapItem(this, healthPotion, c, r);
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
    this.quests.onItemCollected();
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
    const monsters = this.registry.get("monsters") as MonsterDef[];
    const defs = monsters.filter((m) => m.cr !== "0");
    const { cols, rows, passable } = this.gameMap;
    const candidates: [number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (passable[r][c] && chebyshev(c, r, this.player.tileX, this.player.tileY) >= 5) {
          candidates.push([r, c]);
        }
      }
    }
    shuffle(candidates);
    const target = 2 + Math.floor(Math.random() * 3);
    const count = Math.min(target, candidates.length);
    for (let i = 0; i < count; i++) {
      const [r, c] = candidates[i];
      const enemy = new Enemy(this, defs[Math.floor(Math.random() * defs.length)], c, r);
      this.enemies.push(enemy);
      this.mapContainer.add(enemy.gameObject);
    }
  }

  private spawnNPC(): void {
    const monsters = this.registry.get("monsters") as MonsterDef[];
    const commoner = monsters.find((m) => m.id === "commoner") ?? monsters[0];
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
    this.npc = new NPC(this, commoner, nx, ny);
    this.mapContainer.add(this.npc.gameObject);
  }

  private onCommunicate(): void {
    if (this.riddleOverlay) return;
    if (!this.selectedNPC) {
      this.combat.addLogs(["No target selected."]);
      this.updateHUD();
      return;
    }
    if (this.npcTalkedTo) return;
    if (chebyshev(this.player.tileX, this.player.tileY, this.selectedNPC.tileX, this.selectedNPC.tileY) > 1) {
      this.combat.addLogs(["Target is too far away."]);
      this.updateHUD();
      return;
    }
    this.riddleOverlay = new RiddleOverlay(
      this,
      this.npc!.def.name,
      pickRiddle(),
      (correct) => {
        if (correct) {
          this.combat.awardGold(10);
          this.combat.addLogs(["Correct! The villager rewards you with +10 GP."]);
        } else {
          this.combat.addLogs(["Wrong answer — the villager shakes their head."]);
        }
        this.npcTalkedTo = true;
        this.npc?.setInteractionHint(false);
        this.quests.onNPCTalkedTo();
        this.updateHUD();
      },
      () => {
        this.riddleOverlay = null;
        this.updateHUD();
      },
    );
  }

  private spawnSecrets(): void {
    const { cols, rows, passable } = this.gameMap;
    const candidates: [number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (
          passable[r][c] &&
          chebyshev(c, r, this.player.tileX, this.player.tileY) >= 3 &&
          !this.enemies.some((e) => e.tileX === c && e.tileY === r) &&
          !(this.npc?.tileX === c && this.npc?.tileY === r)
        ) {
          candidates.push([r, c]);
        }
      }
    }
    shuffle(candidates);
    const secrets = pickSecrets(4);
    const count = Math.min(secrets.length, candidates.length);
    for (let i = 0; i < count; i++) {
      const [r, c] = candidates[i];
      this.mapSecrets.push({ tileX: c, tileY: r, def: secrets[i] });
    }
  }

  private onSearch(): void {
    if (this.combat.mode !== "exploring") return;

    const roll = d20() + this.combat.playerDef.perceptionBonus;

    const adj = this.mapSecrets.filter(
      (s) => chebyshev(this.player.tileX, this.player.tileY, s.tileX, s.tileY) <= 1,
    );

    if (adj.length === 0) {
      this.combat.addLogs([`Search (${roll}) — Nothing found.`]);
      this.updateHUD();
      return;
    }

    const secret = adj[0];
    const success = roll >= secret.def.dc;
    this.mapSecrets = this.mapSecrets.filter((s) => s !== secret);

    if (success) {
      this.quests.onSecretFound();
      this.combat.addLogs([`Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.successText}`]);
      const r = secret.def.reward;
      if (r.type === "gold") {
        this.combat.awardGold(r.amount);
        this.combat.addLogs([`+${r.amount} GP`]);
      } else if (r.type === "item") {
        const items = this.registry.get("items") as ItemDef[];
        const item = items.find((i) => i.id === r.itemId);
        if (item) {
          this.combat.addItem(item);
          this.combat.addLogs([`Found: ${item.name}`]);
        }
      } else {
        this.combat.addLogs([`Lore: "${r.text}"`]);
      }
    } else {
      this.combat.addLogs([`Search (${roll} vs DC ${secret.def.dc}) — ${secret.def.failureText}`]);
    }

    this.updateHUD();
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
