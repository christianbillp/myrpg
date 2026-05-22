import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Enemy } from "../entities/Enemy";
import { NPC } from "../entities/NPC";
import { MapItem } from "../entities/MapItem";
import { PlayerPanel, QuestDisplay } from "../ui/PlayerPanel";
import { TargetPanel } from "../ui/TargetPanel";
import { HUD, HUDState } from "../ui/HUD";
import { AIDMOverlay, ChatMessage, DMPersona } from "../ui/AIDMOverlay";
import { InventoryOverlay } from "../ui/InventoryOverlay";
import { IntroductionOverlay } from "../ui/IntroductionOverlay";
import { TILE_SIZE, GRID_COLS, GRID_ROWS, PLAYER_PANEL_WIDTH } from "../constants";
import { PlayerDef } from "../data/player";
import { MonsterDef, NPCDef } from "../data/monsters";
import { ItemDef } from "../data/items";
import { gameClient } from "../net/GameClient";
import type { GameState, GameEvent, GameMap } from "../net/types";

const GRID_H = GRID_ROWS * TILE_SIZE;
const GRID_W = GRID_COLS * TILE_SIZE;

export class GameScene extends Phaser.Scene {
  private playerDef!: PlayerDef;

  private gameState!: GameState;
  private eventQueue: GameEvent[] = [];
  private animating = false;
  private mapDrawn = false;
  private introShown = false;

  private player: Player | null = null;
  private enemyTokens = new Map<string, Enemy>();
  private npcTokens = new Map<string, NPC>();
  private itemTokens = new Map<string, MapItem>();

  private selectedEnemyId: string | null = null;
  private selectedNPCId: string | null = null;

  private playerPanel!: PlayerPanel;
  private targetPanel!: TargetPanel;
  private hud!: HUD;
  private introOverlay: IntroductionOverlay | null = null;
  private aidmOverlay: AIDMOverlay | null = null;
  private inventoryOverlay: InventoryOverlay | null = null;
  private aidmHistory: ChatMessage[] = [];
  private aidmPersona: DMPersona = "regular";
  private localLogScrollOffset = 0;

  private highlightLayer!: Phaser.GameObjects.Graphics;
  private mapContainer!: Phaser.GameObjects.Container;
  private gridZoom = 1;
  private isPanning = false;
  private panStartedInGameMap = false;
  private panLastX = 0;
  private panLastY = 0;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };

  constructor() {
    super({ key: "GameScene" });
  }

  init(data: { sessionId: string; playerDef: PlayerDef }): void {
    this.playerDef = data.playerDef;
    this.player = null;
    this.eventQueue = [];
    this.animating = false;
    this.mapDrawn = false;
    this.introShown = false;
    this.enemyTokens = new Map();
    this.npcTokens = new Map();
    this.itemTokens = new Map();
    this.selectedEnemyId = null;
    this.selectedNPCId = null;
    this.introOverlay = null;
    this.aidmOverlay = null;
    this.inventoryOverlay = null;
    this.aidmHistory = [];
    this.aidmPersona = "regular";
    this.localLogScrollOffset = 0;
  }

  create(): void {
    this.mapContainer = this.add.container(PLAYER_PANEL_WIDTH, 0);
    this.highlightLayer = this.add.graphics();
    this.mapContainer.add(this.highlightLayer);

    this.setupInput();
    this.buildHUD();

    gameClient.setStateUpdateHandler((state, events) => this.handleStateUpdate(state, events));
    gameClient.connectWebSocket();
  }

  shutdown(): void {
    gameClient.disconnect();
  }

  // ── State update pipeline ─────────────────────────────────────────────────

  private handleStateUpdate(state: GameState, events: GameEvent[]): void {
    this.gameState = state;
    this.localLogScrollOffset = state.logScrollOffset;
    for (const ev of events) {
      if (ev.type === "entity_move") this.eventQueue.push(ev);
    }
    if (!this.animating) this.processNextEvent();
  }

  private processNextEvent(): void {
    if (this.eventQueue.length === 0) {
      this.applyState(this.gameState);
      return;
    }
    const event = this.eventQueue.shift()!;
    this.animating = true;
    if (event.type === "entity_move") {
      const token = this.enemyTokens.get(event.entityId);
      if (token) {
        token.moveTo(event.toX, event.toY, () => {
          this.animating = false;
          this.processNextEvent();
        });
        return;
      }
    }
    this.animating = false;
    this.processNextEvent();
  }

  private applyState(state: GameState): void {
    this.animating = false;

    if (!this.mapDrawn) {
      this.mapContainer.addAt(this.drawMapTiles(state.map), 0);
      this.mapDrawn = true;
      this.initView(state.map);
    }

    if (!this.player) {
      this.player = new Player(this, state.player.tileX, state.player.tileY, this.playerDef.color);
      this.mapContainer.add(this.player.gameObject);
    } else {
      this.player.teleport(state.player.tileX, state.player.tileY);
    }

    this.reconcileEnemies(state);
    this.reconcileNpcs(state);
    this.reconcileItems(state);
    this.reconcileSelection(state);

    if (!this.introShown && state.introduction) {
      this.introShown = true;
      this.introOverlay = new IntroductionOverlay(
        this,
        state.encounterTypes,
        this.playerDef,
        { introduction: state.introduction, context: state.encounterContext, enemyCount: 0, secrets: [], riddle: null, quests: [] },
        () => { this.introOverlay = null; },
      );
    }

    this.updateHUD(state);
  }

  // ── Entity reconciliation ─────────────────────────────────────────────────

  private reconcileEnemies(state: GameState): void {
    const liveIds = new Set(state.enemies.filter(e => e.hp > 0).map(e => e.id));
    for (const [id, token] of this.enemyTokens) {
      if (!liveIds.has(id)) {
        token.destroy();
        this.enemyTokens.delete(id);
        if (this.selectedEnemyId === id) {
          this.selectedEnemyId = null;
          this.targetPanel.hide();
        }
      }
    }
    for (const eState of state.enemies) {
      if (eState.hp <= 0) continue;
      let token = this.enemyTokens.get(eState.id);
      if (!token) {
        const def = this.findMonsterDef(eState.defId);
        token = new Enemy(this, def, eState.tileX, eState.tileY);
        this.enemyTokens.set(eState.id, token);
        this.mapContainer.add(token.gameObject);
      }
      token.setLabel(eState.label);
      token.setHp(eState.hp);
    }
  }

  private reconcileNpcs(state: GameState): void {
    const serverIds = new Set(state.npcs.map(n => n.id));
    for (const [id, token] of this.npcTokens) {
      if (!serverIds.has(id)) {
        token.destroy();
        this.npcTokens.delete(id);
        if (this.selectedNPCId === id) {
          this.selectedNPCId = null;
          this.targetPanel.hide();
        }
      }
    }
    for (const nState of state.npcs) {
      let token = this.npcTokens.get(nState.id);
      if (!token) {
        const def = this.findNpcMonsterDef(nState.defId);
        token = new NPC(this, def, nState.tileX, nState.tileY);
        token.setInteractionHint(true);
        this.npcTokens.set(nState.id, token);
        this.mapContainer.add(token.gameObject);
      } else {
        token.teleport(nState.tileX, nState.tileY);
      }
    }
  }

  private reconcileItems(state: GameState): void {
    const serverIds = new Set(state.mapItems.map(i => i.id));
    for (const [id, token] of this.itemTokens) {
      if (!serverIds.has(id)) {
        token.destroy();
        this.itemTokens.delete(id);
      }
    }
    for (const iState of state.mapItems) {
      if (!this.itemTokens.has(iState.id)) {
        const def = this.findItemDef(iState.defId);
        const token = new MapItem(this, def, iState.tileX, iState.tileY);
        this.itemTokens.set(iState.id, token);
        this.mapContainer.add(token.gameObject);
      }
    }
  }

  private reconcileSelection(state: GameState): void {
    const serverId = state.selectedTargetId;
    if (serverId === this.selectedEnemyId || serverId === this.selectedNPCId) {
      if (this.selectedEnemyId) {
        const eState = state.enemies.find(e => e.id === this.selectedEnemyId);
        if (eState && eState.hp > 0) this.targetPanel.refresh(eState.hp, eState.maxHp);
      }
      return;
    }

    if (this.selectedEnemyId) {
      this.enemyTokens.get(this.selectedEnemyId)?.setSelected(false);
      this.selectedEnemyId = null;
    }
    if (this.selectedNPCId) {
      this.npcTokens.get(this.selectedNPCId)?.setSelected(false);
      this.selectedNPCId = null;
    }

    if (!serverId) { this.targetPanel.hide(); return; }

    const eState = state.enemies.find(e => e.id === serverId);
    if (eState && eState.hp > 0) {
      this.selectedEnemyId = serverId;
      this.enemyTokens.get(serverId)?.setSelected(true);
      this.targetPanel.show(this.findMonsterDef(eState.defId), eState.hp);
      return;
    }
    const nState = state.npcs.find(n => n.id === serverId);
    if (nState) {
      this.selectedNPCId = serverId;
      this.npcTokens.get(serverId)?.setSelected(true);
      const def = this.findNpcMonsterDef(nState.defId);
      this.targetPanel.show(def, def.maxHp);
    }
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  private setupInput(): void {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      up:    this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    this.input.on("wheel", (pointer: Phaser.Input.Pointer, _go: unknown, _dx: number, dy: number) => {
      if (this.introOverlay || this.aidmOverlay || this.inventoryOverlay) return;
      if (pointer.x < PLAYER_PANEL_WIDTH || pointer.x >= PLAYER_PANEL_WIDTH + GRID_W) return;
      if (pointer.y < 0 || pointer.y >= GRID_H) return;
      const newZoom = Phaser.Math.Clamp(this.gridZoom * (dy < 0 ? 1.15 : 1 / 1.15), 0.5, 3);
      const pivotX = pointer.x - this.mapContainer.x;
      const pivotY = pointer.y - this.mapContainer.y;
      this.mapContainer.x = pointer.x - pivotX * (newZoom / this.gridZoom);
      this.mapContainer.y = pointer.y - pivotY * (newZoom / this.gridZoom);
      this.gridZoom = newZoom;
      this.mapContainer.setScale(newZoom);
      this.clampGridPan();
    });

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
      if (!this.isPanning && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) this.isPanning = true;
      if (this.isPanning) {
        this.mapContainer.x += dx;
        this.mapContainer.y += dy;
        this.clampGridPan();
      }
      this.panLastX = pointer.x;
      this.panLastY = pointer.y;
    });

    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
      if (this.panStartedInGameMap && !this.isPanning && this.isPointerInGameMap(pointer)) {
        this.handleMapClick(pointer);
      }
      this.isPanning = false;
      this.panStartedInGameMap = false;
    });
  }

  private handleMapClick(pointer: Phaser.Input.Pointer): void {
    if (!this.gameState) return;
    const localX = (pointer.x - this.mapContainer.x) / this.gridZoom;
    const localY = (pointer.y - this.mapContainer.y) / this.gridZoom;
    const tileX = Math.floor(localX / TILE_SIZE);
    const tileY = Math.floor(localY / TILE_SIZE);
    const { cols, rows } = this.gameState.map;
    if (tileX < 0 || tileX >= cols || tileY < 0 || tileY >= rows) return;

    const eState = this.gameState.enemies.find(e => e.hp > 0 && e.tileX === tileX && e.tileY === tileY);
    const nState = this.gameState.npcs.find(n => n.tileX === tileX && n.tileY === tileY);

    if (eState) {
      this.selectEnemy(eState.id);
    } else if (nState) {
      this.selectNPC(nState.id);
    } else {
      this.clearSelection();
    }
  }

  private selectEnemy(id: string): void {
    if (this.selectedNPCId) {
      this.npcTokens.get(this.selectedNPCId)?.setSelected(false);
      this.selectedNPCId = null;
    }
    if (this.selectedEnemyId === id) return;
    if (this.selectedEnemyId) this.enemyTokens.get(this.selectedEnemyId)?.setSelected(false);
    this.selectedEnemyId = id;
    this.enemyTokens.get(id)?.setSelected(true);
    const eState = this.gameState.enemies.find(e => e.id === id);
    if (eState) this.targetPanel.show(this.findMonsterDef(eState.defId), eState.hp);
    gameClient.sendAction({ type: "selectTarget", entityId: id });
    if (this.gameState) this.updateHUD(this.gameState);
  }

  private selectNPC(id: string): void {
    if (this.selectedEnemyId) {
      this.enemyTokens.get(this.selectedEnemyId)?.setSelected(false);
      this.selectedEnemyId = null;
    }
    if (this.selectedNPCId === id) return;
    if (this.selectedNPCId) this.npcTokens.get(this.selectedNPCId)?.setSelected(false);
    this.selectedNPCId = id;
    this.npcTokens.get(id)?.setSelected(true);
    const nState = this.gameState.npcs.find(n => n.id === id);
    if (nState) {
      const def = this.findNpcMonsterDef(nState.defId);
      this.targetPanel.show(def, def.maxHp);
    }
    gameClient.sendAction({ type: "selectTarget", entityId: id });
    if (this.gameState) this.updateHUD(this.gameState);
  }

  private clearSelection(): void {
    if (this.selectedEnemyId) {
      this.enemyTokens.get(this.selectedEnemyId)?.setSelected(false);
      this.selectedEnemyId = null;
    }
    if (this.selectedNPCId) {
      this.npcTokens.get(this.selectedNPCId)?.setSelected(false);
      this.selectedNPCId = null;
    }
    this.targetPanel.hide();
    gameClient.sendAction({ type: "selectTarget", entityId: null });
    if (this.gameState) this.updateHUD(this.gameState);
  }

  update(): void {
    if (this.introOverlay || this.aidmOverlay) return;
    if (!this.gameState || !this.player) return;

    const phase = this.gameState.phase;
    if (phase !== "exploring" && phase !== "player_turn") return;

    const leftJust  = Phaser.Input.Keyboard.JustDown(this.cursors.left)  || Phaser.Input.Keyboard.JustDown(this.wasd.left);
    const rightJust = Phaser.Input.Keyboard.JustDown(this.cursors.right) || Phaser.Input.Keyboard.JustDown(this.wasd.right);
    const upJust    = Phaser.Input.Keyboard.JustDown(this.cursors.up)    || Phaser.Input.Keyboard.JustDown(this.wasd.up);
    const downJust  = Phaser.Input.Keyboard.JustDown(this.cursors.down)  || Phaser.Input.Keyboard.JustDown(this.wasd.down);

    let dx = 0, dy = 0;
    if (leftJust  && !rightJust) dx = -1;
    else if (rightJust && !leftJust) dx =  1;
    if (upJust    && !downJust)  dy = -1;
    else if (downJust  && !upJust)  dy =  1;
    if (dx === 0 && dy === 0) return;

    const { map, player: ps, enemies, npcs } = this.gameState;
    const px = this.player.tileX;
    const py = this.player.tileY;
    const nx = px + dx, ny = py + dy;

    if (nx < 0 || ny < 0 || nx >= map.cols || ny >= map.rows) return;
    if (!map.passable[ny][nx]) return;
    if (dx !== 0 && dy !== 0 && !map.passable[py][nx] && !map.passable[ny][px]) return;
    if (enemies.some(e => e.hp > 0 && e.tileX === nx && e.tileY === ny)) return;
    if (npcs.some(n => n.tileX === nx && n.tileY === ny)) return;
    if (phase === "player_turn" && ps.movesLeft <= 0) return;

    this.player.move(dx, dy, map.cols, map.rows);
    gameClient.sendAction({ type: "move", dx, dy });
  }

  // ── HUD ──────────────────────────────────────────────────────────────────

  private buildHUD(): void {
    this.playerPanel = new PlayerPanel(
      this,
      this.playerDef,
      () => gameClient.sendAction({ type: "usePotion" }),
    );
    this.targetPanel = new TargetPanel(this);
    this.hud = new HUD(this, {
      onAttack:       () => gameClient.sendAction({ type: "attack" }),
      onHide:         () => gameClient.sendAction({ type: "hide" }),
      onSecondWind:   () => gameClient.sendAction({ type: "secondWind" }),
      onEndTurn:      () => gameClient.sendAction({ type: "endTurn" }),
      onDeathSave:    () => gameClient.sendAction({ type: "rollDeathSave" }),
      onSearch:       () => gameClient.sendAction({ type: "search" }),
      onOpenDM:       () => this.onOpenDM(),
      onOpenInventory:() => this.onOpenInventory(),
      onResetView:    () => this.resetGridView(),
      onNewEncounter: () => {
        gameClient.disconnect();
        this.scene.start("EncounterSetupScene");
      },
      onScrollLog: (dy) => {
        this.localLogScrollOffset = Math.max(0, this.localLogScrollOffset + (dy > 0 ? -1 : 1));
        if (this.gameState) this.updateHUD(this.gameState);
      },
    });
  }

  private buildHUDState(state: GameState): HUDState {
    const activeEnemyState = state.enemies.find(e => e.isActive);
    const activeEnemy = activeEnemyState ? (this.enemyTokens.get(activeEnemyState.id) ?? null) : null;
    const selectedEnemy = this.selectedEnemyId ? (this.enemyTokens.get(this.selectedEnemyId) ?? null) : null;
    const combatEnemies = state.enemies
      .filter(e => e.hp > 0)
      .map(e => this.enemyTokens.get(e.id))
      .filter((e): e is Enemy => e !== undefined);

    return {
      mode:               state.phase,
      playerDef:          this.playerDef,
      playerHp:           state.player.hp,
      movesLeft:          state.player.movesLeft,
      actionUsed:         state.player.actionUsed,
      bonusActionUsed:    state.player.bonusActionUsed,
      playerHidden:       state.player.hidden,
      secondWindUses:     state.player.secondWindUses,
      activeEnemy,
      combatEnemies,
      enemyVexed:         activeEnemyState?.vexed ?? false,
      enemyHidden:        activeEnemyState?.hidden ?? false,
      deathSaveSuccesses: state.player.deathSaveSuccesses,
      deathSaveFailures:  state.player.deathSaveFailures,
      combatLog:          state.combatLog,
      logScrollOffset:    this.localLogScrollOffset,
      selectedEnemy,
      playerTileX:        this.player?.tileX ?? state.player.tileX,
      playerTileY:        this.player?.tileY ?? state.player.tileY,
      encounterTypes:     state.encounterTypes,
      secretsRemaining:   state.secrets.length,
    };
  }

  private updateHUD(state: GameState): void {
    const allItems = this.registry.get("items") as ItemDef[];
    const byId = Object.fromEntries(allItems.map(i => [i.id, i]));
    const inventory = state.player.inventoryIds.map(id => byId[id]).filter(Boolean) as ItemDef[];

    const quests: QuestDisplay[] = state.quests.map(q => ({
      title:     q.title,
      progress:  q.progress,
      target:    q.goalTarget,
      completed: q.completed,
    }));

    this.playerPanel.refresh(
      state.player.hp,
      this.playerDef.maxHp,
      state.player.xp,
      state.player.gold,
      inventory,
      state.phase === "player_turn" && state.player.bonusActionUsed,
      quests,
    );

    if (this.selectedEnemyId) {
      const eState = state.enemies.find(e => e.id === this.selectedEnemyId);
      if (eState && eState.hp > 0) this.targetPanel.refresh(eState.hp, eState.maxHp);
    }

    this.hud.refresh(this.buildHUDState(state));
    this.drawHighlights(state);
  }

  // ── Map drawing ───────────────────────────────────────────────────────────

  private drawMapTiles(map: GameMap): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    for (let row = 0; row < map.rows; row++) {
      for (let col = 0; col < map.cols; col++) {
        g.fillStyle(map.passable[row][col] ? 0x16213e : 0x05080f);
        g.fillRect(col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
    }
    return g;
  }

  private drawHighlights(state: GameState): void {
    this.highlightLayer.clear();
    if (state.phase !== "player_turn" || state.player.movesLeft <= 0) return;
    if (!this.player) return;

    const { cols, rows, passable } = state.map;
    const px = this.player.tileX;
    const py = this.player.tileY;

    const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
    dist[py][px] = 0;
    const queue: [number, number][] = [[py, px]];

    while (queue.length > 0) {
      const [cy, cx] = queue.shift()!;
      if (dist[cy][cx] >= state.player.movesLeft) continue;
      for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as [number, number][]) {
        const nr = cy + dr, nc = cx + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (!passable[nr][nc]) continue;
        if (state.enemies.some(e => e.hp > 0 && e.tileX === nc && e.tileY === nr)) continue;
        if (state.npcs.some(n => n.tileX === nc && n.tileY === nr)) continue;
        if (dist[nr][nc] !== -1) continue;
        dist[nr][nc] = dist[cy][cx] + 1;
        queue.push([nr, nc]);
      }
    }

    this.highlightLayer.fillStyle(0x4fc3f7, 0.15);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (dist[row][col] > 0) {
          this.highlightLayer.fillRect(col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        }
      }
    }
  }

  // ── View ─────────────────────────────────────────────────────────────────

  private initView(map: GameMap): void {
    const mapW = map.cols * TILE_SIZE;
    const mapH = map.rows * TILE_SIZE;
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
    if (!this.player) return;
    const px = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
    const py = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;
    this.mapContainer.x = PLAYER_PANEL_WIDTH + GRID_W / 2 - px * this.gridZoom;
    this.mapContainer.y = GRID_H / 2 - py * this.gridZoom;
    this.clampGridPan();
  }

  private resetGridView(): void {
    if (this.gameState) this.initView(this.gameState.map);
  }

  private clampGridPan(): void {
    if (!this.gameState) return;
    const margin = TILE_SIZE;
    const contentW = this.gameState.map.cols * TILE_SIZE;
    const contentH = this.gameState.map.rows * TILE_SIZE;
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
    return pointer.x >= PLAYER_PANEL_WIDTH && pointer.x < PLAYER_PANEL_WIDTH + GRID_W
      && pointer.y >= 0 && pointer.y < GRID_H;
  }

  // ── Overlays ──────────────────────────────────────────────────────────────

  private onOpenInventory(): void {
    if (this.aidmOverlay || this.inventoryOverlay || !this.gameState) return;
    const allItems = this.registry.get("items") as ItemDef[];
    const byId = Object.fromEntries(allItems.map(i => [i.id, i]));
    const inventory = this.gameState.player.inventoryIds.map(id => byId[id]).filter(Boolean) as ItemDef[];
    const { equippedSlots } = this.gameState.player;
    const canUse = this.gameState.phase === "exploring"
      || (this.gameState.phase === "player_turn" && !this.gameState.player.bonusActionUsed);

    this.inventoryOverlay = new InventoryOverlay(
      this,
      this.playerDef,
      { ...equippedSlots },
      inventory,
      allItems,
      canUse,
      (slot, itemId) => {
        gameClient.sendAction({ type: "equip", slot, itemId });
        this.inventoryOverlay = null;
      },
      (slot) => {
        gameClient.sendAction({ type: "unequip", slot });
        this.inventoryOverlay = null;
      },
      (_itemId) => {
        gameClient.sendAction({ type: "usePotion" });
        this.inventoryOverlay = null;
      },
      () => { this.inventoryOverlay = null; },
    );
  }

  private onOpenDM(): void {
    if (this.aidmOverlay || !this.gameState) return;
    this.aidmOverlay = new AIDMOverlay(
      this,
      this.aidmHistory,
      this.aidmPersona,
      (playerMessage, history, dmPersona) => gameClient.sendAIDMMessage(playerMessage, history, dmPersona),
      (history, persona) => {
        this.aidmHistory = history;
        this.aidmPersona = persona;
        this.aidmOverlay = null;
        this.input.keyboard?.enableGlobalCapture();
        if (this.gameState) this.updateHUD(this.gameState);
      },
    );
  }

  // ── Def lookups ───────────────────────────────────────────────────────────

  private findMonsterDef(defId: string): MonsterDef {
    const monsters = this.registry.get("monsters") as MonsterDef[];
    return monsters.find(m => m.id === defId) ?? monsters[0];
  }

  private findNpcMonsterDef(npcDefId: string): MonsterDef {
    const monsters = this.registry.get("monsters") as MonsterDef[];
    const npcs = this.registry.get("npcs") as NPCDef[];
    const npcDef = npcs.find(n => n.id === npcDefId);
    if (npcDef) {
      const base = monsters.find(m => m.id === npcDef.monsterClass) ?? monsters[0];
      return { ...base, id: npcDef.id, name: npcDef.name, color: npcDef.color };
    }
    return monsters.find(m => m.id === npcDefId) ?? monsters[0];
  }

  private findItemDef(defId: string): ItemDef {
    const items = this.registry.get("items") as ItemDef[];
    return items.find(i => i.id === defId) ?? items[0];
  }
}
