import Phaser from "phaser";
import { Player } from "../entities/Player";
import { NpcToken } from "../entities/NpcToken";
import { MapItem } from "../entities/MapItem";
import { PlayerPanel, QuestDisplay, PlayerPanelActionState } from "../ui/PlayerPanel";
import { TargetPanel } from "../ui/TargetPanel";
import { HUD, HUDState } from "../ui/HUD";
import { UIScale } from "../ui/UIScale";
import { GridView } from "../systems/GridView";
import { OverlayManager } from "../systems/OverlayManager";
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, HUD_HEIGHT,
  PLAYER_PANEL_WIDTH, TARGET_PANEL_WIDTH,
} from "../constants";
import { PlayerDef } from "../data/player";
import { MonsterDef, NPCDef } from "../data/monsters";
import { ItemDef, WeaponDef } from "../data/items";
import { gameClient } from "../net/GameClient";
import type { GameState, GameEvent, GameMap } from "../net/types";

const GAME_W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const GAME_H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;

export class GameScene extends Phaser.Scene {
  private playerDef!: PlayerDef;

  private gameState!: GameState;
  private eventQueue: GameEvent[] = [];
  private animating = false;
  private mapDrawn = false;

  private player: Player | null = null;
  private npcTokens = new Map<string, NpcToken>();
  private itemTokens = new Map<string, MapItem>();

  private selectedEntityId: string | null = null;

  private uiScale!: UIScale;
  private playerPanel!: PlayerPanel;
  private targetPanel!: TargetPanel;
  private hud!: HUD;
  private uiDestroyed = false;
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
    this.npcTokens = new Map();
    this.itemTokens = new Map();
    this.selectedEntityId = null;
    this.uiDestroyed = false;
    if (this.overlays) this.overlays.reset();
    this.localLogScrollOffset = 0;
  }

  create(): void {
    this.uiScale = new UIScale(this.sys.game.canvas, GAME_W, GAME_H);

    this.gridView = new GridView(this);
    this.highlightLayer = this.add.graphics();
    this.gridView.container.add(this.highlightLayer);

    this.overlays = new OverlayManager(this.uiScale, this.playerDef, {
      onEquip:           (slot, itemId) => gameClient.sendAction({ type: "equip", slot, itemId }),
      onUnequip:         (slot) => gameClient.sendAction({ type: "unequip", slot }),
      onUsePotion:       () => gameClient.sendAction({ type: "usePotion" }),
      onSendAIDM:        (msg, persona) => gameClient.sendAIDMMessage(msg, persona),
      onDisableKeyboard: () => this.input.keyboard?.disableGlobalCapture(),
      onEnableKeyboard:  () => this.input.keyboard?.enableGlobalCapture(),
      onRefresh:         () => { if (this.gameState) this.updateHUD(this.gameState); },
      getItems:          () => this.registry.get("items") as ItemDef[],
    });

    this.setupInput();
    this.buildHUD();

    gameClient.setStateUpdateHandler((state, events) => this.handleStateUpdate(state, events));
    gameClient.connectWebSocket();
  }

  shutdown(): void {
    gameClient.disconnect();
    if (!this.uiDestroyed) {
      this.uiDestroyed = true;
      this.hud.destroy();
      this.playerPanel.destroy();
      this.targetPanel.destroy();
      this.uiScale.destroy();
    }
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
      const token = this.npcTokens.get(event.entityId);
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

    this.reconcileNpcs(state);
    this.reconcileItems(state);
    this.reconcileSelection(state);

    this.overlays.showIntroIfNeeded(state);

    this.updateHUD(state);
  }

  // ── Entity reconciliation ─────────────────────────────────────────────────

  private reconcileNpcs(state: GameState): void {
    const liveIds = new Set(state.npcs.filter(n => n.hp > 0).map(n => n.id));
    for (const [id, token] of this.npcTokens) {
      if (!liveIds.has(id)) {
        token.destroy();
        this.npcTokens.delete(id);
        if (this.selectedEntityId === id) {
          this.selectedEntityId = null;
          this.targetPanel.hide();
        }
      }
    }
    for (const nState of state.npcs) {
      if (nState.hp <= 0) continue;
      let token = this.npcTokens.get(nState.id);
      if (!token) {
        const def = this.resolveMonsterDef(nState.defId);
        token = new NpcToken(this, nState.id, def, nState.tileX, nState.tileY, nState.disposition, nState.hp, nState.maxHp);
        this.npcTokens.set(nState.id, token);
        this.gridView.container.add(token.gameObject);
      } else if (nState.disposition === "neutral") {
        token.teleport(nState.tileX, nState.tileY);
      }
      token.disposition = nState.disposition;
      token.setLabel(nState.label);
      token.setLabelVisible(nState.disposition !== "neutral" && state.phase !== "exploring");
      token.setHp(nState.hp);
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
    if (serverId === this.selectedEntityId) {
      if (this.selectedEntityId) {
        const nState = state.npcs.find(n => n.id === this.selectedEntityId);
        if (nState && nState.hp > 0) this.targetPanel.refresh(nState.hp, nState.maxHp, nState.conditions);
      }
      return;
    }

    if (this.selectedEntityId) {
      this.npcTokens.get(this.selectedEntityId)?.setSelected(false);
      this.selectedEntityId = null;
    }

    if (!serverId) { this.targetPanel.hide(); return; }

    const nState = state.npcs.find(n => n.id === serverId && n.hp > 0);
    if (nState) {
      this.selectedEntityId = serverId;
      this.npcTokens.get(serverId)?.setSelected(true);
      const def = this.resolveMonsterDef(nState.defId);
      this.targetPanel.show(def, nState.hp, nState.conditions);
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

    const { player: ps, npcs } = this.gameState;
    if (tileX === ps.tileX && tileY === ps.tileY) {
      this.playerPanel.toggle();
      return;
    }

    const nState = npcs.find(n => n.hp > 0 && n.tileX === tileX && n.tileY === tileY);
    if (nState) {
      this.selectEntity(nState.id);
    } else {
      this.clearSelection();
    }
  }

  private selectEntity(id: string): void {
    if (this.selectedEntityId === id) return;
    if (this.selectedEntityId) this.npcTokens.get(this.selectedEntityId)?.setSelected(false);
    this.selectedEntityId = id;
    this.npcTokens.get(id)?.setSelected(true);
    const nState = this.gameState.npcs.find(n => n.id === id);
    if (nState) {
      const def = this.resolveMonsterDef(nState.defId);
      this.targetPanel.show(def, nState.hp, nState.conditions);
    }
    gameClient.sendAction({ type: "selectTarget", entityId: id });
    if (this.gameState) this.updateHUD(this.gameState);
  }

  private clearSelection(): void {
    if (this.selectedEntityId) {
      this.npcTokens.get(this.selectedEntityId)?.setSelected(false);
      this.selectedEntityId = null;
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

    const { map, npcs } = this.gameState;
    const px = this.player.tileX;
    const py = this.player.tileY;
    const nx = px + dx, ny = py + dy;

    if (nx < 0 || ny < 0 || nx >= map.cols || ny >= map.rows) return;
    if (!map.passable[ny][nx]) return;
    if (npcs.some(n => n.hp > 0 && n.tileX === nx && n.tileY === ny)) return;

    this.player.move(dx, dy, map.cols, map.rows);
    gameClient.sendAction({ type: "move", dx, dy });
  }

  // ── HUD ──────────────────────────────────────────────────────────────────

  private buildHUD(): void {
    this.playerPanel = new PlayerPanel(this.uiScale, this.playerDef, {
      onOpenInventory: () => { if (this.gameState) this.overlays.openInventory(this.gameState); },
      onSearch:        () => gameClient.sendAction({ type: "search" }),
      onAttack:        () => gameClient.sendAction({ type: "attack", targetId: this.gameState?.selectedTargetId ?? undefined }),
      onThrow:         (itemId) => gameClient.sendAction({ type: "throw", itemId, targetId: this.gameState?.selectedTargetId ?? undefined }),
      onDash:          () => gameClient.sendAction({ type: "dash" }),
      onDodge:         () => gameClient.sendAction({ type: "dodge" }),
      onDisengage:     () => gameClient.sendAction({ type: "disengage" }),
      onSecondWind:    () => gameClient.sendAction({ type: "secondWind" }),
      onHide:          () => gameClient.sendAction({ type: "hide" }),
      onEndTurn:       () => gameClient.sendAction({ type: "endTurn" }),
      onDeathSave:     () => gameClient.sendAction({ type: "rollDeathSave" }),
      onShortRest:     () => gameClient.sendAction({ type: "shortRest" }),
    });
    this.targetPanel = new TargetPanel(this.uiScale);
    this.hud = new HUD(this.uiScale, {
      onOpenDM:       () => this.overlays.openDM(),
      onNewEncounter: () => {
        this.uiDestroyed = true;
        this.playerPanel.destroy();
        this.targetPanel.destroy();
        this.hud.destroy();
        this.uiScale.destroy();
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
    const activeNpcState = state.npcs.find(n => n.isActive);
    const activeNpc = activeNpcState ? (this.npcTokens.get(activeNpcState.id) ?? null) : null;
    const selectedNpc = this.selectedEntityId ? (this.npcTokens.get(this.selectedEntityId) ?? null) : null;
    const combatNpcs = state.npcs
      .filter(n => n.disposition !== "neutral" && n.hp > 0)
      .map(n => this.npcTokens.get(n.id))
      .filter((n): n is NpcToken => n !== undefined);

    return {
      mode:               state.phase,
      playerDef:          this.playerDef,
      playerHp:           state.player.hp,
      movesLeft:          state.player.movesLeft,
      actionUsed:         state.player.actionUsed,
      bonusActionUsed:    state.player.bonusActionUsed,
      playerHidden:       state.player.hidden,
      playerConditions:   state.player.conditions,
      activeNpc,
      combatNpcs,
      enemyVexed:         activeNpcState?.conditions.includes('vexed') ?? false,
      enemyHidden:        activeNpcState?.conditions.includes('hidden') ?? false,
      deathSaveSuccesses: state.player.deathSaveSuccesses,
      deathSaveFailures:  state.player.deathSaveFailures,
      combatLog:          state.combatLog,
      logScrollOffset:    this.localLogScrollOffset,
      selectedNpc,
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
      npcs:             state.npcs.map(n => ({ id: n.id, tileX: n.tileX, tileY: n.tileY, disposition: n.disposition, dead: n.hp <= 0 })),
      selectedTargetId: state.selectedTargetId,
      playerTileX:      this.player?.tileX ?? state.player.tileX,
      playerTileY:      this.player?.tileY ?? state.player.tileY,
      hitDiceRemaining: this.playerDef.level - state.player.hitDiceUsed,
      throwableItems:   (() => {
        const allItems = this.registry.get("items") as ItemDef[];
        const px = this.player?.tileX ?? state.player.tileX;
        const py = this.player?.tileY ?? state.player.tileY;
        return [...new Set(state.player.inventoryIds)]
          .map(id => allItems.find(i => i.id === id))
          .filter((i): i is ItemDef => i !== undefined)
          .filter(itemDef => {
            const longRangeTiles = itemDef.type === "weapon" && (itemDef as WeaponDef).thrown
              ? Math.floor((itemDef as WeaponDef).throwLong / 5)
              : 12;
            return state.npcs.some(n =>
              n.disposition === "enemy" && n.hp > 0 &&
              Math.max(Math.abs(n.tileX - px), Math.abs(n.tileY - py)) <= longRangeTiles,
            );
          })
          .map(i => ({ id: i.id, name: i.name }));
      })(),
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

    if (this.selectedEntityId) {
      const nState = state.npcs.find(n => n.id === this.selectedEntityId);
      if (nState && nState.hp > 0) this.targetPanel.refresh(nState.hp, nState.maxHp, nState.conditions);
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
      for (const [dr, dc] of [
        [0, 1], [0, -1], [1, 0], [-1, 0],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
      ] as [number, number][]) {
        const nr = cy + dr, nc = cx + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (!passable[nr][nc]) continue;
        if (dr !== 0 && dc !== 0 && !passable[cy][nc] && !passable[nr][cx]) continue;
        if (state.npcs.some(n => n.hp > 0 && n.tileX === nc && n.tileY === nr)) continue;
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

  private resolveMonsterDef(defId: string): MonsterDef {
    const monsters = this.registry.get("monsters") as MonsterDef[];
    const monster = monsters.find(m => m.id === defId);
    if (monster) return monster;
    const npcs = this.registry.get("npcs") as NPCDef[];
    const npcDef = npcs.find(n => n.id === defId);
    if (npcDef) {
      const base = monsters.find(m => m.id === npcDef.monsterClass) ?? monsters[0];
      return { ...base, id: npcDef.id, name: npcDef.name, color: npcDef.color };
    }
    return monsters[0];
  }

  private findItemDef(defId: string): ItemDef {
    const items = this.registry.get("items") as ItemDef[];
    return items.find(i => i.id === defId) ?? items[0];
  }
}
