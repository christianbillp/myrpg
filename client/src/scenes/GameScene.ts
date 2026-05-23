import Phaser from "phaser";
import { Player } from "../entities/Player";
import { Enemy } from "../entities/Enemy";
import { NPC } from "../entities/NPC";
import { MapItem } from "../entities/MapItem";
import { PlayerPanel, QuestDisplay, PlayerPanelActionState } from "../ui/PlayerPanel";
import { TargetPanel } from "../ui/TargetPanel";
import { HUD, HUDState } from "../ui/HUD";
import { GridView } from "../systems/GridView";
import { OverlayManager } from "../systems/OverlayManager";
import { TILE_SIZE } from "../constants";
import { PlayerDef } from "../data/player";
import { MonsterDef, NPCDef } from "../data/monsters";
import { ItemDef } from "../data/items";
import { gameClient } from "../net/GameClient";
import type { GameState, GameEvent, GameMap } from "../net/types";

export class GameScene extends Phaser.Scene {
  private playerDef!: PlayerDef;

  private gameState!: GameState;
  private eventQueue: GameEvent[] = [];
  private animating = false;
  private mapDrawn = false;

  private player: Player | null = null;
  private enemyTokens = new Map<string, Enemy>();
  private npcTokens = new Map<string, NPC>();
  private itemTokens = new Map<string, MapItem>();

  private selectedEnemyId: string | null = null;
  private selectedNPCId: string | null = null;

  private playerPanel!: PlayerPanel;
  private targetPanel!: TargetPanel;
  private hud!: HUD;
  private gridView!: GridView;
  private overlays!: OverlayManager;
  private highlightLayer!: Phaser.GameObjects.Graphics;
  private localLogScrollOffset = 0;

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
    this.enemyTokens = new Map();
    this.npcTokens = new Map();
    this.itemTokens = new Map();
    this.selectedEnemyId = null;
    this.selectedNPCId = null;
    if (this.overlays) this.overlays.reset();
    this.localLogScrollOffset = 0;
  }

  create(): void {
    this.gridView = new GridView(this);
    this.highlightLayer = this.add.graphics();
    this.gridView.container.add(this.highlightLayer);

    this.overlays = new OverlayManager(this, this.playerDef, {
      onEquip:           (slot, itemId) => gameClient.sendAction({ type: "equip", slot, itemId }),
      onUnequip:         (slot) => gameClient.sendAction({ type: "unequip", slot }),
      onUsePotion:       () => gameClient.sendAction({ type: "usePotion" }),
      onSendAIDM:        (msg, history, persona) => gameClient.sendAIDMMessage(msg, history, persona),
      onKeyboardCapture: () => this.input.keyboard?.enableGlobalCapture(),
      onRefresh:         () => { if (this.gameState) this.updateHUD(this.gameState); },
    });

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
      this.gridView.container.addAt(this.drawMapTiles(state.map), 0);
      this.mapDrawn = true;
      this.gridView.initView(state.map, state.player.tileX, state.player.tileY);
    }

    if (!this.player) {
      this.player = new Player(this, state.player.tileX, state.player.tileY, this.playerDef.color);
      this.gridView.container.add(this.player.gameObject);
    } else {
      this.player.teleport(state.player.tileX, state.player.tileY);
    }
    this.player.setHp(state.player.hp, this.playerDef.maxHp);

    this.reconcileEnemies(state);
    this.reconcileNpcs(state);
    this.reconcileItems(state);
    this.reconcileSelection(state);

    this.overlays.showIntroIfNeeded(state);

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
        this.gridView.container.add(token.gameObject);
      }
      token.setLabel(eState.label);
      token.setLabelVisible(state.phase !== 'exploring');
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
        this.npcTokens.set(nState.id, token);
        this.gridView.container.add(token.gameObject);
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
        this.gridView.container.add(token.gameObject);
      }
    }
  }

  private reconcileSelection(state: GameState): void {
    const serverId = state.selectedTargetId;
    if (serverId === this.selectedEnemyId || serverId === this.selectedNPCId) {
      if (this.selectedEnemyId) {
        const eState = state.enemies.find(e => e.id === this.selectedEnemyId);
        if (eState && eState.hp > 0) this.targetPanel.refresh(eState.hp, eState.maxHp, eState.conditions);
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
      this.targetPanel.show(this.findMonsterDef(eState.defId), eState.hp, eState.conditions);
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
      if (this.overlays.isAnyOpen) return;
      if (!this.gridView.isPointerInBounds(pointer)) return;
      this.gridView.handleWheel(pointer, dy);
    });

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.gridView.pointerDown(p));
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => this.gridView.pointerMove(p));
    this.input.on("pointerup",   (p: Phaser.Input.Pointer) => {
      if (this.gridView.pointerUp(p)) this.handleMapClick(p);
    });
  }

  private handleMapClick(pointer: Phaser.Input.Pointer): void {
    if (!this.gameState) return;
    const { tileX, tileY } = this.gridView.toTile(pointer);
    const { cols, rows } = this.gameState.map;
    if (tileX < 0 || tileX >= cols || tileY < 0 || tileY >= rows) return;

    const { player: ps, enemies, npcs } = this.gameState;
    if (tileX === ps.tileX && tileY === ps.tileY) {
      this.playerPanel.toggle();
      return;
    }

    const eState = enemies.find(e => e.hp > 0 && e.tileX === tileX && e.tileY === tileY);
    const nState = npcs.find(n => n.tileX === tileX && n.tileY === tileY);

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
    if (eState) this.targetPanel.show(this.findMonsterDef(eState.defId), eState.hp, eState.conditions);
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
    if (this.overlays.isAnyOpen) return;
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
    this.playerPanel = new PlayerPanel(this, this.playerDef, {
      onOpenInventory: () => { if (this.gameState) this.overlays.openInventory(this.gameState); },
      onSearch:        () => gameClient.sendAction({ type: "search" }),
      onAttack:        () => gameClient.sendAction({ type: "attack" }),
      onDash:          () => gameClient.sendAction({ type: "dash" }),
      onDodge:         () => gameClient.sendAction({ type: "dodge" }),
      onDisengage:     () => gameClient.sendAction({ type: "disengage" }),
      onSecondWind:    () => gameClient.sendAction({ type: "secondWind" }),
      onHide:          () => gameClient.sendAction({ type: "hide" }),
      onEndTurn:       () => gameClient.sendAction({ type: "endTurn" }),
      onDeathSave:     () => gameClient.sendAction({ type: "rollDeathSave" }),
    });
    this.targetPanel = new TargetPanel(this);
    this.hud = new HUD(this, {
      onOpenDM:       () => this.overlays.openDM(),
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
      playerConditions:   state.player.conditions,
      activeEnemy,
      combatEnemies,
      enemyVexed:         activeEnemyState?.vexed ?? false,
      enemyHidden:        activeEnemyState?.hidden ?? false,
      deathSaveSuccesses: state.player.deathSaveSuccesses,
      deathSaveFailures:  state.player.deathSaveFailures,
      combatLog:          state.combatLog,
      logScrollOffset:    this.localLogScrollOffset,
      selectedEnemy,
      searchAvailable:    state.encounterTypes.includes("exploration") && state.secrets.length > 0,
    };
  }

  private buildActionState(state: GameState): PlayerPanelActionState {
    return {
      mode:             state.phase,
      actionUsed:       state.player.actionUsed,
      bonusActionUsed:  state.player.bonusActionUsed,
      playerHp:         state.player.hp,
      secondWindUses:   state.player.secondWindUses,
      playerHidden:     state.player.hidden,
      playerDef:        this.playerDef,
      enemies:          state.enemies.map(e => ({ tileX: e.tileX, tileY: e.tileY, dead: e.hp <= 0 })),
      playerTileX:      this.player?.tileX ?? state.player.tileX,
      playerTileY:      this.player?.tileY ?? state.player.tileY,
    };
  }

  private updateHUD(state: GameState): void {
    const quests: QuestDisplay[] = state.quests.map(q => ({
      title:     q.title,
      progress:  q.progress,
      target:    q.goalTarget,
      completed: q.completed,
    }));

    const showSearch = state.encounterTypes.includes("exploration") && state.secrets.length > 0;
    this.playerPanel.refresh(
      state.player.hp,
      this.playerDef.maxHp,
      state.player.xp,
      quests,
      showSearch,
    );

    if (this.selectedEnemyId) {
      const eState = state.enemies.find(e => e.id === this.selectedEnemyId);
      if (eState && eState.hp > 0) this.targetPanel.refresh(eState.hp, eState.maxHp);
    }

    this.playerPanel.refreshActions(this.buildActionState(state));
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
