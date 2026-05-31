import Phaser from "phaser";
import { tilesetTextureKey, tokenTextureKey } from "./BootScene";
import { tokenAssetForPlayer, tokenAssetForMonster, tokenAssetForNpc } from "../data/tokens";
import { Player } from "../entities/Player";
import { NpcToken } from "../entities/NpcToken";
import { MapItem } from "../entities/MapItem";
import { PlayerPanel, PlayerPanelActionState } from "../ui/PlayerPanel";
import { buildPlayerStatusChips } from "../ui/PlayerStatus";
import { TargetPanel } from "../ui/TargetPanel";
import { HUD, HUDState } from "../ui/HUD";
import { LevelUpOverlay } from "../ui/LevelUpOverlay";
import { LongRestOverlay } from "../ui/LongRestOverlay";
import { RestPromptOverlay } from "../ui/RestPromptOverlay";
import { SpellOptionPicker } from "../ui/SpellOptionPicker";
import { SpellTargetSelector, type SpellTargetCandidate } from "../ui/SpellTargetSelector";
import { SpeechBubbles } from "../ui/SpeechBubbles";
import { SpeechInputBubble } from "../ui/SpeechInputBubble";
import { ScreenEffects } from "../ui/ScreenEffects";
import { Cinematic } from "../ui/Cinematic";
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
import type { GameState, GameEvent, GameMap, SpellDef, FeatureDef, ClassDef, SubclassDef } from "../net/types";
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
  /** Display cap on `state.eventLog` while the animation queue is draining.
   *  When the server pushes a state with new log lines, those lines are
   *  semantically tied to the events still animating (enemy walk, then
   *  attack). Letting them render immediately would surface "Enemy hits
   *  Aelar for 5" before the enemy token finished walking up to the
   *  player. We hold the log at its pre-update length until the event
   *  queue drains, then `applyState` clears this cap and the full log
   *  appears alongside the action's final visual + audio frame. */
  private hudLogClip: number | null = null;
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
  private cinematic!: Cinematic;
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
  /** Set by `advanceChapter` just before `scene.restart`. Tells `shutdown` to
   *  close the WS without DELETE-ing the server-side session — otherwise the
   *  freshly-created next-chapter session (whose id is already on `gameClient`)
   *  gets deleted before `create()` can connect to it, and the next chapter
   *  hangs on a black screen waiting for a state_update that will never
   *  arrive. Reset in `init()` so a subsequent shutdown for a non-advance
   *  reason (LEAVE ENCOUNTER, scene swap to the main menu) still deletes
   *  cleanly. */
  private preserveSessionOnShutdown = false;
  /** Set on the very first state_update when `state.introduction` exists.
   *  We can't mount the IntroductionOverlay immediately — `ScreenEffects`
   *  parks the screen at full-black z-index 9000 in `create()`, and the
   *  overlay's backdrop sits at z-index 100, so an eager mount would hide
   *  the modal behind the parked black. Instead we drain the startup queue
   *  (supertitle + screen_fade in) first, then mount the overlay against
   *  the revealed world. */
  private pendingIntroState: GameState | null = null;
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
    this.animatingEntityId = null;
    this.preserveSessionOnShutdown = false;
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
      onLeaveEncounter:  () => this.leaveEncounter(),
      onIntroClosed:     (intro) => this.hud.addGmAssistantMessage(intro),
      getItems:    () => this.registry.get("equipment") as ItemDef[],
      getSpells:   () => (this.registry.get("spells") ?? []) as SpellDef[],
      getFeatures: () => (this.registry.get("features") ?? []) as FeatureDef[],
      getClasses:  () => (this.registry.get("classes") ?? []) as ClassDef[],
      getSubclasses: () => (this.registry.get("subclasses") ?? []) as SubclassDef[],
      // Conversation system wiring — the overlay ships choice / end actions
      // through the same `sendAction` path every other interactive surface
      // uses. The state-update tick refreshes the overlay against the
      // server's `activeConversation`.
      onConversationChoice: (index) => gameClient.sendAction({ type: "conversationChoice", choiceIndex: index }),
      onConversationEnd:    () => gameClient.sendAction({ type: "conversationEnd" }),
      onConversationOpenAigm: () => this.hud.openGmInput(),
      resolveSpeakerName: (ref) => this.resolveConversationSpeakerName(ref),
      resolveSpeakerToken: (ref) => this.resolveConversationSpeakerToken(ref),
      getConversations: () => (this.registry.get("conversations") ?? []) as import("../net/types").ConversationDef[],
    });
    if (this.pendingIsResume) this.overlays.markResumed();

    this.speechBubbles = new SpeechBubbles();
    this.speechBubbles.setEntityResolver((entityId) => this.resolveEntityScreenPos(entityId));
    this.screenEffects = new ScreenEffects();
    this.cinematic = new Cinematic({
      screenEffects: this.screenEffects,
      playerPanelFadeOut: (ms) => this.playerPanel.fadeOut(ms),
      playerPanelFadeIn:  (ms) => this.playerPanel.fadeIn(ms),
      targetPanelFadeOut: (ms) => this.targetPanel.fadeOut(ms),
      targetPanelFadeIn:  (ms) => this.targetPanel.fadeIn(ms),
      hudFadeOut: (ms) => this.hud.fadeOut(ms),
      hudFadeIn:  (ms) => this.hud.fadeIn(ms),
      hasTargetSelected: () => !!this.selectedEntityId,
      restoreTargetPanel: () => {
        if (!this.gameState || !this.selectedEntityId) return;
        const nState = this.gameState.npcs.find((n) => n.id === this.selectedEntityId);
        if (!nState) return;
        const def = this.resolveMonsterDef(nState.defId);
        this.targetPanel.show(def, nState, this.getFactions(), this.gameState.discoveredFactions ?? [], nState.conditions);
      },
      refreshHud: () => { if (this.gameState) this.updateHUD(this.gameState); },
    });
    // Park the screen at full black until the first `state_update` arrives.
    // Without this, the bare HUD/Player Panel/Target Panel flash for a few
    // hundred ms before any encounter-start cinematic events get to run.
    // The fade-OUT is unconditional; the fade-IN is driven by either the
    // server's startup events (supertitle + screen_fade in) or by the
    // safety fall-back in `handleStateUpdate` when neither is present. The
    // old eager `queueScreenFadeOnReady()` raced ahead of the supertitle and
    // cleared the black before the title played, so chapter advances landed
    // the supertitle on a half-revealed world.
    this.screenEffects.fadeOut(0);

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

    // CRITICAL — Phaser does NOT auto-call a `Scene.shutdown()` method. It
    // only emits the SHUTDOWN event; the user-defined method has to be
    // explicitly registered as a listener every time the scene is started.
    // Without this, the old chapter's PlayerPanel/HUD/TargetPanel/ScreenEffects
    // divs stay in the DOM after a chapter-advance restart — including the
    // old black ScreenEffects overlay parked at opacity 1, which sits at
    // z-index 9000 over the new chapter and makes the world appear black
    // even after the new cinematic finishes.
    this.events.once('shutdown', () => this.shutdown());
  }

  shutdown(): void {
    // Chapter-advance restart: keep the server-side session alive so the
    // re-entering scene can connect to its WS. Regular shutdowns (LEAVE
    // ENCOUNTER, going back to main menu) still tear it down.
    if (this.preserveSessionOnShutdown) {
      gameClient.closeWebSocket();
    } else {
      gameClient.disconnect();
    }
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

  // ── State update pipeline ─────────────────────────────────────────────────

  private handleStateUpdate(state: GameState, events: GameEvent[]): void {
    // Snapshot the previously-shown log length BEFORE swapping `gameState`
    // so the clip below pins to "what the player currently sees" rather
    // than to the incoming state's already-grown log.
    const prevLogLen = this.gameState?.eventLog?.length ?? 0;
    this.gameState = state;
    const isFirst = this.awaitingFirstStateUpdate;
    this.awaitingFirstStateUpdate = false;
    // npc_speech is normally spawned immediately so the bubble + chat line
    // appear without an extra queue hop. When the IntroductionOverlay is
    // about to mount (or already up), we defer them so the player isn't
    // missing the speech behind the modal — they'll appear after dismissal
    // in the same order they arrived.
    const deferSpeech = this.overlays.isIntroBlocking || (isFirst && !!state.introduction && !DevMode.disableSupertitle);
    // Pin the visible-log length to the previous state's log so new lines
    // don't render until the animation queue drains. Skipped on the first
    // state (the seeded intro lines + Objective should be visible
    // immediately as the world reveals). If a clip is already set (a
    // mid-animation state update arrived before the previous batch
    // finished), keep the existing cap so log entries from BOTH updates
    // stay hidden until the queue truly empties.
    if (!isFirst && this.hudLogClip === null) {
      this.hudLogClip = prevLogLen;
    }
    for (const ev of events) {
      if (ev.type === "entity_move") this.eventQueue.push(ev);
      else if (ev.type === "npc_speech") {
        if (deferSpeech) {
          // The queue handler in `processNextEvent` knows how to spawn a
          // bubble + log the line when one of these comes back out.
          this.eventQueue.push(ev);
        } else {
          this.speechBubbles.spawn(ev.entityId, ev.text);
          this.hud.addNpcSpeech(ev.speakerName, ev.text);
        }
      }
      else if (ev.type === "sound_ring" || ev.type === "play_sound") {
        // Audio cues are queued alongside entity_move so the swoosh / impact
        // SFX (and the perception sound-ring overlay) fire when the
        // matching animation reaches them, not on packet arrival. Otherwise
        // the player hears the hit while the attacker is still walking.
        this.eventQueue.push(ev);
      }
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
      const hasFade = events.some((e) => e.type === "screen_fade");
      if (!hasFade) {
        // Server didn't ship a fade in its startup events (e.g. encounter
        // with `disableSupertitle` dev flag) — drive ourselves out of black
        // so the player isn't stranded on a dark screen.
        this.eventQueue.unshift({ type: "screen_fade", mode: "in", durationMs: 400 });
      }
    }
    // Mount the IntroductionOverlay BEFORE draining any events on the very
    // first state, so encounter-start cinematics (supertitle, trigger
    // speech, combat) don't play behind the modal. The dismissal callback
    // resumes the queue. `processNextEvent` is also gated on
    // `isIntroBlocking` to handle state_updates that arrive mid-overlay.
    if (isFirst && state.introduction) {
      // Defer the IntroductionOverlay mount — see `pendingIntroState` doc.
      // The overlay would be hidden behind the parked black z-9000 fade and
      // the user would stare at a black screen with no way to dismiss it.
      this.pendingIntroState = state;
    }
    // Run applyState eagerly on the very first state so the map is drawn
    // and every player / NPC token exists BEFORE any `entity_move` events
    // try to animate them. Without this, the deferred enemy turns broadcast
    // after the supertitle / announcement land their entity_moves against
    // non-existent tokens (silent no-ops), the queue drains, the eventual
    // `applyState` reconciles tokens at their FINAL positions, and the
    // player sees the bandits already in place — exactly the "they had
    // already moved" bug. The eagerly-shown intro overlay sits on top, so
    // updating the HUD here doesn't leak anything visible to the player.
    if (isFirst) this.applyState(state);
    if (!this.animating && !this.overlays.isIntroBlocking) this.processNextEvent();
  }

  private processNextEvent(): void {
    if (this.overlays.isIntroBlocking) {
      // The introduction modal is up — hold every queued animation until the
      // player dismisses it. The dismissal callback re-enters this method.
      return;
    }
    if (this.eventQueue.length === 0) {
      // Cinematic queue drained — mount any deferred IntroductionOverlay
      // now, against the (presumably) revealed world.
      if (this.pendingIntroState) {
        const introState = this.pendingIntroState;
        this.pendingIntroState = null;
        this.overlays.showIntroIfNeeded(introState, () => {
          if (!this.animating) this.processNextEvent();
        });
        return;
      }
      this.animatingEntityId = null;
      // Release the event-log cap — the full log now matches the visible
      // world state, so any deferred lines (attack rolls, damage, status
      // changes accrued during the animations) appear in one batch synced
      // with the final frame of the action.
      this.hudLogClip = null;
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
      this.cinematic.runFade(event.mode, event.durationMs)
        .then(() => { this.animating = false; this.processNextEvent(); });
      return;
    } else if (event.type === "supertitle") {
      this.cinematic.runSupertitle(event.text, event.durationMs)
        .then(() => { this.animating = false; this.processNextEvent(); });
      return;
    } else if (event.type === "announcement") {
      const mode = event.mode ?? 'focused';
      if (mode === 'focused') {
        // UI fades out FIRST (general principle: when player control is taken
        // away, panels are the first to leave); only once the UI is gone do
        // we render the announcement card. On the way back: hide the card,
        // then fade the UI back in.
        void this.cinematic.runFocusedAnnouncement(event.text, event.durationMs)
          .then(() => { this.animating = false; this.processNextEvent(); });
        return;
      }
      // Unfocused: fire-and-forget so the player keeps moving and the event
      // queue continues processing while the card floats in the world.
      void this.cinematic.runUnfocusedAnnouncement(event.text, event.durationMs);
      // Fall through to default (animating = false, processNextEvent).
    } else if (event.type === "npc_speech") {
      // Deferred-speech handler — the bubble + chat line normally fire from
      // `handleStateUpdate`, but encounter-start speech queued behind the
      // introduction overlay comes out via this path so it actually shows.
      this.speechBubbles.spawn(event.entityId, event.text);
      this.hud.addNpcSpeech(event.speakerName, event.text);
    } else if (event.type === "play_sound") {
      playSound(event.sound);
    } else if (event.type === "sound_ring") {
      this.visionMask?.pushSoundRing(event.x, event.y, event.intensity);
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

    // Skip the eager intro mount when one is queued for after-cinematic
    // mount in processNextEvent — otherwise it would land behind the parked
    // black fade and the user couldn't see or dismiss it.
    if (!this.pendingIntroState) this.overlays.showIntroIfNeeded(state);
    this.overlays.refreshCharacterSheetIfOpen(state);
    this.overlays.syncReactionPrompt(state);
    this.overlays.syncEncounterComplete(state);
    this.overlays.syncConversation(state);

    this.updateHUD(state);
  }

  // ── Entity reconciliation ─────────────────────────────────────────────────

  private reconcileNpcs(state: GameState): void {
    // NPCs flagged as `hidden` (server-side Vision system — set via the
    // `set_npc_hidden` trigger action and cleared by the passive Perception
    // sweep on movement) are invisible to the player. They still exist in
    // `state.npcs` for combat/AI; the client just doesn't render them or
    // surface them in the Target Panel until the engine clears the flag.
    const visibleNpcs = state.npcs.filter(n => !n.conditions.includes('hidden'));
    const allIds = new Set(visibleNpcs.map(n => n.id));
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
    for (const nState of visibleNpcs) {
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
    if (this.cinematic.isFocusedAnnouncementActive()) return;
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
        // Self-click during creature-target mode resolves as self-target so
        // touch-range buff spells (Longstrider, Jump, …) work via the
        // existing target picker. The Player Panel toggle is suppressed
        // while in spell-target mode so clicking yourself never silently
        // closes the panel.
        const isSelfClick = tileX === ps.tileX && tileY === ps.tileY;
        const validTarget = isSelfClick ? 'player' : (nState && nState.hp > 0 ? nState.id : null);
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
    if (this.cinematic.isFocusedAnnouncementActive()) return;
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
      onOpenSpells:     () => { if (this.gameState) this.overlays.openCharacterSheet(this.gameState, 'spells'); },
      onReleaseConcentration: () => gameClient.sendAction({ type: "releaseConcentration" }),
      onDevCompleteObjective: () => gameClient.sendAction({ type: "devCompleteEncounter" }),
      onLeaveEncounter: () => this.leaveEncounter(),
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

    // Clip the visible log while an animation queue is draining so log
    // entries don't precede the matching visual / audio frame. The cap is
    // set by `handleStateUpdate` to the previous-state log length and
    // released by `processNextEvent` when the queue empties.
    const eventLog = this.hudLogClip !== null && this.hudLogClip < state.eventLog.length
      ? state.eventLog.slice(0, this.hudLogClip)
      : state.eventLog;

    return {
      mode:      state.phase,
      playerDef: this.playerDef,
      playerHp:  state.player.hp,
      turnOrderChips,
      eventLog,
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
      statusChips: buildPlayerStatusChips(state.player, concSpell?.name ?? null),
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
    // Touch-range buff spells (Longstrider, Jump, Mage Armor, …) also enter
    // creature-target mode: SRD specifies "touch a creature", and even
    // self-only buffs benefit from the explicit click so the player isn't
    // surprised when a CAST press silently applies a buff.
    const needsCreatureTarget =
      spell.attack === 'ranged-spell' || spell.attack === 'melee-spell' || spell.attack === 'auto-hit'
      || !!spell.weaponAttack
      || (!!spell.save && !spell.area);
    const isTouchBuff = spell.range === 'touch' &&
      !spell.attack && !spell.save && !spell.area && !spell.summon && !spell.darts;
    const isAoe = !!spell.area;

    if (needsCreatureTarget || isTouchBuff) {
      this.spellTargetMode = { kind: "creature", spellId, spellName: spell.name, asRitual, damageTypeChoice };
    } else if (isAoe) {
      // Mirror server `tilesInArea`: sphere uses a chebyshev-disc radius
      // (`ceil(sizeFeet / 5)`), cube uses a tile-side length, cone uses a
      // reach. The preview reads `shape`, `sideTiles`, and `selfAnchored`
      // to paint the matching footprint as the cursor moves.
      const sizeFeet = spell.area?.sizeFeet ?? 5;
      const shape = (spell.area?.shape ?? "sphere") as "cone" | "sphere" | "cube" | "line";
      const sideTiles = Math.max(1, Math.ceil(sizeFeet / 5));
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
      // Self-target click: fire the cast with no targetIds. The engine
      // routes the cast through `resolveUtilitySpell` (or its specific case)
      // which applies the buff to the caster. Only valid for touch-range
      // buff spells; clicking self for a Charm Person or Chill Touch
      // cancels (it's not a legal self-target).
      if (targetNpcId === 'player') {
        const isTouchBuff = spell.range === 'touch' &&
          !spell.attack && !spell.save && !spell.area && !spell.summon && !spell.darts;
        if (!isTouchBuff) { this.exitSpellTargetMode(); return; }
        gameClient.sendAction({ type: "castSpell", spellId: stm.spellId, slotLevel, asRitual: stm.asRitual, damageTypeChoice: stm.damageTypeChoice });
        this.exitSpellTargetMode();
        return;
      }
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
   * Mirror server `tilesInArea` to enumerate the creatures the AOE actually
   * covers, so the SpellTargetSelector can list them. Non-ally creatures are
   * tagged for the picker's default-checked state.
   *
   * Sphere placed at a click follows the SRD grid-intersection rule —
   * 2*r tiles per side anchored at the click. Cube uses tile-side length,
   * centred for odd sizes, extends right+down for even sizes. Sleep is the
   * currently-shipped consumer.
   */
  private creaturesInPlacedArea(spell: SpellDef, tile: { x: number; y: number }): SpellTargetCandidate[] {
    if (!this.gameState) return [];
    const sizeFeet = spell.area?.sizeFeet ?? 5;
    const r = Math.max(1, Math.ceil(sizeFeet / 5));
    let xMin: number, xMax: number, yMin: number, yMax: number;
    if (spell.area?.shape === 'sphere') {
      const sideTiles = 2 * r;
      xMin = tile.x; xMax = tile.x + sideTiles - 1; yMin = tile.y; yMax = tile.y + sideTiles - 1;
    } else {
      const side = r;
      if (side % 2 === 1) {
        const rr = (side - 1) / 2;
        xMin = tile.x - rr; xMax = tile.x + rr; yMin = tile.y - rr; yMax = tile.y + rr;
      } else {
        const offset = side - 1;
        xMin = tile.x; xMax = tile.x + offset; yMin = tile.y; yMax = tile.y + offset;
      }
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
  /**
   * Tear down the live session and return to the encounter-setup menu.
   * Fired by the Player Panel's LEAVE ENCOUNTER button AND by the single-
   * encounter wrap-up overlay's RETURN TO MENU CTA — both routes need to
   * dispose the canvas-bound UI before the scene swaps. Inside a rest
   * session we route through the chapter-advance flow instead so the
   * server picks up the next chapter (LEAVE means "I'm done resting").
   */
  private leaveEncounter(): void {
    if (this.gameState?.adventureContext?.isRestSession) {
      void this.advanceChapter();
      return;
    }
    this.uiDestroyed = true;
    this.playerPanel.destroy();
    this.targetPanel.destroy();
    this.hud.destroy();
    this.speechBubbles.destroy();
    this.screenEffects.destroy();
    this.uiScale.destroy();
    void gameClient.disconnect().then(() => this.scene.start("EncounterSetupScene"));
  }

  private async advanceChapter(): Promise<void> {
    // First-time chapter advance (NOT leaving a rest session): if the adventure
    // has a rest-stop encounter configured AND we're not on the final chapter,
    // surface the prompt and let the player choose between resting first or
    // skipping straight to the next chapter. Leaving rest re-enters
    // advanceChapter via LEAVE ENCOUNTER → by then `isRestSession` is true and
    // the prompt is bypassed.
    const advCtx = this.gameState?.adventureContext;
    const hasNextChapter = !!advCtx && advCtx.chapterIndex < advCtx.totalChapters - 1;
    if (advCtx?.restEncounterId && !advCtx.isRestSession && hasNextChapter) {
      this.showRestPrompt(advCtx.restEncounterId);
      return;
    }
    return this.runChapterAdvance();
  }

  /** Pop the "Rest first?" modal and dispatch the player's choice. The modal
   *  renders at z-index 9100 so it floats above the parked black fade that
   *  `ScreenEffects` puts up during the cinematic transition. */
  private showRestPrompt(restEncounterId: string): void {
    const title = this.resolveEncounterTitle(restEncounterId) ?? 'the rest encounter';
    const prompt = new RestPromptOverlay(title, {
      onRest: () => void this.runRest(),
      onSkip: () => void this.runChapterAdvance(),
    });
    // `prompt` retains a self-reference to its DOM root; it destroys itself
    // when the user clicks a button. We don't keep a field for it — the modal
    // is fire-and-forget per advance call.
    void prompt;
  }

  /** Resolve a rest encounter id to a human-readable title via the cached
   *  encounters registry. Returns null when the encounter isn't in the
   *  registry (e.g. the user navigated past the boot stage offline). */
  private resolveEncounterTitle(encounterId: string): string | null {
    const encs = this.registry.get('encounters') as Array<{ id: string; encounterTitle?: string }> | undefined;
    return encs?.find((e) => e.id === encounterId)?.encounterTitle ?? null;
  }

  /** Boot the rest-stop interlude session — mirrors the chapter-advance scene
   *  restart but hits `/adventure/.../rest` instead. */
  private async runRest(): Promise<void> {
    const CHAPTER_FADE_MS = 1200;
    await this.screenEffects.fadeOut(CHAPTER_FADE_MS);
    gameClient.closeWebSocket();
    try {
      const result = await gameClient.startRest(this.playerDef.id);
      this.uiScale.destroy();
      this.preserveSessionOnShutdown = true;
      this.scene.restart({
        sessionId: result.sessionId,
        playerDef: result.playerDef,
        isResume: false,
        fadeInOnStart: true,
        fadeInDurationMs: CHAPTER_FADE_MS,
      });
    } catch (err) {
      console.error('startRest failed', err);
      await this.screenEffects.fadeIn(CHAPTER_FADE_MS);
    }
  }

  /**
   * The actual chapter-advance fetch + scene restart. Split out from
   * `advanceChapter` so the rest-stop "skip" button and the LEAVE ENCOUNTER
   * call from inside a rest session can both jump straight here without
   * re-evaluating the prompt.
   *
   * IMPORTANT — close the WS BEFORE the advance request fires. The server
   * deletes the just-finished session as part of advancing (which closes
   * the WS from its end), and if `intentionalClose` is still false when
   * that cascade reaches us, `ConnectionMonitor` treats it as a server-died
   * disconnect and reloads the page — bouncing the player back to the main
   * menu.
   */
  private async runChapterAdvance(): Promise<void> {
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
      // `preserveSessionOnShutdown` keeps `shutdown()` from DELETE-ing the
      // newly-created session — `gameClient.sessionId` already points at
      // the next chapter, and disconnect would kill it before `create()`
      // could open a WS.
      this.preserveSessionOnShutdown = true;
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
    this.playerPanel.refresh(
      state.player.hp,
      this.playerDef.maxHp,
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
    } else if (stm.shape === "sphere") {
      // Sphere preview:
      //   self-anchored → chebyshev disc on the caster's tile centre.
      //   placed       → SRD grid-intersection rule: 2*r tiles per side
      //                   anchored at the clicked tile (top-left).
      const r = side;
      if (stm.selfAnchored) {
        const cx = this.player.tileX, cy = this.player.tileY;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) paintTile(cx + dx, cy + dy);
        }
      } else {
        const sideTiles = 2 * r;
        for (let dy = 0; dy < sideTiles; dy++) {
          for (let dx = 0; dx < sideTiles; dx++) paintTile(tileX + dx, tileY + dy);
        }
      }
    } else {
      // Cube preview. Self-anchored (Thunderwave) extends FROM the caster
      // in the cursor direction — caster's tile is NOT in the cube.
      // Click-anchored (Grease) extends from the clicked tile.
      if (stm.selfAnchored) {
        let ddx = Math.sign(tileX - this.player.tileX);
        let ddy = Math.sign(tileY - this.player.tileY);
        if (ddx === 0 && ddy === 0) ddx = 1;
        const halfLow  = Math.floor((side - 1) / 2);
        const halfHigh = Math.ceil((side - 1) / 2);
        const cx0 = this.player.tileX, cy0 = this.player.tileY;
        let xMin: number, xMax: number, yMin: number, yMax: number;
        if (ddx === 0)      { xMin = cx0 - halfLow; xMax = cx0 + halfHigh; }
        else if (ddx > 0)   { xMin = cx0 + 1;       xMax = cx0 + side; }
        else                { xMin = cx0 - side;    xMax = cx0 - 1; }
        if (ddy === 0)      { yMin = cy0 - halfLow; yMax = cy0 + halfHigh; }
        else if (ddy > 0)   { yMin = cy0 + 1;       yMax = cy0 + side; }
        else                { yMin = cy0 - side;    yMax = cy0 - 1; }
        for (let y = yMin; y <= yMax; y++) {
          for (let x = xMin; x <= xMax; x++) paintTile(x, y);
        }
      } else {
        const cx = tileX, cy = tileY;
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

  /** Resolve a conversation speaker ref (`"player"` or `"npc_<id>"`) to a
   *  display name. Used by `ConversationOverlay` via `OverlayManager`. */
  private resolveConversationSpeakerName(ref: string): string {
    if (ref === "player") return this.playerDef.name;
    // Strip the "npc_" prefix and look up the runtime NPC by instance id.
    const id = ref.startsWith("npc_") ? ref.slice(4) : ref;
    const npc = this.gameState?.npcs.find((n) => n.id === id || n.defId === id);
    if (!npc) return ref;
    return npc.revealedName ?? npc.name;
  }

  /** Resolve a conversation speaker ref to a token asset URL the overlay
   *  can embed. Returns null when no token is known. */
  private resolveConversationSpeakerToken(ref: string): string | null {
    if (ref === "player") return `${API_URL}${tokenAssetForPlayer(this.playerDef)}`;
    const id = ref.startsWith("npc_") ? ref.slice(4) : ref;
    const npc = this.gameState?.npcs.find((n) => n.id === id || n.defId === id);
    if (!npc) return null;
    const def = this.resolveMonsterDef(npc.defId);
    const path = def.tokenAsset ?? tokenAssetForMonster(def);
    return path ? `${API_URL}${path}` : null;
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
    // Conversation-system path: when the selected NPC has a `conversationId`
    // and the engine isn't in combat, the TALK button opens the
    // ConversationOverlay instead of the AIGM speech bubble. The AIGM
    // remains the fallback for combat sayto and for NPCs without a
    // scripted conversation.
    const target = this.gameState.npcs.find((n) => n.id === this.selectedEntityId);
    if (target && this.gameState.phase === "exploring") {
      const npcDefs = (this.registry.get("npcs") ?? []) as NPCDef[];
      const def = npcDefs.find((n) => n.id === target.defId);
      if (def?.conversationId) {
        gameClient.sendAction({ type: "startConversation", npcRef: `npc_${target.id}`, conversationId: def.conversationId });
        return;
      }
    }
    if (this.speechInputBubble) {
      this.speechInputBubble.destroy();
      this.speechInputBubble = null;
    }
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
