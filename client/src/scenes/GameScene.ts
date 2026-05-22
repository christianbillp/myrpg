import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Enemy } from "../entities/Enemy";
import { PlayerPanel } from "../ui/PlayerPanel";
import { TargetPanel } from "../ui/TargetPanel";
import {
  TILE_SIZE,
  GRID_COLS,
  GRID_ROWS,
  PLAYER_PANEL_WIDTH,
} from "../constants";
import { PlayerDef } from "../data/player";
import { MonsterDef, NPCDef } from "../data/monsters";
import { ItemDef } from "../data/items";
import { MapItem } from "../entities/MapItem";
import { EncounterManager, ResumeState } from "../systems/EncounterManager";
import { SaveSystem, SaveData } from "../systems/SaveSystem";
import { EnemyAI, chebyshev } from "../systems/EnemyAI";
import { generateMap, GameMap } from "../systems/MapGenerator";
import { generateRoomsMap } from "../systems/RoomsMapGenerator";
import { shuffle } from "../systems/MapUtils";
import { NPC } from "../entities/NPC";
import { SecretDef, EncounterType, EncounterContext } from "../data/encounterContext";
import { d20 } from "../systems/Dice";
import { AIDMOverlay, AIDMGameState, AIDMAction, AIDMNpcPersona, ChatMessage } from "../ui/AIDMOverlay";
import { EquipmentOverlay } from "../ui/EquipmentOverlay";
import { applyEquipment } from "../systems/EquipmentSystem";
import { IntroductionOverlay } from "../ui/IntroductionOverlay";
import { HUD, HUDState } from "../ui/HUD";
import { QuestDisplay } from "../ui/PlayerPanel";
import { QuestManager } from "../systems/QuestManager";
import { SavedMapDef } from "../data/maps";

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

  private introOverlay: IntroductionOverlay | null = null;
  private aidmOverlay: AIDMOverlay | null = null;
  private equipmentOverlay: EquipmentOverlay | null = null;
  private aidmHistory: ChatMessage[] = [];
  private aidmLastLogLength = 0;
  private npcPersonas: AIDMNpcPersona[] = [];
  private encounterContext?: EncounterContext;
  private encounterMapName = "Unknown Map";
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
  private passiveNpcs: NPC[] = [];

  constructor() {
    super({ key: "GameScene" });
  }

  private mapType: "open" | "rooms" | "saved" = "open";
  private savedMap: GameMap | null = null;
  private encounterTypes: EncounterType[] = ["simple_combat"];
  private npcId?: string;
  private passiveNpcCount = 0;

  init(data: { playerDef?: PlayerDef; mapType?: "open" | "rooms" | "saved"; encounterTypes?: EncounterType[]; savedMap?: GameMap; resumeState?: ResumeState; encounterContext?: EncounterContext; npcId?: string; passiveNpcCount?: number }): void {
    this.encounterContext = data?.encounterContext;
    this.npcId = data?.npcId ?? data?.encounterContext?.npcId;
    this.passiveNpcCount = data?.passiveNpcCount ?? 0;
    this.mapType = data?.mapType ?? "open";
    this.savedMap = data?.savedMap ?? null;
    this.encounterTypes = data?.encounterTypes ?? ["simple_combat"];
    this.encounterMapName = (data?.savedMap as SavedMapDef | undefined)?.name ?? "Unknown Map";
    const characters = this.registry.get("characters") as PlayerDef[];
    const def = data?.playerDef ?? characters[0];
    const allItems = this.registry.get("items") as ItemDef[];
    const resumeState = data?.resumeState ?? this.buildDefaultResumeState(def, allItems);
    this.combat = new EncounterManager(
      def,
      () => this.updateHUD(),
      (delay) => this.time.delayedCall(delay, () => this.runEnemyTurn()),
      (enemy) => this.handleEnemyKilled(enemy),
      resumeState,
    );
    applyEquipment(def, this.combat.equippedSlots, allItems);
  }

  private handleEnemyKilled(enemy: Enemy): void {
    if (this.selectedEnemy === enemy) {
      const next = this.enemies.find((e) => e !== enemy && !e.isDead()) ?? null;
      this.selectEnemy(next);
    }
    if (this.combat.activeEnemy === enemy) this.combat.activeEnemy = null;
    enemy.destroy();
    this.enemies = this.enemies.filter((e) => e !== enemy);
    this.combat.combatEnemies = this.combat.combatEnemies.filter((e) => e !== enemy);
    this.highlightLayer.clear();
    this.quests.onKill();
    if (this.combat.mode !== "exploring" && this.combat.combatEnemies.every((e) => e.isDead())) {
      this.combat.mode = "exploring";
    }
  }

  shutdown(): void {
    SaveSystem.save(this.buildSaveData());
  }

  private buildDefaultResumeState(def: PlayerDef, allItems: ItemDef[]): ResumeState {
    const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
    return {
      hp: def.maxHp,
      xp: def.xp,
      gold: 0,
      inventory: (def.defaultInventoryIds ?? []).map((id) => byId[id]).filter(Boolean) as ItemDef[],
      secondWindUses: def.secondWindMaxUses,
      equippedSlots: { ...def.defaultEquipment },
    };
  }

  private buildSaveData(): SaveData {
    return {
      playerDefId: this.combat.playerDef.id,
      hp: this.combat.playerHp,
      xp: this.combat.playerXp,
      gold: this.combat.playerGold,
      inventoryIds: this.combat.inventory.map((i) => i.id),
      secondWindUses: this.combat.secondWindUses,
      equippedSlots: { ...this.combat.equippedSlots },
      skills: { ...this.combat.playerDef.skills },
    };
  }

  create(): void {
    this.enemies = [];
    this.mapItems = [];
    this.mapSecrets = [];
    this.selectedEnemy = null;
    this.selectedNPC = null;
    this.npc = null;
    this.passiveNpcs = [];
    this.introOverlay = null;
    this.aidmOverlay = null;
    this.equipmentOverlay = null;
    this.aidmHistory = [];
    this.aidmLastLogLength = 0;
    this.npcPersonas = [];
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
    if (this.encounterTypes.includes("social_interaction")) this.spawnNpc();
    if (this.passiveNpcCount > 0) this.spawnPassiveNpcs();
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
        if (this.introOverlay || this.aidmOverlay || this.equipmentOverlay) return;
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
          } else if (this.passiveNpcs.find((n) => n.tileX === tileX && n.tileY === tileY)) {
            this.selectNPC(this.passiveNpcs.find((n) => n.tileX === tileX && n.tileY === tileY)!);
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

    const questDefs = this.encounterContext?.quests ?? [];
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

    this.initView();
    this.buildHUD();
    this.updateHUD();

    if (this.encounterContext) {
      this.introOverlay = new IntroductionOverlay(
        this,
        this.encounterTypes,
        this.combat.playerDef,
        this.encounterContext,
        () => { this.introOverlay = null; },
      );
    }
  }

  update(): void {
    if (this.introOverlay || this.aidmOverlay) return;
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
    if (this.passiveNpcs.some((n) => n.tileX === nx && n.tileY === ny)) return;
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
        passivePerception: 10 + (this.combat.playerDef.skills["perception"] ?? 0),
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
      onOpenDM:      () => this.onOpenDM(),
      onOpenGear:    () => this.onOpenGear(),
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
        if (this.passiveNpcs.some((n) => n.tileX === nc && n.tileY === nr)) continue;
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

  private initView(): void {
    const mapW = this.gameMap.cols * TILE_SIZE;
    const mapH = this.gameMap.rows * TILE_SIZE;
    const fitZoom = Math.min(GRID_W / mapW, GRID_H / mapH);
    this.gridZoom = Phaser.Math.Clamp(fitZoom, 0.5, 3);
    this.mapContainer.setScale(this.gridZoom);

    if (fitZoom >= 0.5) {
      this.mapContainer.x = PLAYER_PANEL_WIDTH;
      this.mapContainer.y = GRID_H - mapH * this.gridZoom;
      this.clampGridPan();
    } else {
      this.centerViewOnPlayer();
    }
  }

  private centerViewOnPlayer(): void {
    const px = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
    const py = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;
    this.mapContainer.x = PLAYER_PANEL_WIDTH + GRID_W / 2 - px * this.gridZoom;
    this.mapContainer.y = GRID_H / 2 - py * this.gridZoom;
    this.clampGridPan();
  }

  private resetGridView(): void {
    this.initView();
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
    const target = this.encounterContext?.enemyCount ?? 2 + Math.floor(Math.random() * 3);
    const count = Math.min(target, candidates.length);
    for (let i = 0; i < count; i++) {
      const [r, c] = candidates[i];
      const enemy = new Enemy(this, defs[Math.floor(Math.random() * defs.length)], c, r);
      this.enemies.push(enemy);
      this.mapContainer.add(enemy.gameObject);
    }
  }

  private pickNpcSpawn(): [number, number] {
    const { cols, rows, passable } = this.gameMap;
    const candidates: [number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (
          passable[r][c] &&
          chebyshev(c, r, this.player.tileX, this.player.tileY) >= 5 &&
          !this.enemies.some((e) => e.tileX === c && e.tileY === r) &&
          !(this.npc && this.npc.tileX === c && this.npc.tileY === r) &&
          !this.passiveNpcs.some((n) => n.tileX === c && n.tileY === r)
        ) {
          candidates.push([c, r]);
        }
      }
    }
    if (candidates.length === 0) return [-1, -1];
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private spawnNpc(): void {
    const monsters = this.registry.get("monsters") as MonsterDef[];
    const npcs = (this.registry.get("npcs") as NPCDef[] | null) ?? [];
    let npcDef: NPCDef | undefined;
    if (this.npcId) {
      npcDef = npcs.find((n) => n.id === this.npcId);
    } else {
      npcDef = npcs.find((n) => n.id === "villager") ?? npcs.find((n) => n.persona);
    }
    npcDef = npcDef ?? npcs[0];
    let def: MonsterDef;
    if (npcDef) {
      const base = monsters.find((m) => m.id === npcDef!.monsterClass) ?? monsters[0];
      def = { ...base, id: npcDef.id, name: npcDef.name, color: npcDef.color };
    } else {
      def = monsters.find((m) => m.id === "commoner") ?? monsters[0];
    }
    if (npcDef?.persona) {
      this.npcPersonas.push({ id: npcDef.id, name: npcDef.name, persona: npcDef.persona });
    }
    const [nx, ny] = this.pickNpcSpawn();
    if (nx === -1) return;
    this.npc = new NPC(this, def, nx, ny);
    this.mapContainer.add(this.npc.gameObject);
  }

  private spawnPassiveNpcs(): void {
    const monsters = this.registry.get("monsters") as MonsterDef[];
    const npcs = (this.registry.get("npcs") as NPCDef[] | null) ?? [];
    const villagerNpc = npcs.find((n) => n.id === "villager");
    const base = monsters.find((m) => m.id === (villagerNpc?.monsterClass ?? "commoner")) ?? monsters[0];
    const def: MonsterDef = villagerNpc
      ? { ...base, id: "villager", name: "Villager", color: villagerNpc.color }
      : { ...base, name: "Villager" };
    if (villagerNpc?.persona && !this.npcPersonas.some((p) => p.id === "villager")) {
      this.npcPersonas.push({ id: "villager", name: "Villager", persona: villagerNpc.persona });
    }

    const { cols, rows, passable } = this.gameMap;
    const occupied = new Set<string>();
    occupied.add(`${this.player.tileX},${this.player.tileY}`);
    if (this.npc) occupied.add(`${this.npc.tileX},${this.npc.tileY}`);

    for (let i = 0; i < this.passiveNpcCount; i++) {
      const candidates: [number, number][] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (passable[r][c] && !occupied.has(`${c},${r}`)) candidates.push([c, r]);
        }
      }
      if (candidates.length === 0) break;
      const [cx, cy] = candidates[Math.floor(Math.random() * candidates.length)];
      occupied.add(`${cx},${cy}`);
      const passive = new NPC(this, def, cx, cy);
      passive.setInteractionHint(false);
      this.passiveNpcs.push(passive);
      this.mapContainer.add(passive.gameObject);
    }
  }

  private buildAIDMGameState(): AIDMGameState {
    const def = this.combat.playerDef;
    return {
      player: {
        name: def.name,
        className: def.className,
        level: def.level,
        hp: this.combat.playerHp,
        maxHp: def.maxHp,
        xp: this.combat.playerXp,
        gold: this.combat.playerGold,
        ac: def.ac,
        tileX: this.player.tileX,
        tileY: this.player.tileY,
        inventory: this.combat.inventory.map((i) => i.name),
        hidden: this.combat.playerHidden,
        actionUsed: this.combat.actionUsed,
        bonusActionUsed: this.combat.bonusActionUsed,
        movesLeft: this.combat.movesLeft,
        secondWindUses: this.combat.secondWindUses,
        equippedArmor: this.combat.equippedSlots.armorId,
        equippedWeapon: this.combat.equippedSlots.weaponId,
        equippedShield: this.combat.equippedSlots.shieldId,
        skills: this.combat.playerDef.skills,
        savingThrows: this.combat.playerDef.savingThrows,
      },
      enemies: this.enemies.map((e, i) => ({
        label: e.label || String(i),
        id: e.def.id,
        name: e.def.name,
        hp: e.hp,
        maxHp: e.maxHp,
        ac: e.def.ac,
        tileX: e.tileX,
        tileY: e.tileY,
        alive: !e.isDead(),
        isActive: this.combat.activeEnemy === e,
        vexed: this.combat.activeEnemy === e ? this.combat.enemyVexed : false,
        hidden: this.combat.activeEnemy === e ? this.combat.enemyHidden : false,
      })),
      npcs: [
        ...(this.npc ? [{ id: this.npc.def.id, name: this.npc.def.name, tileX: this.npc.tileX, tileY: this.npc.tileY }] : []),
        ...this.passiveNpcs.map((n, i) => ({ id: `passive_${i}`, name: n.def.name, tileX: n.tileX, tileY: n.tileY })),
      ],
      selectedTarget: this.selectedEnemy && !this.selectedEnemy.isDead()
        ? { type: "enemy" as const, name: this.selectedEnemy.def.name, id: this.selectedEnemy.def.id, label: this.selectedEnemy.label || undefined }
        : this.selectedNPC
          ? { type: "npc" as const, name: this.selectedNPC.def.name, id: this.selectedNPC === this.npc ? this.npc.def.id : `passive_${this.passiveNpcs.indexOf(this.selectedNPC)}` }
          : undefined,
      quests: this.quests.quests.map((q) => ({
        id: q.def.id,
        title: q.def.title,
        progress: q.progress,
        target: q.def.goal.target,
        completed: q.completed,
      })),
      mapItems: this.mapItems.map((i) => ({ name: i.def.name, tileX: i.tileX, tileY: i.tileY })),
      secretsRemaining: this.mapSecrets.length,
      combatLog: this.combat.combatLog.slice(-20),
      encounterTypes: this.encounterTypes,
      mapName: this.encounterMapName,
      combatPhase: this.combat.mode,
    };
  }

  private applyAIDMAction(action: AIDMAction): string | void {
    switch (action.type) {
      case "adjust_player_hp": {
        const delta = action["delta"] as number;
        const reason = action["reason"] as string;
        this.combat.addLogs([`[DM] ${delta >= 0 ? "+" : ""}${delta} HP — ${reason}`]);
        this.combat.adjustPlayerHp(delta);
        break;
      }
      case "award_xp": {
        const amount = action["amount"] as number;
        const reason = action["reason"] as string;
        this.combat.addLogs([`[DM] +${amount} XP — ${reason}`]);
        this.combat.awardXP(amount);
        break;
      }
      case "award_gold": {
        const amount = action["amount"] as number;
        const reason = action["reason"] as string;
        this.combat.addLogs([`[DM] +${amount} GP — ${reason}`]);
        this.combat.awardGold(amount);
        break;
      }
      case "set_enemy_hp": {
        const label = action["enemy_label"] as string;
        const hp = action["hp"] as number;
        const reason = action["reason"] as string;
        const enemy = this.enemies.find((e) => e.label === label);
        if (!enemy) break;
        const wasAlive = !enemy.isDead();
        enemy.setHp(hp);
        this.combat.addLogs([`[DM] ${enemy.def.name} HP → ${enemy.hp}/${enemy.maxHp} — ${reason}`]);
        if (enemy.isDead() && wasAlive) this.handleEnemyKilled(enemy);
        break;
      }
      case "add_log_entry": {
        const text = action["text"] as string;
        this.combat.addLogs([`[DM] ${text}`]);
        break;
      }
      case "move_entity": {
        const entity = action["entity"] as string;
        const tx = action["tile_x"] as number;
        const ty = action["tile_y"] as number;
        const reason = action["reason"] as string;
        if (!this.gameMap.passable[ty]?.[tx]) break;
        if (entity === "player") {
          this.player.teleport(tx, ty);
          this.combat.addLogs([`[DM] ${this.combat.playerDef.name} moved — ${reason}`]);
        } else if (entity.startsWith("enemy_")) {
          const ref = entity.slice(6);
          let e = this.enemies.find((en) => en.label !== "" && en.label === ref);
          if (!e) { const idx = parseInt(ref, 10); if (!isNaN(idx)) e = this.enemies[idx]; }
          if (e && !e.isDead()) { e.moveTo(tx, ty, () => {}); this.combat.addLogs([`[DM] ${e.def.name} moved — ${reason}`]); }
        } else if (entity.startsWith("npc_")) {
          const id = entity.slice(4);
          let npc: NPC | undefined;
          if (this.npc?.def.id === id) {
            npc = this.npc;
          } else if (id.startsWith("passive_")) {
            const idx = parseInt(id.slice(8), 10);
            if (!isNaN(idx)) npc = this.passiveNpcs[idx];
          } else {
            npc = this.passiveNpcs.find((n) => n.def.id === id);
          }
          if (npc) {
            const [ftx, fty] = this.findFreeTileNear(tx, ty, npc);
            npc.teleport(ftx, fty);
            this.combat.addLogs([`[DM] ${npc.def.name} moved — ${reason}`]);
          }
        }
        break;
      }
      case "add_item": {
        const itemId = action["item_id"] as string;
        const reason = action["reason"] as string;
        const items = this.registry.get("items") as ItemDef[];
        const item = items.find((i) => i.id === itemId);
        if (item) {
          this.combat.addItem(item);
          this.combat.addLogs([`[DM] ${item.name} added to inventory — ${reason}`]);
          this.quests.onItemCollected();
        }
        break;
      }
      case "remove_item": {
        const itemId = action["item_id"] as string;
        const reason = action["reason"] as string;
        const items = this.registry.get("items") as ItemDef[];
        const item = items.find((i) => i.id === itemId);
        if (item && this.combat.removeItem(itemId)) {
          this.combat.addLogs([`[DM] ${item.name} removed from inventory — ${reason}`]);
        }
        break;
      }
      case "end_combat": {
        const reason = action["reason"] as string;
        this.combat.addLogs([`[DM] ${reason}`]);
        for (const enemy of [...this.enemies]) {
          enemy.destroy();
        }
        this.enemies = [];
        this.selectedEnemy = null;
        this.targetPanel.hide();
        this.highlightLayer.clear();
        this.combat.endCombat();
        break;
      }
      case "trigger_combat": {
        const reason = action["reason"] as string;
        if (this.combat.mode !== "exploring") break;
        if (this.enemies.length === 0) {
          const npcsToConvert = [...(this.npc ? [this.npc] : []), ...this.passiveNpcs];
          if (npcsToConvert.length === 0) break;
          for (const npc of npcsToConvert) {
            const enemy = new Enemy(this, npc.def, npc.tileX, npc.tileY);
            this.enemies.push(enemy);
            this.mapContainer.add(enemy.gameObject);
            npc.destroy();
          }
          this.npc = null;
          this.passiveNpcs = [];
          this.selectedNPC = null;
        }
        if (this.enemies.length === 0) break;
        this.enemies.forEach((e, i) => e.setLabel(String.fromCharCode(65 + i)));
        this.combat.addLogs([`[DM] ${reason}`]);
        this.combat.startCombat(this.enemies);
        const first = this.enemies.find((e) => !e.isDead()) ?? null;
        if (first) this.selectEnemy(first);
        break;
      }
      case "complete_quest": {
        const questId = action["quest_id"] as string;
        const reason = action["reason"] as string;
        this.combat.addLogs([`[DM] ${reason}`]);
        this.quests.forceComplete(questId);
        break;
      }
      case "set_player_hidden": {
        const hidden = action["hidden"] as boolean;
        const reason = action["reason"] as string;
        this.combat.addLogs([`[DM] ${this.combat.playerDef.name} is now ${hidden ? "hidden" : "revealed"} — ${reason}`]);
        this.combat.setPlayerHidden(hidden);
        break;
      }
      case "request_ability_check": {
        const skill = action["skill"] as string;
        const dc = action["dc"] as number;
        const reason = action["reason"] as string;
        const bonus = this.combat.playerDef.skills[skill] ?? 0;
        const roll = d20();
        const total = roll + bonus;
        const success = total >= dc;
        const sign = bonus >= 0 ? "+" : "";
        const label = skill.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^\w/, c => c.toUpperCase());
        this.combat.addLogs([
          `[DM] ${label} check (DC ${dc}) — ${reason}`,
          `d20(${roll})${sign}${bonus} = ${total} vs DC ${dc} — ${success ? "SUCCESS ✓" : "FAILURE ✗"}`,
        ]);
        this.updateHUD();
        return `[Ability Check Result — ${label}, DC ${dc}: d20(${roll})${sign}${bonus} = ${total} — ${success ? "SUCCESS" : "FAILURE"}. ${reason}]`;
      }
    }
    this.updateHUD();
  }

  private onOpenGear(): void {
    if (this.aidmOverlay || this.equipmentOverlay) return;
    const allItems = this.registry.get("items") as ItemDef[];
    const canUseConsumable =
      this.combat.mode === "exploring" ||
      (this.combat.mode === "player_turn" && !this.combat.bonusActionUsed);
    this.equipmentOverlay = new EquipmentOverlay(
      this,
      this.combat.playerDef,
      { ...this.combat.equippedSlots },
      [...this.combat.inventory],
      allItems,
      canUseConsumable,
      (slot, itemId) => {
        this.combat.equip(slot, itemId, allItems);
        this.equipmentOverlay?.destroy();
        this.equipmentOverlay = null;
        SaveSystem.save(this.buildSaveData());
        this.onOpenGear();
      },
      (slot) => {
        this.combat.unequip(slot, allItems);
        this.equipmentOverlay?.destroy();
        this.equipmentOverlay = null;
        SaveSystem.save(this.buildSaveData());
        this.onOpenGear();
      },
      (_itemId) => {
        this.combat.usePotion();
        this.equipmentOverlay?.destroy();
        this.equipmentOverlay = null;
        SaveSystem.save(this.buildSaveData());
        this.updateHUD();
        this.onOpenGear();
      },
      () => { this.equipmentOverlay = null; },
    );
  }

  private onOpenDM(): void {
    if (this.aidmOverlay) return;

    const newEntries = this.combat.combatLog.slice(this.aidmLastLogLength);
    if (newEntries.length > 0 && this.aidmHistory.length > 0) {
      this.aidmHistory.push({ role: "user", content: `[Events since we last spoke:\n${newEntries.join("\n")}]` });
      this.aidmHistory.push({ role: "assistant", content: "*The Dungeon Master notes what has transpired.*" });
    }
    this.aidmLastLogLength = this.combat.combatLog.length;

    this.aidmOverlay = new AIDMOverlay(
      this,
      () => this.buildAIDMGameState(),
      this.npcPersonas,
      this.encounterContext?.context ?? "",
      this.aidmHistory,
      (action) => this.applyAIDMAction(action),
      (history) => {
        this.aidmHistory = history;
        this.aidmOverlay = null;
        this.input.keyboard?.enableGlobalCapture();
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
          !(this.npc?.tileX === c && this.npc?.tileY === r) &&
          !this.passiveNpcs.some((n) => n.tileX === c && n.tileY === r)
        ) {
          candidates.push([r, c]);
        }
      }
    }
    shuffle(candidates);
    const secrets = this.encounterContext?.secrets ?? [];
    const count = Math.min(secrets.length, candidates.length);
    for (let i = 0; i < count; i++) {
      const [r, c] = candidates[i];
      this.mapSecrets.push({ tileX: c, tileY: r, def: secrets[i] });
    }
  }

  private onSearch(): void {
    if (this.combat.mode !== "exploring") return;

    const roll = d20() + (this.combat.playerDef.skills["perception"] ?? 0);

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

  private findFreeTileNear(tx: number, ty: number, excludeNpc?: NPC): [number, number] {
    const { cols, rows, passable } = this.gameMap;
    const isFree = (c: number, r: number): boolean => {
      if (!passable[r]?.[c]) return false;
      if (this.player.tileX === c && this.player.tileY === r) return false;
      if (this.enemies.some((e) => !e.isDead() && e.tileX === c && e.tileY === r)) return false;
      if (this.npc && this.npc !== excludeNpc && this.npc.tileX === c && this.npc.tileY === r) return false;
      if (this.passiveNpcs.some((n) => n !== excludeNpc && n.tileX === c && n.tileY === r)) return false;
      return true;
    };
    if (isFree(tx, ty)) return [tx, ty];
    for (let radius = 1; radius < Math.max(cols, rows); radius++) {
      for (let dc = -radius; dc <= radius; dc++) {
        for (let dr = -radius; dr <= radius; dr++) {
          if (Math.abs(dc) !== radius && Math.abs(dr) !== radius) continue;
          const c = tx + dc, r = ty + dr;
          if (c >= 0 && c < cols && r >= 0 && r < rows && isFree(c, r)) return [c, r];
        }
      }
    }
    return [tx, ty];
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
