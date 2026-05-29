import Phaser from "phaser";
import { tilesetTextureKey, tokenTextureKey } from "./BootScene";
import { tokenAssetForPlayer, tokenAssetForMonster, tokenAssetForNpc } from "../data/tokens";
import { Player } from "../entities/Player";
import { NpcToken } from "../entities/NpcToken";
import { MapItem } from "../entities/MapItem";
import { PlayerPanel, QuestDisplay, PlayerPanelActionState } from "../ui/PlayerPanel";
import { TargetPanel } from "../ui/TargetPanel";
import { HUD, HUDState } from "../ui/HUD";
import { LevelUpOverlay } from "../ui/LevelUpOverlay";
import { LongRestOverlay } from "../ui/LongRestOverlay";
import { SpellOptionPicker } from "../ui/SpellOptionPicker";
import { SpellTargetSelector, type SpellTargetCandidate } from "../ui/SpellTargetSelector";
import { SpeechBubbles } from "../ui/SpeechBubbles";
import { SpeechInputBubble } from "../ui/SpeechInputBubble";
import { ScreenEffects } from "../ui/ScreenEffects";
import { playSound } from "../ui/SoundLibrary";
import { UIScale } from "../ui/UIScale";
import { GridView } from "../systems/GridView";
import { VisionMask } from "../systems/VisionMask";
import { OverlayManager } from "../systems/OverlayManager";
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, HUD_HEIGHT,
  PLAYER_PANEL_WIDTH, TARGET_PANEL_WIDTH,
} from "../constants";
import { PlayerDef } from "../data/player";
import { MonsterDef, NPCDef } from "../data/monsters";
import type { FactionDef } from "../../../shared/types";
import { ItemDef } from "../data/equipment";
import { gameClient } from "../net/GameClient";
import { WorldPause } from "../net/WorldPause";
import type { GameState, GameEvent, GameMap, SpellDef, FeatureDef } from "../net/types";
import type { ChatMessage } from "../ui/AIGMOverlay";
import { DevMode } from "../devMode";
import { decodeTileGid, TILE_VOID_GID } from "../../../shared/tileGid";

const GAME_W = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE + TARGET_PANEL_WIDTH;
const GAME_H = GRID_ROWS * TILE_SIZE + HUD_HEIGHT;
const API_URL = "http://localhost:3000";

export class GameScene extends Phaser.Scene {
  private playerDef!: PlayerDef;

  private gameState!: GameState;
  private eventQueue: GameEvent[] = [];
  private animating = false;
  private mapDrawn = false;
  /** While an `entity_move` event is animating, this holds the moving
   *  entity's id (`'player'` or `npc.id`). The HUD's turn-order chip data
   *  is overridden so that entity reads as active for the duration of the
   *  animation — the server resets `npc.isActive` atomically at the end of
   *  each NPC's turn, so without this the client only sees the final state
   *  with no NPC active. Cleared when the event queue drains. */
  private animatingEntityId: string | null = null;

  private player: Player | null = null;
  private npcTokens = new Map<string, NpcToken>();
  private itemTokens = new Map<string, MapItem>();
  /** Mirrors the HUD's LABELS chip — applied to fresh NpcTokens at spawn so
   *  enemies arriving mid-encounter respect the player's current preference.
   *  Defaults to false so the map opens with a clean view; the player opts
   *  in via the LABELS chip in the GM panel. */
  private labelsVisible = false;

  private selectedEntityId: string | null = null;

  private uiScale!: UIScale;
  private playerPanel!: PlayerPanel;
  private targetPanel!: TargetPanel;
  private hud!: HUD;
  private speechBubbles!: SpeechBubbles;
  private screenEffects!: ScreenEffects;
  private uiDestroyed = false;
  private gridView!: GridView;
  private overlays!: OverlayManager;
  private highlightLayer!: Phaser.GameObjects.Graphics;
  private movePathLayer!: Phaser.GameObjects.Graphics;
  /** Fog-of-war + sound-rings overlay (Vision/Sound system). */
  private visionMask!: VisionMask;
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
    | { kind: "creature"; spellId: string; spellName: string; asRitual: boolean; damageTypeChoice?: string }
    | {
        kind: "aoe"; spellId: string; spellName: string; asRitual: boolean;
        /** For cone: the cone's max reach in tiles. For sphere/cube: the side length of the area in tiles. */
        sideTiles: number;
        selfAnchored: boolean;
        shape: "cone" | "sphere" | "cube" | "line";
        damageTypeChoice?: string;
      }
    | {
        kind: "summon-direct"; summonNpcId: string; summonName: string;
        /** Movement allowance in tiles (Mage Hand 6, Unseen Servant 3). */
        moveRangeTiles: number;
        /** Summon's current tile — preview shows reachable tiles around this. */
        fromTileX: number; fromTileY: number;
      }
    | null = null;
  private pendingGmHistory: ChatMessage[] = [];
  private pendingIsResume = false;
  /** Set by `init()` from scene-restart payload when a chapter-advance fade is
   *  in flight. `create()` parks the screen at black then fades back in. */
  private pendingFadeInOnStart = false;
  private pendingFadeInDurationMs = 1200;
  /** True while a `focused` announcement is on screen — Player/Target/HUD
   *  panels are hidden, world tick is paused, and input is locked. */
  private focusedAnnouncementActive = false;
  /** Open inline TALK input bubble pinned to the player token. Null when no
   *  bubble is in flight. Replaced (not stacked) by subsequent TALK clicks. */
  private speechInputBubble: SpeechInputBubble | null = null;
  /** Active typing indicator (animated dots) pinned over an NPC token while
   *  the GM is generating a sayto reply. Calling the function clears it. */
  private gmTypingIndicatorClear: (() => void) | null = null;
  /** First `state_update` from the server hasn't arrived yet. While true the
   *  scene parks at full black so the UI panels never flash before any
   *  encounter-start cinematic events get to run. Cleared on the first
   *  `handleStateUpdate` call. */
  private awaitingFirstStateUpdate = true;

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

  init(data: { sessionId: string; playerDef: PlayerDef; gmHistory?: ChatMessage[]; isResume?: boolean; fadeInOnStart?: boolean; fadeInDurationMs?: number }): void {
    this.playerDef = data.playerDef;
    this.pendingIsResume = data.isResume ?? false;
    this.pendingGmHistory = data.isResume ? (data.gmHistory ?? []) : [];
    this.pendingFadeInOnStart = data.fadeInOnStart ?? false;
    this.pendingFadeInDurationMs = data.fadeInDurationMs ?? 1200;
    this.player = null;
    this.eventQueue = [];
    this.animating = false;
    this.mapDrawn = false;
    this.npcTokens = new Map();
    this.itemTokens = new Map();
    this.selectedEntityId = null;
    this.uiDestroyed = false;
    // Phaser reuses the same scene instance across encounters, so class-member
    // initializers only fire once per page load. These flags MUST be reset
    // here or the second-and-onward encounter inherits stale values — most
    // visibly `awaitingFirstStateUpdate`, which gates the boot fade-in and
    // would leave the screen stuck at the pre-blacked overlay.
    this.awaitingFirstStateUpdate = true;
    this.focusedAnnouncementActive = false;
    this.animatingEntityId = null;
    this.speechInputBubble = null;
    this.gmTypingIndicatorClear = null;
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
    // VisionMask: fog-of-war veil + sound-ring overlay.
    this.visionMask = new VisionMask(this);
    this.gridView.container.add(this.highlightLayer);
    this.gridView.container.add(this.movePathLayer);
    this.gridView.container.add(this.spellAuraLayer);
    this.gridView.container.add(this.spellAoeLayer);
    this.gridView.container.add(this.visionMask.fogLayer);
    this.gridView.container.add(this.visionMask.soundLayer);

    this.overlays = new OverlayManager(this.uiScale, this.playerDef, {
      onEquip:     (slot, itemId) => gameClient.sendAction({ type: "equip", slot, itemId }),
      onUnequip:   (slot) => gameClient.sendAction({ type: "unequip", slot }),
      onUsePotion: () => gameClient.sendAction({ type: "usePotion" }),
      onBeginSpellCast:  (spellId) => this.beginSpellCast(spellId, false),
      onBeginRitualCast: (spellId) => this.beginSpellCast(spellId, true),
      onAcceptReaction:  () => gameClient.sendAction({ type: "resolveReaction", accept: true }),
      onDeclineReaction: () => gameClient.sendAction({ type: "resolveReaction", accept: false }),
      onAdvanceChapter:  () => this.advanceChapter(),
      getItems:    () => this.registry.get("equipment") as ItemDef[],
      getSpells:   () => (this.registry.get("spells") ?? []) as SpellDef[],
    });
    if (this.pendingIsResume) this.overlays.markResumed();

    this.speechBubbles = new SpeechBubbles();
    this.speechBubbles.setEntityResolver((entityId) => this.resolveEntityScreenPos(entityId));
    this.screenEffects = new ScreenEffects();
    // Park the screen at full black until the first `state_update` arrives.
    // Without this, the bare HUD/Player Panel/Target Panel flash for a few
    // hundred ms before any encounter-start cinematic events get to run.
    this.screenEffects.fadeOut(0);
    if (this.pendingFadeInOnStart) {
      // Coming back from a chapter-advance restart: pre-blacked above, fade
      // back in once the scene has laid out (handled by queueScreenFadeOnReady).
      this.queueScreenFadeOnReady();
    }

    this.setupInput();
    this.buildHUD();
    if (this.pendingIsResume) this.hud.seedGmHistory(this.pendingGmHistory);

    gameClient.setStateUpdateHandler((state, events) => this.handleStateUpdate(state, events));
    gameClient.connectWebSocket();

    // Bind the world-pause manager to the active session so the off-camera
    // tick respects input focus + open overlays. Cleared on scene teardown.
    WorldPause.setSession(gameClient.getSessionId());
    this.events.once('shutdown', () => WorldPause.setSession(null));
    this.events.once('destroy',  () => WorldPause.setSession(null));
  }

  shutdown(): void {
    gameClient.disconnect();
    if (this.speechInputBubble) { this.speechInputBubble.destroy(); this.speechInputBubble = null; }
    if (this.gmTypingIndicatorClear) { this.gmTypingIndicatorClear(); this.gmTypingIndicatorClear = null; }
    if (!this.uiDestroyed) {
      this.uiDestroyed = true;
      this.hud.destroy();
      this.playerPanel.destroy();
      this.targetPanel.destroy();
      this.speechBubbles.destroy();
      this.screenEffects.destroy();
      this.uiScale.destroy();
    }
  }

  /** Queue the chapter-advance fade-in to play once the scene has finished
   *  laying out — without the delay the fade kicks off before the new map is
   *  drawn and the first frame leaks through. */
  private queueScreenFadeOnReady(): void {
    this.events.once('postupdate', () => {
      this.screenEffects.fadeIn(this.pendingFadeInDurationMs);
    });
  }

  // ── State update pipeline ─────────────────────────────────────────────────

  private handleStateUpdate(state: GameState, events: GameEvent[]): void {
    this.gameState = state;
    const isFirst = this.awaitingFirstStateUpdate;
    this.awaitingFirstStateUpdate = false;
    for (const ev of events) {
      if (ev.type === "entity_move") this.eventQueue.push(ev);
      else if (ev.type === "npc_speech") this.speechBubbles.spawn(ev.entityId, ev.text);
      else if (ev.type === "sound_ring") this.visionMask?.pushSoundRing(ev.x, ev.y, ev.intensity);
      else if (ev.type === "play_sound") playSound(ev.sound);
      else if (ev.type === "screen_fade" || ev.type === "supertitle" || ev.type === "announcement") {
        this.eventQueue.push(ev);
      }
    }
    // First state_update arrived. We parked at full black in `create()` so
    // panels wouldn't flash before any encounter-start cinematic runs. If the
    // startup events include a fade, it'll drive the screen out of black on
    // its own. Otherwise we need to release the black ourselves — queue a
    // short fade-in at the head of the event queue so it plays before any
    // entity moves the same payload carries.
    if (isFirst) {
      const hasFade = events.some((e) => e.type === "screen_fade") || this.pendingFadeInOnStart;
      if (!hasFade) {
        this.eventQueue.unshift({ type: "screen_fade", mode: "in", durationMs: 400 });
      }
    }
    if (!this.animating) this.processNextEvent();
  }

  private processNextEvent(): void {
    if (this.eventQueue.length === 0) {
      this.animatingEntityId = null;
      this.applyState(this.gameState);
      return;
    }
    const event = this.eventQueue.shift()!;
    this.animating = true;
    if (event.type === "entity_move") {
      // Highlight the moving entity's chip while their animation plays —
      // refresh the HUD immediately so the bar updates the moment the
      // event starts (no need to wait for the tween to finish).
      this.animatingEntityId = event.entityId;
      if (this.gameState) this.updateHUD(this.gameState);
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
    } else if (event.type === "screen_fade") {
      this.screenEffects.applyFadeMode(event.mode, event.durationMs)
        .then(() => { this.animating = false; this.processNextEvent(); });
      return;
    } else if (event.type === "supertitle") {
      this.screenEffects.showSupertitle(event.text, event.durationMs)
        .then(() => { this.animating = false; this.processNextEvent(); });
      return;
    } else if (event.type === "announcement") {
      const mode = event.mode ?? 'focused';
      if (mode === 'focused') {
        // UI fades out FIRST (general principle: when player control is taken
        // away, panels are the first to leave); only once the UI is gone do
        // we render the announcement card. On the way back: hide the card,
        // then fade the UI back in.
        void this.runFocusedAnnouncement(event.text, event.durationMs)
          .then(() => { this.animating = false; this.processNextEvent(); });
        return;
      }
      // Unfocused: fire-and-forget so the player keeps moving and the event
      // queue continues processing while the card floats in the world.
      void this.screenEffects.showAnnouncement(event.text, event.durationMs, mode);
      // Fall through to default (animating = false, processNextEvent).
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
      this.player = new Player(
        this,
        state.player.tileX, state.player.tileY,
        tokenTextureKey(tokenAssetForPlayer(this.playerDef)),
        this.playerDef.color,
      );
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
    this.overlays.syncChapterComplete(state);

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
        token = new NpcToken(
          this, nState.id, def, nState.tileX, nState.tileY,
          nState.disposition, nState.hp, nState.maxHp,
          tokenTextureKey(tokenAssetForMonster(def)),
        );
        token.setNameText(nState.name);
        token.setNameVisible(this.labelsVisible);
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
        if (nState) this.targetPanel.refresh(nState, nState.maxHp, this.getFactions(), state.discoveredFactions ?? []);
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
      this.targetPanel.show(def, nState, this.getFactions(), state.discoveredFactions ?? [], nState.conditions);
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
    if (this.focusedAnnouncementActive) return;
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
      if (this.spellTargetMode.kind === "summon-direct") {
        this.finishSummonDirectClick(tileX, tileY);
        return;
      }
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
      this.targetPanel.show(def, nState, this.getFactions(), this.gameState.discoveredFactions ?? [], nState.conditions);
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
    this.speechBubbles?.refresh();
    if (this.gameState) this.visionMask?.refresh(this.gameState, this.playerDef);
    this.visionMask?.refreshSoundRings();
    if (this.overlays.isAnyOpen) return;
    if (this.focusedAnnouncementActive) return;
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
      onDetach:         () => gameClient.sendAction({ type: "detach" }),
      onUseFeature:     (featureId) => gameClient.sendAction({ type: "useFeature", featureId }),
      onHide:           () => gameClient.sendAction({ type: "hide" }),
      onDeathSave:      () => gameClient.sendAction({ type: "rollDeathSave" }),
      onShortRest:      () => gameClient.sendAction({ type: "shortRest" }),
      onToggleMoveMode: () => this.toggleMoveMode(),
      onEndTurn:        () => gameClient.sendAction({ type: "endTurn" }),
      onLevelUp:        () => void this.openLevelUpOverlay(),
      onLongRest:       () => void this.openLongRestOverlay(),
      onCommandSummon:  (summonNpcId) => this.beginSummonDirect(summonNpcId),
      onTalk:           () => this.openSpeechInput(),
      onLeaveEncounter: () => {
        this.uiDestroyed = true;
        this.playerPanel.destroy();
        this.targetPanel.destroy();
        this.hud.destroy();
        this.speechBubbles.destroy();
        this.screenEffects.destroy();
        this.uiScale.destroy();
        gameClient.disconnect().then(() => this.scene.start("EncounterSetupScene"));
      },
    });
    this.targetPanel = new TargetPanel(this.uiScale);
    this.hud = new HUD(this.uiScale, {
      // When the GM is disabled (DevMode.disableAIGM), short-circuit with a
      // canned silent reply instead of hitting the server. The encounter still
      // plays end-to-end on the deterministic layer alone (US-068 criterion).
      onSendAIGM: (msg, persona) => {
        if (DevMode.disableAIGM) {
          this.hud.aigmStart();
          this.hud.aigmDone('(The Game Master is silent. The world responds only to your actions.)', []);
          return Promise.resolve({ reply: '', rollResults: [] });
        }
        return gameClient.sendAIGMMessage(msg, persona);
      },
      onDisableKeyboard: () => this.input.keyboard?.disableGlobalCapture(),
      onEnableKeyboard:  () => this.input.keyboard?.enableGlobalCapture(),
      // Fan the LABELS chip out to every live NpcToken. Captured into a
      // field so freshly-spawned tokens (mid-encounter spawns via the GM,
      // ally additions, etc.) honour the current state — see `reconcileNpcs`.
      onLabelsToggle: (visible) => {
        this.labelsVisible = visible;
        for (const token of this.npcTokens.values()) token.setNameVisible(visible);
      },
      // Player said something to the selected target — spawn the line as a
      // speech bubble above the player token, instructing the bubble manager
      // to flip below the player if the bubble would overlap the target.
      // Also drop an animated typing indicator above the target so the
      // player sees the NPC "thinking" while the GM generates a reply.
      onPlayerSays: (text) => {
        const targetId = this.selectedEntityId ?? undefined;
        this.speechBubbles.spawn('player', text, { avoidEntityId: targetId });
        if (this.gmTypingIndicatorClear) {
          this.gmTypingIndicatorClear();
          this.gmTypingIndicatorClear = null;
        }
        if (targetId) {
          this.gmTypingIndicatorClear = this.speechBubbles.spawnTypingIndicator(targetId);
        }
      },
    });
    // E. Hook the AIGM streaming protocol into the HUD's chat panel. The
    // `onDone` hook also clears any active sayto typing indicator that was
    // spawned by `onPlayerSays` so the dots vanish when the GM's reply lands.
    gameClient.setAIGMStreamHandlers({
      onStart:              () => this.hud.aigmStart(),
      onChunk:              (text) => this.hud.aigmChunk(text),
      onCheckpoint:         () => this.hud.aigmCheckpoint(),
      onSpeculativeDiscard: () => this.hud.aigmSpeculativeDiscard(),
      onDone:               (reply, rollResults) => {
        this.hud.aigmDone(reply, rollResults);
        if (this.gmTypingIndicatorClear) {
          this.gmTypingIndicatorClear();
          this.gmTypingIndicatorClear = null;
        }
      },
    });
  }

  private buildHUDState(state: GameState): HUDState {
    const selectedNpcName = state.selectedTargetId
      ? (() => { const n = state.npcs.find(n => n.id === state.selectedTargetId); return n ? (n.revealedName ?? n.name) : null; })()
      : null;

    // Build initiative-ordered turn-order chips directly from turnOrderIds.
    // Falls back to a simple player-first list when combat hasn't begun.
    // `animatingEntityId` overrides `isActive` while an entity_move is
    // playing — without it, NPC chips never highlight because the server's
    // atomic turn processing flips `isActive` back to false before any
    // event reaches the client.
    const animating = this.animatingEntityId;
    const turnOrderChips = state.turnOrderIds.length > 0
      ? state.turnOrderIds.flatMap((id) => {
          if (id === 'player') {
            return [{
              label: '',
              name: this.playerDef.name,
              color: this.playerDef.color,
              tokenUrl: `${API_URL}${tokenAssetForPlayer(this.playerDef)}`,
              isActive: animating === 'player'
                || state.phase === 'player_turn'
                || state.phase === 'death_saves',
              isDead: state.player.hp <= 0,
            }];
          }
          const npc = state.npcs.find(n => n.id === id);
          if (!npc) return [];
          const def = this.resolveMonsterDef(npc.defId);
          // `resolveMonsterDef` already applied the NPC→monster token
          // fallback (npc.tokenAsset → monster.tokenAsset). Pull the resolved
          // path off the synthesised def and prefix the API origin.
          const tokenPath = def.tokenAsset ?? tokenAssetForMonster(def);
          return [{
            label: npc.combatLabel,
            name: npc.revealedName ?? def.name,
            color: def.color,
            tokenUrl: `${API_URL}${tokenPath}`,
            isActive: animating === npc.id || !!npc.isActive,
            isDead: npc.hp <= 0,
          }];
        })
      : [];

    return {
      mode:      state.phase,
      playerDef: this.playerDef,
      playerHp:  state.player.hp,
      turnOrderChips,
      eventLog: state.eventLog,
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
        ? (this.spellTargetMode.kind === "summon-direct"
            ? { spellName: `Direct ${this.spellTargetMode.summonName}`, asRitual: false }
            : { spellName: this.spellTargetMode.spellName, asRitual: this.spellTargetMode.asRitual })
        : null,
      summons: state.npcs
        .filter((n) => n.summonSpellId && n.summonOwnerId === 'player' && n.hp > 0)
        .map((n) => ({
          id: n.id,
          name: n.name,
          spellName: (allSpells.find((sp) => sp.id === n.summonSpellId)?.name) ?? n.name,
        })),
      hasSelectedTarget: !!state.selectedTargetId,
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

    // Spells that ask the caster to choose at cast time (Chromatic Orb's
    // damage type, future Dragon's Breath types, …) get a small picker
    // BEFORE we enter target mode. CANCEL aborts the cast — no resource
    // consumed.
    if (spell.damageTypeChoices && spell.damageTypeChoices.length > 0) {
      new SpellOptionPicker(
        this.uiScale,
        `${spell.name} — damage type`,
        "Choose the damage type for this cast.",
        spell.damageTypeChoices,
        (chosen) => this.continueSpellCast(spell, asRitual, chosen),
        () => { /* cancelled — no further action */ },
      );
      return;
    }

    this.continueSpellCast(spell, asRitual, undefined);
  }

  /** Pulled out of `beginSpellCast` so the damage-type picker can resume the
   *  cast with the player's choice. */
  private continueSpellCast(spell: SpellDef, asRitual: boolean, damageTypeChoice: string | undefined): void {
    const spellId = spell.id;
    const slotLevel = spell.level === 0 ? 0 : spell.level;

    // Single-target save spells (Hideous Laughter, Charm Person) — no `area`,
    // no `attack` field, but `save` is set — also need the target-selector
    // to fire so the cast resolves against a specific creature.
    const needsCreatureTarget =
      spell.attack === 'ranged-spell' || spell.attack === 'melee-spell' || spell.attack === 'auto-hit'
      || (!!spell.save && !spell.area);
    const isAoe = !!spell.area;

    if (needsCreatureTarget) {
      this.spellTargetMode = { kind: "creature", spellId, spellName: spell.name, asRitual, damageTypeChoice };
    } else if (isAoe) {
      // Mirror server: sphere → diameter / 5; cube → side / 5; cone → reach / 5.
      const sizeFeet = spell.area?.sizeFeet ?? 5;
      const shape = (spell.area?.shape ?? "sphere") as "cone" | "sphere" | "cube" | "line";
      const sideTiles = shape === 'sphere'
        ? Math.max(1, Math.ceil(2 * sizeFeet / 5))
        : Math.max(1, Math.ceil(sizeFeet / 5));
      const selfAnchored = spell.range === 'self' || spell.rangeFeet === 0;
      this.spellTargetMode = { kind: "aoe", spellId, spellName: spell.name, asRitual, sideTiles, selfAnchored, shape, damageTypeChoice };
    } else {
      // Self / utility: fire immediately.
      gameClient.sendAction({ type: "castSpell", spellId, slotLevel, asRitual, damageTypeChoice });
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
    if (!stm || stm.kind === "summon-direct") return;
    const allSpells = (this.registry.get('spells') ?? []) as SpellDef[];
    const spell = allSpells.find(sp => sp.id === stm.spellId);
    if (!spell) { this.exitSpellTargetMode(); return; }
    const slotLevel = spell.level === 0 ? 0 : spell.level;

    if (stm.kind === "creature") {
      if (!targetNpcId) { this.exitSpellTargetMode(); return; }
      gameClient.sendAction({ type: "castSpell", spellId: stm.spellId, slotLevel, targetIds: [targetNpcId], asRitual: stm.asRitual, damageTypeChoice: stm.damageTypeChoice });
      this.exitSpellTargetMode();
      return;
    }

    // AOE: the `tile` payload is the cursor click. For cones it tells the
    // server the direction; for spheres/cubes it's the centre. Self-anchored
    // sphere spells ignore the tile server-side but we still pass cursor —
    // server resolves correctly either way.
    const tile = { x: tileX, y: tileY };

    // SRD "creature of your choice" spells (Sleep) get a second-step picker
    // listing the creatures actually inside the area, defaulting to every
    // non-ally. Confirm fires the cast with the chosen ids; cancel aborts.
    if (spell.area?.creaturesOfYourChoice) {
      const candidates = this.creaturesInPlacedArea(spell, tile);
      this.exitSpellTargetMode();
      new SpellTargetSelector(
        this.uiScale,
        spell.name,
        candidates,
        (selectedIds) => {
          gameClient.sendAction({
            type: "castSpell",
            spellId: stm.spellId,
            slotLevel,
            tile,
            targetIds: selectedIds,
            asRitual: stm.asRitual,
            damageTypeChoice: stm.damageTypeChoice,
          });
        },
        () => { /* cancelled — no slot consumed */ },
      );
      return;
    }

    gameClient.sendAction({ type: "castSpell", spellId: stm.spellId, slotLevel, tile, asRitual: stm.asRitual, damageTypeChoice: stm.damageTypeChoice });
    this.exitSpellTargetMode();
  }

  /**
   * Mirror server `rectAreaCells` to enumerate the creatures the AOE actually
   * covers, so the SpellTargetSelector can list them. Non-ally creatures are
   * tagged for the picker's default-checked state.
   */
  private creaturesInPlacedArea(spell: SpellDef, tile: { x: number; y: number }): SpellTargetCandidate[] {
    if (!this.gameState) return [];
    const sizeFeet = spell.area?.sizeFeet ?? 5;
    const sideTiles = spell.area?.shape === 'sphere'
      ? Math.max(1, Math.ceil(2 * sizeFeet / 5))
      : Math.max(1, Math.ceil(sizeFeet / 5));
    let xMin: number, xMax: number, yMin: number, yMax: number;
    if (sideTiles % 2 === 1) {
      const r = (sideTiles - 1) / 2;
      xMin = tile.x - r; xMax = tile.x + r; yMin = tile.y - r; yMax = tile.y + r;
    } else {
      const offset = sideTiles - 1;
      xMin = tile.x; xMax = tile.x + offset; yMin = tile.y; yMax = tile.y + offset;
    }
    const out: SpellTargetCandidate[] = [];
    for (const npc of this.gameState.npcs) {
      if (npc.hp <= 0) continue;
      if (npc.tileX < xMin || npc.tileX > xMax || npc.tileY < yMin || npc.tileY > yMax) continue;
      const label = npc.combatLabel
        ? `${npc.revealedName ?? npc.name} (${npc.combatLabel})`
        : (npc.revealedName ?? npc.name);
      out.push({ id: npc.id, label, isAlly: npc.disposition === 'ally' });
    }
    return out;
  }

  /**
   * Enter the "click to move the summon" mode. The summon's spell carries
   * the movement allowance (Mage Hand 30 ft = 6 tiles, Unseen Servant 15 ft
   * = 3 tiles); the AOE preview layer highlights every reachable tile.
   */
  private beginSummonDirect(summonNpcId: string): void {
    if (!this.gameState) return;
    const summon = this.gameState.npcs.find((n) => n.id === summonNpcId);
    if (!summon || !summon.summonSpellId) return;
    const allSpells = (this.registry.get('spells') ?? []) as SpellDef[];
    const spell = allSpells.find((sp) => sp.id === summon.summonSpellId);
    const rangeFeet = spell?.summon?.moveRangeFeet ?? 30;
    const moveRangeTiles = Math.max(1, Math.ceil(rangeFeet / 5));
    this.spellTargetMode = {
      kind: "summon-direct",
      summonNpcId,
      summonName: summon.name,
      moveRangeTiles,
      fromTileX: summon.tileX,
      fromTileY: summon.tileY,
    };
    this.playerPanel.refreshActions(this.buildActionState(this.gameState));
  }

  /** Resolve a click while in summon-direct mode. Out-of-range clicks cancel; in-range clicks fire `commandSummon`. */
  private finishSummonDirectClick(tileX: number, tileY: number): void {
    const stm = this.spellTargetMode;
    if (!stm || stm.kind !== "summon-direct") return;
    const dx = Math.abs(tileX - stm.fromTileX);
    const dy = Math.abs(tileY - stm.fromTileY);
    if (Math.max(dx, dy) > stm.moveRangeTiles) {
      this.exitSpellTargetMode();
      return;
    }
    gameClient.sendAction({ type: "commandSummon", summonNpcId: stm.summonNpcId, tile: { x: tileX, y: tileY } });
    this.exitSpellTargetMode();
  }

  private levelUpOverlay: LevelUpOverlay | null = null;
  private longRestOverlay: LongRestOverlay | null = null;

  /**
   * Open the Long Rest overlay. Pauses the world tick while open (rest
   * obviously can't proceed while NPCs are still acting) and refreshes the
   * cached `playerDef` afterwards so the PlayerPanel + HUD pick up restored
   * HP / spell slots / prepared spells immediately.
   */
  private async openLongRestOverlay(): Promise<void> {
    if (this.longRestOverlay) return;
    try {
      const preview = await gameClient.fetchLongRestPreview();
      if (!preview) return;
      WorldPause.acquire("overlay:long-rest");
      this.longRestOverlay = new LongRestOverlay(this.uiScale, preview, {
        onConfirm: async (choices) => {
          // Cinematic transition: fade to black, run the rest under cover,
          // then fade back in. The fade durations are intentionally short so
          // the rest doesn't feel like a long pause.
          const LONG_REST_FADE_MS = 1200;
          await this.screenEffects.fadeOut(LONG_REST_FADE_MS);
          try {
            const { state, playerDef } = await gameClient.commitLongRest(choices);
            this.playerDef = playerDef;
            this.playerPanel.setPlayerDef(playerDef);
            this.overlays.setPlayerDef(playerDef);
            this.handleStateUpdate(state, []);
          } finally {
            this.longRestOverlay = null;
            WorldPause.release("overlay:long-rest");
            await this.screenEffects.fadeIn(LONG_REST_FADE_MS);
          }
        },
        onCancel: () => {
          this.longRestOverlay = null;
          WorldPause.release("overlay:long-rest");
        },
      });
    } catch (err) {
      console.error("long-rest preview failed", err);
    }
  }

  /**
   * Open the SRD level-up overlay. Pauses the world tick (the overlay is a
   * blocking modal) and fetches the preview from the server. On confirm,
   * applies the commit, updates the cached `playerDef` so the HUD picks up
   * the new HP / level / spell slot maxima, and resumes the world.
   */
  private async openLevelUpOverlay(): Promise<void> {
    if (this.levelUpOverlay) return;
    try {
      const preview = await gameClient.fetchLevelUpPreview();
      if (!preview) return;  // XP threshold not met server-side — likely a race.
      WorldPause.acquire("overlay:level-up");
      this.levelUpOverlay = new LevelUpOverlay(this.uiScale, preview, {
        onConfirm: async (choices) => {
          const { state, playerDef } = await gameClient.commitLevelUp(choices);
          this.playerDef = playerDef;
          this.playerPanel.setPlayerDef(playerDef);
          this.overlays.setPlayerDef(playerDef);
          this.handleStateUpdate(state, []);
          this.levelUpOverlay = null;
          WorldPause.release("overlay:level-up");
        },
        onCancel: () => {
          this.levelUpOverlay = null;
          WorldPause.release("overlay:level-up");
        },
      });
    } catch (err) {
      console.error("level-up preview failed", err);
    }
  }

  /**
   * Adventure chapter advance flow. Asks the server to mark the current
   * chapter complete and start the next one. On success, the scene restarts
   * with the new session id. On adventure completion, returns to MainMenu.
   *
   * IMPORTANT — close the WS BEFORE the advance request fires. The server
   * deletes the just-finished session as part of advancing (which closes
   * the WS from its end), and if `intentionalClose` is still false when
   * that cascade reaches us, `ConnectionMonitor` treats it as a server-died
   * disconnect and reloads the page — bouncing the player back to the main
   * menu.
   */
  private async advanceChapter(): Promise<void> {
    const CHAPTER_FADE_MS = 1200;
    // Fade to black BEFORE the WS closes so the player sees a clean cinematic
    // transition rather than the old map flashing to a fresh one. The fade is
    // purely client-side — the server's chapter-advance work runs in parallel.
    await this.screenEffects.fadeOut(CHAPTER_FADE_MS);
    gameClient.closeWebSocket();
    try {
      const result = await gameClient.advanceChapter(this.playerDef.id);
      this.uiScale.destroy();
      if (result.complete) {
        this.scene.start("MainMenuScene");
        return;
      }
      // Restart this scene with the new session id; init() resets all
      // per-session fields (mapDrawn, npcTokens, overlays, …). Use the
      // server-returned PlayerDef so cross-chapter level-up history is
      // preserved. `fadeInOnStart` parks the new scene at black and fades
      // it in once the map + tokens are laid out.
      this.scene.restart({
        sessionId: result.sessionId,
        playerDef: result.playerDef,
        isResume: false,
        fadeInOnStart: true,
        fadeInDurationMs: CHAPTER_FADE_MS,
      });
    } catch (err) {
      console.error("advanceChapter failed", err);
      // Restore the screen — without this a failed advance leaves the player
      // staring at a black screen with no way to recover.
      await this.screenEffects.fadeIn(CHAPTER_FADE_MS);
    }
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
      state.objective,
    );

    if (this.selectedEntityId) {
      const nState = state.npcs.find(n => n.id === this.selectedEntityId);
      if (nState && nState.hp > 0) this.targetPanel.refresh(nState, nState.maxHp, this.getFactions(), state.discoveredFactions ?? []);
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
            const rawGid = grid[row][col];
            if (!rawGid) continue;
            // Strip the top-3 flip/rotation bits BEFORE matching against
            // tileset firstgids — orientation has nothing to do with which
            // tileset owns the tile.
            const decoded = decodeTileGid(rawGid);
            // Sentinel "void" GID — render a solid black rectangle instead
            // of sampling a tileset frame. Used for chasms / abysses on
            // tilesets that have no flat-black tile.
            if (decoded.gid === TILE_VOID_GID) {
              const r = this.add.rectangle(
                col * TILE_SIZE + TILE_SIZE / 2,
                row * TILE_SIZE + TILE_SIZE / 2,
                TILE_SIZE,
                TILE_SIZE,
                0x000000,
              );
              container.add(r);
              continue;
            }
            const ts = tilesets.find((t) => decoded.gid >= t.firstgid);
            if (!ts) continue;
            const frame = decoded.gid - ts.firstgid;
            const sprite = this.add.image(
              col * TILE_SIZE + TILE_SIZE / 2,
              row * TILE_SIZE + TILE_SIZE / 2,
              tilesetTextureKey(ts.imageUrl),
              frame,
            );
            sprite.setDisplaySize(TILE_SIZE, TILE_SIZE);
            if (decoded.angle !== 0) sprite.setAngle(decoded.angle);
            if (decoded.flipX) sprite.setFlipX(true);
            if (decoded.flipY) sprite.setFlipY(true);
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
    if (!stm || !this.gameState || !this.player) return;

    const { tileX, tileY } = this.gridView.toTile(pointer);
    const { cols, rows } = this.gameState.map;

    const paintRect = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      this.spellAoeLayer.fillRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    };

    // Summon-direct mode: paint the chebyshev reach disc around the summon's
    // current tile in a softer blue tint. Out-of-range cursor clicks cancel,
    // matching the existing spell-target mode UX.
    if (stm.kind === "summon-direct") {
      this.spellAoeLayer.fillStyle(0x66aaff, 0.24);
      const r = stm.moveRangeTiles;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          paintRect(stm.fromTileX + dx, stm.fromTileY + dy);
        }
      }
      return;
    }

    // Range underlay: every tile within the spell's range from the caster,
    // painted before the AOE shape so AOE colour wins on overlap. Cool teal
    // tint (distinct from move highlight + AOE orange + summon blue).
    const allSpells = (this.registry.get('spells') ?? []) as SpellDef[];
    const spell = allSpells.find((sp) => sp.id === stm.spellId);
    if (spell && spell.rangeFeet > 0) {
      const rangeTiles = Math.max(1, Math.ceil(spell.rangeFeet / 5));
      this.spellAoeLayer.fillStyle(0x44aacc, 0.14);
      for (let dy = -rangeTiles; dy <= rangeTiles; dy++) {
        for (let dx = -rangeTiles; dx <= rangeTiles; dx++) {
          if (dx === 0 && dy === 0) continue;  // caster's own tile
          paintRect(this.player.tileX + dx, this.player.tileY + dy);
        }
      }
    }

    if (stm.kind !== "aoe") return;
    const side = stm.sideTiles;
    this.spellAoeLayer.fillStyle(0xff8844, 0.28);

    const paintTile = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      this.spellAoeLayer.fillRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    };

    if (stm.shape === "cone") {
      // Cone semantic: `sideTiles` is the cone's reach in tiles.
      const r = side;
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
      const cx = stm.selfAnchored ? this.player.tileX : tileX;
      const cy = stm.selfAnchored ? this.player.tileY : tileY;
      // Mirror server `rectAreaCells`: odd side → centred chebyshev disc,
      // even side → click is the top-left, area extends right + down. Fixed
      // orientation avoids the 2-tile jump that "extend away from caster"
      // produced when crossing the caster's axis.
      let xMin: number, xMax: number, yMin: number, yMax: number;
      if (side % 2 === 1) {
        const r = (side - 1) / 2;
        xMin = cx - r; xMax = cx + r; yMin = cy - r; yMax = cy + r;
      } else {
        const offset = side - 1;
        xMin = cx; xMax = cx + offset; yMin = cy; yMax = cy + offset;
      }
      for (let y = yMin; y <= yMax; y++) {
        for (let x = xMin; x <= xMax; x++) paintTile(x, y);
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

  private getFactions(): FactionDef[] {
    return (this.registry.get("factions") as FactionDef[] | undefined) ?? [];
  }

  private resolveMonsterDef(defId: string): MonsterDef {
    const monsters = this.registry.get("monsters") as MonsterDef[];
    const monster = monsters.find(m => m.id === defId);
    if (monster) return monster;
    const npcs = this.registry.get("npcs") as NPCDef[];
    const npcDef = npcs.find(n => n.id === defId);
    if (npcDef) {
      // NPCs inherit stats from their monsterClass but can override id, name,
      // colour, and (optionally) the token SVG. Token resolution: explicit
      // `npc.tokenAsset` if set, else fall back to the monsterClass's token.
      const base = monsters.find(m => m.id === npcDef.monsterClass) ?? monsters[0];
      const npcPath = tokenAssetForNpc(npcDef);
      return {
        ...base,
        id: npcDef.id,
        name: npcDef.name,
        color: npcDef.color,
        tokenAsset: npcPath ?? tokenAssetForMonster(base),
      };
    }
    return monsters[0];
  }

  private findItemDef(defId: string): ItemDef {
    const items = this.registry.get("equipment") as ItemDef[];
    return items.find(i => i.id === defId) ?? items[0];
  }

  /**
   * Open the inline TALK input bubble pinned to the player token. Closes any
   * existing input first (don't stack). Disabled keyboard while focused so
   * WASD doesn't bleed into the input; re-enabled on close. On submit the
   * line routes through `HUD.sendSayto` — same path as the GM-chat
   * `sayto`-mode send, so the spoken text gets wrapped, shipped to the
   * AIGM, and visualised as a player speech bubble.
   */
  private openSpeechInput(): void {
    if (!this.gameState || !this.selectedEntityId) return;
    if (this.speechInputBubble) {
      this.speechInputBubble.destroy();
      this.speechInputBubble = null;
    }
    const target = this.gameState.npcs.find((n) => n.id === this.selectedEntityId);
    const targetName = target ? (target.revealedName ?? target.name) : null;
    this.input.keyboard?.disableGlobalCapture();
    this.speechInputBubble = new SpeechInputBubble({
      targetName,
      getPlayerPos: () => this.resolveEntityScreenPos('player'),
      onSubmit: (text) => {
        this.speechInputBubble = null;
        this.input.keyboard?.enableGlobalCapture();
        void this.hud.sendSayto(text);
      },
      onCancel: () => {
        this.speechInputBubble = null;
        this.input.keyboard?.enableGlobalCapture();
      },
    });
  }

  /**
   * Run a focused announcement end-to-end. Sequence:
   *   1. lock input + pause world (player control is gone)
   *   2. fade Player Panel + Target Panel + HUD out (UI leaves first)
   *   3. show announcement card and wait for it to finish
   *   4. fade UI panels back in (UI returns last)
   *   5. unlock + unpause
   * This is the general principle for any player-control-loss visual.
   */
  private async runFocusedAnnouncement(text: string, durationMs?: number): Promise<void> {
    if (this.focusedAnnouncementActive) {
      // Defensive — should never re-enter while a focused announcement is
      // already running, but if it does, fall back to a non-fading flow.
      await this.screenEffects.showAnnouncement(text, durationMs, 'focused');
      return;
    }
    this.focusedAnnouncementActive = true;
    WorldPause.acquire('announcement:focused');

    // Capture which panels were visible before we hide them so the post-roll
    // fade-in only restores what the player actually had on screen.
    const hadTargetSelected = !!this.selectedEntityId;

    const UI_FADE_MS = 220;
    await Promise.all([
      this.playerPanel.fadeOut(UI_FADE_MS),
      hadTargetSelected ? this.targetPanel.fadeOut(UI_FADE_MS) : Promise.resolve(),
      this.hud.fadeOut(UI_FADE_MS),
    ]);

    await this.screenEffects.showAnnouncement(text, durationMs, 'focused');

    // Re-render the Target Panel before fading it back in — selection state
    // survived behind the curtain, but the DOM was display:none'd.
    if (hadTargetSelected && this.gameState && this.selectedEntityId) {
      const nState = this.gameState.npcs.find((n) => n.id === this.selectedEntityId);
      if (nState) {
        const def = this.resolveMonsterDef(nState.defId);
        this.targetPanel.show(def, nState, this.getFactions(), this.gameState.discoveredFactions ?? [], nState.conditions);
      }
    }
    await Promise.all([
      this.playerPanel.fadeIn(UI_FADE_MS),
      hadTargetSelected ? this.targetPanel.fadeIn(UI_FADE_MS) : Promise.resolve(),
      this.hud.fadeIn(UI_FADE_MS),
    ]);
    if (this.gameState) this.updateHUD(this.gameState);

    this.focusedAnnouncementActive = false;
    WorldPause.release('announcement:focused');
  }

  /**
   * Resolve a speech-bubble entity ref ('player' or NPC id) to a page-pixel
   * position above the token. Returns null when the token isn't on-screen
   * yet (entity not found in scene). Used by SpeechBubbles every frame.
   */
  private resolveEntityScreenPos(entityId: string): { x: number; y: number } | null {
    if (!this.uiScale) return null;
    let worldX: number, worldY: number;
    if (entityId === 'player') {
      if (!this.player) return null;
      worldX = this.player.gameObject.x;
      worldY = this.player.gameObject.y;
    } else {
      const token = this.npcTokens.get(entityId);
      if (!token) return null;
      worldX = token.gameObject.x;
      worldY = token.gameObject.y;
    }
    const gv = this.gridView.container;
    const canvasX = gv.x + worldX * gv.scaleX;
    const canvasY = gv.y + worldY * gv.scaleY;
    const rect = this.uiScale.canvasRect;
    const factor = this.uiScale.factor;
    return {
      x: rect.left + canvasX * factor,
      y: rect.top + canvasY * factor,
    };
  }
}
