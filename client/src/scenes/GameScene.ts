import Phaser from "phaser";
import { tilesetTextureKey } from "./BootScene";
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
import { ItemDef } from "../data/equipment";
import { gameClient } from "../net/GameClient";
import type { GameState, GameEvent, GameMap, SpellDef, FeatureDef } from "../net/types";
import type { ChatMessage } from "../ui/AIDMOverlay";

const GAME_W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const GAME_H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;
const MAP_TILE_ALPHA = 0.7;

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
  private movePathLayer!: Phaser.GameObjects.Graphics;
  /** Persistent overlays driven by player state: Detect Magic ring, etc. Redrawn each state tick. */
  private spellAuraLayer!: Phaser.GameObjects.Graphics;
  /** Cursor-following AOE preview during spell-targeting mode. Cleared on exit. */
  private spellAoeLayer!: Phaser.GameObjects.Graphics;
  private moveMode = false;
  private moveDist: number[][] = [];
  private movePrev: Array<Array<[number, number] | null>> = [];
  /** Spell-targeting mode — set after CAST on a spell that needs a target.
   *   - `kind: "creature"` waits for a creature click (attack-roll / auto-hit).
   *   - `kind: "aoe"`      waits for a tile click. The area shape determines
   *                       what gets highlighted as the cursor moves:
   *                         shape "cone"  — origin = player tile, direction = cursor.
   *                         shape "sphere"/"cube" + selfAnchored — disc on player tile.
   *                         shape "sphere"/"cube" otherwise        — disc on cursor tile. */
  private spellTargetMode:
    | { kind: "creature"; spellId: string; spellName: string; asRitual: boolean }
    | { kind: "aoe"; spellId: string; spellName: string; asRitual: boolean; radiusTiles: number; selfAnchored: boolean; shape: "cone" | "sphere" | "cube" | "line" }
    | null = null;
  private pendingDmHistory: ChatMessage[] = [];
  private pendingIsResume = false;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
  };
  private escKey!: Phaser.Input.Keyboard.Key;

  constructor() {
    super({ key: "GameScene" });
  }

  init(data: { sessionId: string; playerDef: PlayerDef; dmHistory?: ChatMessage[]; isResume?: boolean }): void {
    this.playerDef = data.playerDef;
    this.pendingIsResume = data.isResume ?? false;
    this.pendingDmHistory = data.isResume ? (data.dmHistory ?? []) : [];
    this.player = null;
    this.eventQueue = [];
    this.animating = false;
    this.mapDrawn = false;
    this.npcTokens = new Map();
    this.itemTokens = new Map();
    this.selectedEntityId = null;
    this.uiDestroyed = false;
    this.moveMode = false;
    this.moveDist = [];
    this.movePrev = [];
    if (this.overlays) this.overlays.reset();
  }

  create(): void {
    this.uiScale = new UIScale(this.sys.game.canvas, GAME_W, GAME_H);

    this.gridView = new GridView(this);
    this.highlightLayer = this.add.graphics();
    this.movePathLayer  = this.add.graphics();
    this.spellAuraLayer = this.add.graphics();
    this.spellAoeLayer  = this.add.graphics();
    this.gridView.container.add(this.highlightLayer);
    this.gridView.container.add(this.movePathLayer);
    this.gridView.container.add(this.spellAuraLayer);
    this.gridView.container.add(this.spellAoeLayer);

    this.overlays = new OverlayManager(this.uiScale, this.playerDef, {
      onEquip:     (slot, itemId) => gameClient.sendAction({ type: "equip", slot, itemId }),
      onUnequip:   (slot) => gameClient.sendAction({ type: "unequip", slot }),
      onUsePotion: () => gameClient.sendAction({ type: "usePotion" }),
      onBeginSpellCast:  (spellId) => this.beginSpellCast(spellId, false),
      onBeginRitualCast: (spellId) => this.beginSpellCast(spellId, true),
      onAcceptReaction:  () => gameClient.sendAction({ type: "resolveReaction", accept: true }),
      onDeclineReaction: () => gameClient.sendAction({ type: "resolveReaction", accept: false }),
      getItems:    () => this.registry.get("equipment") as ItemDef[],
      getSpells:   () => (this.registry.get("spells") ?? []) as SpellDef[],
    });
    if (this.pendingIsResume) this.overlays.markResumed();

    this.setupInput();
    this.buildHUD();
    if (this.pendingIsResume) this.hud.seedDmHistory(this.pendingDmHistory);

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
      if (event.entityId === 'player' && this.player) {
        this.player.moveTo(event.toX, event.toY, () => {
          this.animating = false;
          this.processNextEvent();
        });
        return;
      }
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
    this.overlays.refreshCharacterSheetIfOpen(state);
    this.overlays.syncReactionPrompt(state);

    this.updateHUD(state);
  }

  // ── Entity reconciliation ─────────────────────────────────────────────────

  private reconcileNpcs(state: GameState): void {
    const allIds = new Set(state.npcs.map(n => n.id));
    for (const [id, token] of this.npcTokens) {
      if (!allIds.has(id)) {
        token.destroy();
        this.npcTokens.delete(id);
        if (this.selectedEntityId === id) {
          this.selectedEntityId = null;
          this.targetPanel.hide();
        }
      }
    }
    for (const nState of state.npcs) {
      let token = this.npcTokens.get(nState.id);
      if (!token) {
        const def = this.resolveMonsterDef(nState.defId);
        token = new NpcToken(this, nState.id, def, nState.tileX, nState.tileY, nState.disposition, nState.hp, nState.maxHp);
        token.setNameText(nState.name);
        this.npcTokens.set(nState.id, token);
        this.gridView.container.add(token.gameObject);
      } else if (nState.disposition === "neutral" && nState.hp > 0) {
        token.teleport(nState.tileX, nState.tileY);
      }
      token.disposition = nState.disposition;
      token.setHp(nState.hp);
      if (nState.hp <= 0) {
        token.setDead();
      } else {
        token.setCombatLabel(nState.combatLabel);
        token.setLabelVisible(nState.disposition !== "neutral" && state.phase !== "exploring");
        if (nState.revealedName) token.setNameText(nState.revealedName);
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
    if (serverId === this.selectedEntityId) {
      if (this.selectedEntityId) {
        const nState = state.npcs.find(n => n.id === this.selectedEntityId);
        if (nState) this.targetPanel.refresh(nState, nState.maxHp);
      }
      return;
    }

    if (this.selectedEntityId) {
      this.npcTokens.get(this.selectedEntityId)?.setSelected(false);
      this.selectedEntityId = null;
    }

    if (!serverId) { this.targetPanel.hide(); return; }

    const nState = state.npcs.find(n => n.id === serverId);
    if (nState) {
      this.selectedEntityId = serverId;
      this.npcTokens.get(serverId)?.setSelected(true);
      const def = this.resolveMonsterDef(nState.defId);
      this.targetPanel.show(def, nState, nState.conditions);
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
    this.escKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);

    this.input.on("wheel", (pointer: Phaser.Input.Pointer, _go: unknown, _dx: number, dy: number) => {
      if (this.overlays.isAnyOpen) return;
      if (!this.gridView.isPointerInBounds(pointer)) return;
      this.gridView.handleWheel(pointer, dy);
    });

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.gridView.pointerDown(p));
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      this.gridView.pointerMove(p);
      this.drawMovePreview(p);
      this.drawSpellAoePreview(p);
    });
    this.input.on("pointerup",   (p: Phaser.Input.Pointer) => {
      if (this.gridView.pointerUp(p)) this.handleMapClick(p);
    });
  }

  private handleMapClick(pointer: Phaser.Input.Pointer): void {
    if (!this.gameState) return;
    const { tileX, tileY } = this.gridView.toTile(pointer);
    const { cols, rows } = this.gameState.map;
    if (tileX < 0 || tileX >= cols || tileY < 0 || tileY >= rows) return;

    if (this.moveMode) {
      const reachable = (this.moveDist[tileY]?.[tileX] ?? -1) > 0;
      this.exitMoveMode();
      if (reachable) gameClient.sendAction({ type: "moveTo", tileX, tileY });
      return;
    }

    const { player: ps, npcs } = this.gameState;
    const nState = npcs.find(n => n.hp > 0 && n.tileX === tileX && n.tileY === tileY)
      ?? npcs.find(n => n.tileX === tileX && n.tileY === tileY);

    // Spell-target mode swallows the click. For creature-target spells, a
    // creature click resolves and anything else cancels. For AOE spells, ANY
    // tile click resolves at that tile (self-anchored spells ignore the tile
    // and re-center on the player).
    if (this.spellTargetMode) {
      if (this.spellTargetMode.kind === "creature") {
        const validTarget = nState && nState.hp > 0 ? nState.id : null;
        this.finishSpellTargetClick(validTarget, tileX, tileY);
      } else {
        this.finishSpellTargetClick(null, tileX, tileY);
      }
      return;
    }

    if (tileX === ps.tileX && tileY === ps.tileY) {
      this.playerPanel.toggle();
      return;
    }

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
      this.targetPanel.show(def, nState, nState.conditions);
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
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;

    if (this.moveMode && Phaser.Input.Keyboard.JustDown(this.escKey))
      this.exitMoveMode();
    if (this.spellTargetMode && Phaser.Input.Keyboard.JustDown(this.escKey))
      this.exitSpellTargetMode();

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

    gameClient.sendAction({ type: "move", dx, dy });
  }

  // ── HUD ──────────────────────────────────────────────────────────────────

  private buildHUD(): void {
    this.playerPanel = new PlayerPanel(this.uiScale, this.playerDef, {
      onOpenCharacterSheet: () => { if (this.gameState) this.overlays.openCharacterSheet(this.gameState); },
      onSearch:         () => gameClient.sendAction({ type: "search" }),
      onAttack:         () => gameClient.sendAction({ type: "attack", targetId: this.gameState?.selectedTargetId ?? undefined }),
      onThrow:          (itemId) => gameClient.sendAction({ type: "throw", itemId, targetId: this.gameState?.selectedTargetId ?? undefined }),
      onDash:           () => gameClient.sendAction({ type: "dash" }),
      onDodge:          () => gameClient.sendAction({ type: "dodge" }),
      onDisengage:      () => gameClient.sendAction({ type: "disengage" }),
      onUseFeature:     (featureId) => gameClient.sendAction({ type: "useFeature", featureId }),
      onHide:           () => gameClient.sendAction({ type: "hide" }),
      onDeathSave:      () => gameClient.sendAction({ type: "rollDeathSave" }),
      onShortRest:      () => gameClient.sendAction({ type: "shortRest" }),
      onToggleMoveMode: () => this.toggleMoveMode(),
      onEndTurn:        () => gameClient.sendAction({ type: "endTurn" }),
      onLeaveEncounter: () => {
        this.uiDestroyed = true;
        this.playerPanel.destroy();
        this.targetPanel.destroy();
        this.hud.destroy();
        this.uiScale.destroy();
        gameClient.disconnect().then(() => this.scene.start("EncounterSetupScene"));
      },
    });
    this.targetPanel = new TargetPanel(this.uiScale);
    this.hud = new HUD(this.uiScale, {
      onSendAIDM:        (msg, persona) => gameClient.sendAIDMMessage(msg, persona),
      onDisableKeyboard: () => this.input.keyboard?.disableGlobalCapture(),
      onEnableKeyboard:  () => this.input.keyboard?.enableGlobalCapture(),
    });
    // E. Hook the AIDM streaming protocol into the HUD's chat panel.
    gameClient.setAIDMStreamHandlers({
      onStart:              () => this.hud.aidmStart(),
      onChunk:              (text) => this.hud.aidmChunk(text),
      onCheckpoint:         () => this.hud.aidmCheckpoint(),
      onSpeculativeDiscard: () => this.hud.aidmSpeculativeDiscard(),
      onDone:               (reply, rollResults) => this.hud.aidmDone(reply, rollResults),
    });
  }

  private buildHUDState(state: GameState): HUDState {
    const selectedNpcName = state.selectedTargetId
      ? (() => { const n = state.npcs.find(n => n.id === state.selectedTargetId); return n ? (n.revealedName ?? n.name) : null; })()
      : null;

    // Build initiative-ordered turn-order chips directly from turnOrderIds.
    // Falls back to a simple player-first list when combat hasn't begun.
    const turnOrderChips = state.turnOrderIds.length > 0
      ? state.turnOrderIds.flatMap((id) => {
          if (id === 'player') {
            return [{
              label: '',
              name: this.playerDef.name,
              color: this.playerDef.color,
              isActive: state.phase === 'player_turn' || state.phase === 'death_saves',
              isDead: state.player.hp <= 0,
            }];
          }
          const npc = state.npcs.find(n => n.id === id);
          if (!npc) return [];
          const def = this.resolveMonsterDef(npc.defId);
          return [{
            label: npc.combatLabel,
            name: npc.revealedName ?? def.name,
            color: def.color,
            isActive: !!npc.isActive,
            isDead: npc.hp <= 0,
          }];
        })
      : [];

    return {
      mode:      state.phase,
      playerDef: this.playerDef,
      playerHp:  state.player.hp,
      turnOrderChips,
      combatLog: state.combatLog,
      selectedNpcName,
    };
  }

  private buildActionState(state: GameState): PlayerPanelActionState {
    const allItems = this.registry.get('equipment') as ItemDef[];
    const allSpells = (this.registry.get('spells') ?? []) as SpellDef[];
    const weaponId = state.player.equippedSlots.weaponId;
    const weapon = weaponId ? allItems.find(i => i.id === weaponId) : undefined;
    const mainAttackName = weapon?.name ?? 'Unarmed Strike';

    // Build castable spell info — cantrips + prepared, then filter to castableSpellIds.
    const concSpell = state.player.concentratingOn
      ? allSpells.find(sp => sp.id === state.player.concentratingOn)
      : null;

    // Class features the character knows — map each to a panel-ready display
    // record. Hides features without a button (passive / attack-time).
    const allFeatures = (this.registry.get('features') ?? []) as FeatureDef[];
    const knownFeatureIds = this.playerDef.defaultFeatureIds ?? [];
    const features = knownFeatureIds
      .map((id) => allFeatures.find((f) => f.id === id))
      .filter((f): f is FeatureDef => !!f)
      .map((f) => {
        const remaining = state.player.resources[f.id] ?? 0;
        const max = f.resource?.max ?? 0;
        const tmpl = f.ui?.resourceLabel;
        const chip = tmpl && f.resource && f.resource.kind !== 'unlimited'
          ? tmpl.replace('{remaining}', String(remaining)).replace('{max}', String(max))
          : null;
        return {
          id: f.id,
          name: f.name,
          buttonLabel: f.ui?.buttonLabel ?? '',
          buttonColor: f.ui?.buttonColor ?? '#1a3a5a',
          resourceChipText: chip,
        };
      });

    return {
      mode:            state.phase,
      actionUsed:      state.player.actionUsed,
      bonusActionUsed: state.player.bonusActionUsed,
      movesLeft:       state.player.movesLeft,
      moveMode:        this.moveMode,
      throwableItems:  state.availableActions.throwableItemIds
        .map(id => allItems.find(i => i.id === id))
        .filter((i): i is ItemDef => i !== undefined)
        .map(i => ({ id: i.id, name: i.name })),
      availableActions: state.availableActions,
      mainAttackName,
      spellSlots:        state.player.spellSlots,
      concentratingOn:   state.player.concentratingOn,
      concentratingOnName: concSpell?.name ?? null,
      features,
      spellTargetPrompt: this.spellTargetMode
        ? { spellName: this.spellTargetMode.spellName, asRitual: this.spellTargetMode.asRitual }
        : null,
    };
  }

  /**
   * Entry point from the Character Sheet's CAST / RITUAL CAST buttons. If the
   * spell needs a target (attack-roll spell), we enter `spellTargetMode` and
   * wait for the next creature click; otherwise the spell fires immediately
   * against the player tile.
   */
  private beginSpellCast(spellId: string, asRitual: boolean): void {
    const allSpells = (this.registry.get('spells') ?? []) as SpellDef[];
    const spell = allSpells.find(sp => sp.id === spellId);
    if (!spell) return;
    const slotLevel = spell.level === 0 ? 0 : spell.level;

    const needsCreatureTarget =
      spell.attack === 'ranged-spell' || spell.attack === 'melee-spell' || spell.attack === 'auto-hit';
    const isAoe = !!spell.area;

    if (needsCreatureTarget) {
      this.spellTargetMode = { kind: "creature", spellId, spellName: spell.name, asRitual };
    } else if (isAoe) {
      const radiusTiles = Math.max(1, Math.ceil((spell.area?.sizeFeet ?? 5) / 5));
      const selfAnchored = spell.range === 'self' || spell.rangeFeet === 0;
      const shape = (spell.area?.shape ?? "sphere") as "cone" | "sphere" | "cube" | "line";
      this.spellTargetMode = { kind: "aoe", spellId, spellName: spell.name, asRitual, radiusTiles, selfAnchored, shape };
    } else {
      // Self / utility: fire immediately.
      gameClient.sendAction({ type: "castSpell", spellId, slotLevel, asRitual });
      return;
    }

    if (this.gameState) this.playerPanel.refreshActions(this.buildActionState(this.gameState));
  }

  private exitSpellTargetMode(): void {
    if (!this.spellTargetMode) return;
    this.spellTargetMode = null;
    this.spellAoeLayer.clear();
    if (this.gameState) this.playerPanel.refreshActions(this.buildActionState(this.gameState));
  }

  /** Resolve a click while in spell-target mode. Single-target spells take a creature id; AOE spells take a tile. Any other click cancels. */
  private finishSpellTargetClick(targetNpcId: string | null, tileX: number, tileY: number): void {
    const stm = this.spellTargetMode;
    if (!stm) return;
    const allSpells = (this.registry.get('spells') ?? []) as SpellDef[];
    const spell = allSpells.find(sp => sp.id === stm.spellId);
    if (!spell) { this.exitSpellTargetMode(); return; }
    const slotLevel = spell.level === 0 ? 0 : spell.level;

    if (stm.kind === "creature") {
      if (!targetNpcId) { this.exitSpellTargetMode(); return; }
      gameClient.sendAction({ type: "castSpell", spellId: stm.spellId, slotLevel, targetIds: [targetNpcId], asRitual: stm.asRitual });
    } else {
      // AOE: the `tile` payload is the cursor click. For cones it tells the
      // server the direction; for spheres/cubes it's the centre. Self-anchored
      // sphere spells ignore the tile server-side but we still pass cursor —
      // server resolves correctly either way.
      const tile = { x: tileX, y: tileY };
      gameClient.sendAction({ type: "castSpell", spellId: stm.spellId, slotLevel, tile, asRitual: stm.asRitual });
    }
    this.exitSpellTargetMode();
  }

  private updateHUD(state: GameState): void {
    const quests: QuestDisplay[] = state.quests.map(q => ({
      title:     q.title,
      progress:  q.progress,
      target:    q.goalTarget,
      completed: q.completed,
    }));

    const showSearch = state.secrets.length > 0;
    this.playerPanel.refresh(
      state.player.hp,
      this.playerDef.maxHp,
      quests,
      showSearch,
    );

    if (this.selectedEntityId) {
      const nState = state.npcs.find(n => n.id === this.selectedEntityId);
      if (nState && nState.hp > 0) this.targetPanel.refresh(nState, nState.maxHp);
    }

    this.playerPanel.refreshActions(this.buildActionState(state));
    this.hud.refresh(this.buildHUDState(state));
    this.drawHighlights(state);
    this.drawSpellAura(state);
  }

  // ── Map drawing ───────────────────────────────────────────────────────────

  /**
   * Render the tile layer(s). If the map carries Tiled tileset metadata
   * (`gidGrid` + `tilesets`), each GID is looked up in the matching tileset
   * and drawn from the preloaded spritesheet — ground layer first, then the
   * optional object layer on top. Procedural maps with no tileset info fall
   * back to a simple coloured fill per tile.
   */
  private drawMapTiles(map: GameMap): Phaser.GameObjects.Container {
    const container = this.add.container();
    if (map.gidGrid && map.tilesets && map.tilesets.length > 0) {
      // Sort tilesets by descending firstgid so the lookup picks the highest
      // firstgid ≤ gid (Tiled's standard scheme for multi-tileset maps).
      const tilesets = [...map.tilesets].sort((a, b) => b.firstgid - a.firstgid);
      const drawGrid = (grid: number[][]): void => {
        for (let row = 0; row < map.rows; row++) {
          for (let col = 0; col < map.cols; col++) {
            const gid = grid[row][col];
            if (!gid) continue;
            const ts = tilesets.find((t) => gid >= t.firstgid);
            if (!ts) continue;
            const frame = gid - ts.firstgid;
            const sprite = this.add.image(
              col * TILE_SIZE + TILE_SIZE / 2,
              row * TILE_SIZE + TILE_SIZE / 2,
              tilesetTextureKey(ts.imageUrl),
              frame,
            );
            sprite.setDisplaySize(TILE_SIZE, TILE_SIZE);
            sprite.setAlpha(MAP_TILE_ALPHA);
            container.add(sprite);
          }
        }
      };
      drawGrid(map.gidGrid);
      if (map.objectGidGrid) drawGrid(map.objectGidGrid);
    } else {
      // Fallback (procedural maps): solid-fill rectangles like before.
      const g = this.add.graphics();
      for (let row = 0; row < map.rows; row++) {
        for (let col = 0; col < map.cols; col++) {
          g.fillStyle(map.passable[row][col] ? 0x16213e : 0x05080f);
          g.fillRect(col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        }
      }
      container.add(g);
    }
    return container;
  }

  private drawHighlights(state: GameState): void {
    this.highlightLayer.clear();
    this.movePathLayer.clear();
    if (!this.player) return;

    const inCombatTurn = state.phase === "player_turn" && state.player.movesLeft > 0;
    const inExploringMoveMode = state.phase === "exploring" && this.moveMode;
    if (!inCombatTurn && !inExploringMoveMode) return;

    const { cols, rows, passable } = state.map;
    const px = this.player.tileX, py = this.player.tileY;

    const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
    const prev: Array<Array<[number, number] | null>> = Array.from({ length: rows }, () => new Array(cols).fill(null));
    dist[py][px] = 0;
    const queue: [number, number][] = [[py, px]];

    // Combat caps movement by movesLeft; exploration walk is unlimited.
    const maxDist = state.phase === "player_turn" ? state.player.movesLeft : Infinity;

    while (queue.length > 0) {
      const [cy, cx] = queue.shift()!;
      if (dist[cy][cx] >= maxDist) continue;
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
        prev[nr][nc] = [cy, cx];
        queue.push([nr, nc]);
      }
    }

    this.moveDist = dist;
    this.movePrev = prev;

    const color = this.moveMode ? 0xccaa00 : 0x4fc3f7;
    const alpha = this.moveMode ? 0.22 : 0.15;
    this.highlightLayer.fillStyle(color, alpha);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (dist[row][col] > 0)
          this.highlightLayer.fillRect(col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
    }
  }

  /**
   * Persistent overlay driven by concentration / lasting-effect state. Right now
   * it draws the Detect Magic 30-ft sense ring; future ambient effects (Faerie
   * Fire glow, Hex marker, etc.) plug in here.
   */
  private drawSpellAura(state: GameState): void {
    this.spellAuraLayer.clear();
    if (!this.player) return;
    if (state.player.concentratingOn === "detect-magic") {
      const cx = this.player.tileX * TILE_SIZE + TILE_SIZE / 2;
      const cy = this.player.tileY * TILE_SIZE + TILE_SIZE / 2;
      const radius = 6 * TILE_SIZE; // 30 ft = 6 tiles
      this.spellAuraLayer.lineStyle(2, 0xffffff, 0.6);
      this.spellAuraLayer.strokeCircle(cx, cy, radius);
      // Inner fill — very faint so it doesn't clobber map detail.
      this.spellAuraLayer.fillStyle(0xffffff, 0.04);
      this.spellAuraLayer.fillCircle(cx, cy, radius);
    }
  }

  /**
   * AOE preview during spell-targeting mode. The shape of the highlight
   * matches the spell's `area.shape` and the same tile-set logic the server
   * uses to find affected creatures, so what you see is what gets hit.
   *
   *   - cone   → origin = player tile, direction = cursor. Tiles within the
   *             53°-half-angle expanding triangle out to `radiusTiles`.
   *   - sphere/cube + selfAnchored → chebyshev disc centred on player.
   *   - sphere/cube otherwise       → chebyshev disc centred on cursor.
   */
  private drawSpellAoePreview(pointer: Phaser.Input.Pointer): void {
    this.spellAoeLayer.clear();
    const stm = this.spellTargetMode;
    if (!stm || stm.kind !== "aoe" || !this.gameState || !this.player) return;
    const { tileX, tileY } = this.gridView.toTile(pointer);
    const { cols, rows } = this.gameState.map;
    const r = stm.radiusTiles;
    this.spellAoeLayer.fillStyle(0xff8844, 0.28);

    const paintTile = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      this.spellAoeLayer.fillRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    };

    if (stm.shape === "cone") {
      const ox = this.player.tileX, oy = this.player.tileY;
      let dx = tileX - ox, dy = tileY - oy;
      const len = Math.hypot(dx, dy);
      if (len === 0) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
      for (let ry = -r; ry <= r; ry++) {
        for (let rx = -r; rx <= r; rx++) {
          if (rx === 0 && ry === 0) continue;
          const along = rx * dx + ry * dy;
          if (along <= 0 || along > r + 0.5) continue;
          const perp = Math.abs(-rx * dy + ry * dx);
          if (perp > along * 0.5 + 0.5) continue;
          paintTile(ox + rx, oy + ry);
        }
      }
    } else {
      const center = stm.selfAnchored
        ? { x: this.player.tileX, y: this.player.tileY }
        : { x: tileX, y: tileY };
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) > r) continue;
          paintTile(center.x + dx, center.y + dy);
        }
      }
    }
  }

  private drawMovePreview(pointer: Phaser.Input.Pointer): void {
    this.movePathLayer.clear();
    if (!this.moveMode || !this.player || !this.moveDist.length) return;
    const { tileX, tileY } = this.gridView.toTile(pointer);
    if (this.moveDist[tileY]?.[tileX] <= 0) return;

    const path: [number, number][] = [];
    let cur: [number, number] = [tileY, tileX];
    const py = this.player.tileY, px = this.player.tileX;
    while (cur[0] !== py || cur[1] !== px) {
      path.push(cur);
      const p = this.movePrev[cur[0]]?.[cur[1]];
      if (!p) break;
      cur = p;
    }

    this.movePathLayer.fillStyle(0xff9900, 0.45);
    for (const [row, col] of path)
      this.movePathLayer.fillRect(col * TILE_SIZE + 1, row * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
  }

  private toggleMoveMode(): void {
    if (this.moveMode) this.exitMoveMode();
    else this.enterMoveMode();
  }

  private enterMoveMode(): void {
    this.moveMode = true;
    if (this.gameState) {
      this.drawHighlights(this.gameState);
      this.playerPanel.refreshActions(this.buildActionState(this.gameState));
    }
  }

  private exitMoveMode(): void {
    this.moveMode = false;
    this.movePathLayer.clear();
    if (this.gameState) {
      this.drawHighlights(this.gameState);
      this.playerPanel.refreshActions(this.buildActionState(this.gameState));
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
    const items = this.registry.get("equipment") as ItemDef[];
    return items.find(i => i.id === defId) ?? items[0];
  }
}
