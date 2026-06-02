import { PlayerDef } from "../../../shared/types";
import { ItemDef, EquipmentDef } from "../../../shared/types";
import { CharacterSheetOverlay, CharacterSheetInputs } from "../ui/CharacterSheetOverlay";
import { IntroductionOverlay } from "../ui/IntroductionOverlay";
import { ReactionPromptOverlay } from "../ui/ReactionPromptOverlay";
import { EncounterCompleteOverlay } from "../ui/EncounterCompleteOverlay";
import { NextChapterButton } from "../ui/NextChapterButton";
import { ConversationOverlay } from "../ui/ConversationOverlay";
import type { GameState, SpellDef, PendingReaction, ConversationDef, FeatureDef, ClassDef, SubclassDef } from "../../../shared/types";
import { UIScale } from "../ui/UIScale";
import { WorldPause } from "../net/WorldPause";
import { DevMode } from "../devMode";

export interface OverlayCallbacks {
  onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void;
  onUnequip: (slot: "armor" | "weapon" | "shield") => void;
  onUsePotion: () => void;
  /** Begin a normal cast — caller is responsible for prompting for a target if the spell needs one. */
  onBeginSpellCast: (spellId: string) => void;
  /** Begin a ritual cast — exploring-only, no slot consumed. Caller handles target prompting. */
  onBeginRitualCast: (spellId: string) => void;
  /** Player accepted a pending reaction prompt — server should fire the deferred effect. */
  onAcceptReaction: () => void;
  /** Player declined / dismissed the reaction prompt — server should skip the deferred effect. */
  onDeclineReaction: () => void;
  /** Player pressed NEXT CHAPTER on the chapter-complete overlay. */
  onAdvanceChapter: () => void;
  /** Player pressed RETURN TO MENU on the single-encounter completion
   *  overlay. Wired by the host scene to the same teardown path as the
   *  Player Panel's LEAVE ENCOUNTER button. */
  onLeaveEncounter: () => void;
  /** Player dismissed the IntroductionOverlay — push the introduction text
   *  into the GM chat so it persists as the opening narration after the
   *  modal closes. */
  onIntroClosed: (introduction: string) => void;
  getItems: () => ItemDef[];
  getSpells: () => SpellDef[];
  getFeatures: () => FeatureDef[];
  getClasses: () => ClassDef[];
  getSubclasses: () => SubclassDef[];
  /** Conversation system — host scene wires these to PlayerAction sends.
   *  `onOpenAigm` is Phase 5: surfaces the GM chat dropup with the
   *  conversation transcript pre-loaded. For now it can be a no-op. */
  onConversationChoice: (index: number) => void;
  onConversationEnd: () => void;
  onConversationOpenAigm?: () => void;
  /** Lookup helpers the overlay needs to render speakers — host scene
   *  computes from `state.npcs` + `playerDef`. */
  resolveSpeakerName: (entityRef: string) => string;
  resolveSpeakerToken: (entityRef: string) => string | null;
  /** Conversation registry loaded at boot — see `BootScene`. */
  getConversations: () => ConversationDef[];
}

export class OverlayManager {
  private readonly scale: UIScale;
  private playerDef: PlayerDef;
  private readonly callbacks: OverlayCallbacks;

  private introOverlay: IntroductionOverlay | null = null;
  private characterSheet: CharacterSheetOverlay | null = null;
  private reactionPrompt: ReactionPromptOverlay | null = null;
  private encounterCompleteOverlay: EncounterCompleteOverlay | null = null;
  private conversation: ConversationOverlay | null = null;
  /** Tracks which conversation id the open overlay is for so a state change
   *  to a different conversation re-opens cleanly. */
  private conversationShownFor: string | null = null;
  /** Persistent top-center button shown after the encounter-complete overlay is dismissed. */
  private nextChapterButton: NextChapterButton | null = null;
  /** Tracks which pending-reaction the open prompt is for, so we don't rebuild on every state update. */
  private reactionShownFor: PendingReaction | null = null;
  /** Tracks which dedup key the encounter-complete overlay was shown for,
   *  so reopening on every tick is suppressed. */
  private encounterCompleteShownFor: string | null = null;
  private introShown = false;

  constructor(scale: UIScale, playerDef: PlayerDef, callbacks: OverlayCallbacks) {
    this.scale = scale;
    this.playerDef = playerDef;
    this.callbacks = callbacks;
  }

  get isAnyOpen(): boolean {
    return !!(this.introOverlay || this.characterSheet || this.reactionPrompt || this.encounterCompleteOverlay || this.conversation);
  }

  reset(): void {
    this.introOverlay = null;
    this.characterSheet = null;
    this.reactionPrompt = null;
    this.reactionShownFor = null;
    if (this.encounterCompleteOverlay) { this.encounterCompleteOverlay.destroy(); this.encounterCompleteOverlay = null; }
    if (this.nextChapterButton) { this.nextChapterButton.destroy(); this.nextChapterButton = null; }
    if (this.conversation) { this.conversation.destroy(); this.conversation = null; }
    this.conversationShownFor = null;
    this.encounterCompleteShownFor = null;
    this.introShown = false;
  }

  markResumed(): void {
    this.introShown = true;
  }

  /** Replace the cached `PlayerDef` (used after a level-up). The
   *  character-sheet overlay refreshes lazily on next open. */
  setPlayerDef(def: PlayerDef): void {
    this.playerDef = def;
  }

  /** True while the IntroductionOverlay is on screen — the host scene checks
   *  this to gate event-queue processing so encounter-start triggers don't
   *  animate behind the modal. */
  get isIntroBlocking(): boolean { return !!this.introOverlay; }

  showIntroIfNeeded(state: GameState, onDismissed?: () => void): void {
    if (this.introShown || !state.introduction) return;
    this.introShown = true;
    const intro = state.introduction;
    // Dev-mode bypass — when the supertitle is disabled, push the intro
    // text straight to the GM chat without ever mounting the overlay. No
    // WorldPause acquire/release pair because the overlay was never shown.
    if (DevMode.disableSupertitle) {
      this.callbacks.onIntroClosed(intro);
      onDismissed?.();
      return;
    }
    WorldPause.acquire('overlay:introduction');
    this.introOverlay = new IntroductionOverlay(
      this.scale,
      state.encounterTitle,
      this.playerDef,
      intro,
      () => {
        this.introOverlay = null;
        WorldPause.release('overlay:introduction');
        // Persist the introduction text into the GM chat as the encounter's
        // opening narration so the player can re-read it after dismissing
        // the modal.
        this.callbacks.onIntroClosed(intro);
        onDismissed?.();
      },
    );
  }

  openCharacterSheet(state: GameState, initialTab?: 'stats' | 'story' | 'equipment' | 'spells'): void {
    if (this.characterSheet) return;
    const inputs = this.buildInputs(state);
    WorldPause.acquire('overlay:character-sheet');
    this.characterSheet = new CharacterSheetOverlay(this.scale, inputs, {
      onEquip:   (slot, itemId) => this.callbacks.onEquip(slot, itemId),
      onUnequip: (slot)         => this.callbacks.onUnequip(slot),
      onUse:     (_itemId)      => this.callbacks.onUsePotion(),
      onCastSpell:  (spellId)   => { this.closeCharacterSheet(); this.callbacks.onBeginSpellCast(spellId); },
      onRitualCast: (spellId)   => { this.closeCharacterSheet(); this.callbacks.onBeginRitualCast(spellId); },
      onClose:   ()             => { this.characterSheet = null; WorldPause.release('overlay:character-sheet'); },
    }, initialTab);
  }

  /** Imperatively close the sheet (used when a spell-cast button is clicked from inside it). */
  private closeCharacterSheet(): void {
    if (!this.characterSheet) return;
    this.characterSheet.destroy();
    this.characterSheet = null;
    WorldPause.release('overlay:character-sheet');
  }

  /** Rebuild the active sheet against the latest state when a server update arrives. */
  refreshCharacterSheetIfOpen(state: GameState): void {
    if (!this.characterSheet) return;
    this.characterSheet.rebuild(this.buildInputs(state));
  }

  /**
   * Mirror `state.pendingReaction` into an open ReactionPromptOverlay. Opens
   * the overlay when a new reaction appears, leaves it open while the same
   * reaction is still pending, and closes it once the server clears the field.
   */
  syncReactionPrompt(state: GameState): void {
    const pending = state.pendingReaction;
    if (pending && this.reactionShownFor !== pending) {
      this.closeReactionPrompt();
      this.reactionShownFor = pending;
      this.reactionPrompt = new ReactionPromptOverlay(this.scale, pending, {
        onAccept:  () => { this.callbacks.onAcceptReaction();  this.reactionPrompt = null; this.reactionShownFor = null; },
        onDecline: () => { this.callbacks.onDeclineReaction(); this.reactionPrompt = null; this.reactionShownFor = null; },
      });
    } else if (!pending && this.reactionPrompt) {
      this.closeReactionPrompt();
    }
  }

  private closeReactionPrompt(): void {
    if (!this.reactionPrompt) return;
    this.reactionPrompt.destroy();
    this.reactionPrompt = null;
    this.reactionShownFor = null;
  }

  /**
   * Mirror `state.activeConversation` into the ConversationOverlay. Opens
   * the overlay when a conversation appears, refreshes the rendered node on
   * every state tick (so server-driven node jumps land), and closes it the
   * instant the server clears `activeConversation`.
   */
  syncConversation(state: GameState): void {
    const ac = state.activeConversation;
    if (!ac) {
      if (this.conversation) this.closeConversation();
      return;
    }
    // Conversation changed (different id) → tear down the old overlay so the
    // new one renders against the right def.
    if (this.conversationShownFor !== ac.conversationId) {
      this.closeConversation();
      const defs = this.callbacks.getConversations();
      const def = defs.find((c) => c.id === ac.conversationId);
      if (!def) return;
      WorldPause.acquire('overlay:conversation');
      this.conversationShownFor = ac.conversationId;
      this.conversation = new ConversationOverlay(
        this.scale, def, ac,
        (ref) => this.callbacks.resolveSpeakerName(ref),
        (ref) => this.callbacks.resolveSpeakerToken(ref),
        {
          onChoice: (i) => this.callbacks.onConversationChoice(i),
          onEnd: () => this.callbacks.onConversationEnd(),
          onOpenAigm: this.callbacks.onConversationOpenAigm,
        },
      );
      return;
    }
    // Same conversation, possibly a different node — refresh.
    this.conversation?.refresh(ac);
  }

  private closeConversation(): void {
    if (!this.conversation) return;
    this.conversation.destroy();
    this.conversation = null;
    this.conversationShownFor = null;
    WorldPause.release('overlay:conversation');
  }

  /**
   * Two-stage flow when an encounter completes:
   *   1. The first time `state.encounterComplete` is true, open the
   *      "Wrap Up Loose Ends" overlay. The player can dismiss it (close
   *      button, X, or backdrop click) and continue exploring.
   *   2. Once dismissed, render a persistent NEXT CHAPTER / RETURN TO MENU
   *      button at the top-center of the screen. Clicking it fires the
   *      appropriate callback.
   *
   * Adventure mode keys the "shown once" dedup on the chapter id; single-
   * encounter mode keys it on a sentinel string (only one encounter per
   * session, so any non-null marker works). The persistent button stays
   * visible until the scene resets.
   */
  syncEncounterComplete(state: GameState): void {
    if (!state.encounterComplete) return;
    const ctx = state.adventureContext;
    const dedupKey = ctx ? ctx.chapterId : "single-encounter";
    if (this.encounterCompleteShownFor === dedupKey) return;
    this.encounterCompleteShownFor = dedupKey;

    const isFinal = ctx ? ctx.chapterIndex >= ctx.totalChapters - 1 : false;
    const buttonLabel = !ctx
      ? "Return to Menu"
      : isFinal
        ? "Finish Adventure"
        : "Next Chapter →";
    const advance = (): void => {
      this.closeEncounterComplete();
      if (this.nextChapterButton) { this.nextChapterButton.destroy(); this.nextChapterButton = null; }
      if (ctx) this.callbacks.onAdvanceChapter();
      else this.callbacks.onLeaveEncounter();
    };
    WorldPause.acquire('overlay:encounter-complete');
    this.encounterCompleteOverlay = new EncounterCompleteOverlay(
      this.scale,
      state.encounterTitle,
      ctx ? { index: ctx.chapterIndex, total: ctx.totalChapters } : null,
      () => {
        this.closeEncounterComplete();
        this.showNextChapterButton(buttonLabel, advance);
      },
      advance,
    );
  }

  private closeEncounterComplete(): void {
    if (!this.encounterCompleteOverlay) return;
    this.encounterCompleteOverlay.destroy();
    this.encounterCompleteOverlay = null;
    WorldPause.release('overlay:encounter-complete');
  }

  private showNextChapterButton(label: string, onAdvance: () => void): void {
    if (this.nextChapterButton) return;
    this.nextChapterButton = new NextChapterButton(this.scale, label, () => {
      if (this.nextChapterButton) { this.nextChapterButton.destroy(); this.nextChapterButton = null; }
      onAdvance();
    });
  }

  private buildInputs(state: GameState): CharacterSheetInputs {
    const allItems = this.callbacks.getItems();
    const byId = Object.fromEntries(allItems.map(i => [i.id, i]));
    const inventory = state.player.inventoryIds.map(id => byId[id]).filter(Boolean) as ItemDef[];

    const { armorId, weaponId, shieldId } = state.player.equippedSlots;
    const equippedItems: Partial<Record<"armor" | "weapon" | "shield", EquipmentDef>> = {};
    if (armorId  && byId[armorId])  equippedItems.armor  = byId[armorId]  as EquipmentDef;
    if (weaponId && byId[weaponId]) equippedItems.weapon = byId[weaponId] as EquipmentDef;
    if (shieldId && byId[shieldId]) equippedItems.shield = byId[shieldId] as EquipmentDef;

    const canUseConsumable = state.phase === "exploring"
      || (state.phase === "player_turn" && !state.player.bonusActionUsed);

    const allSpells = this.callbacks.getSpells();
    const concSpell = state.player.concentratingOn
      ? allSpells.find((sp) => sp.id === state.player.concentratingOn)
      : null;

    return {
      playerDef: this.playerDef,
      state: state.player,
      equippedItems,
      inventory,
      canUseConsumable,
      allSpells,
      concentratingOnName: concSpell?.name ?? null,
      castableSpellIds: state.availableActions.castableSpellIds,
      isExploring: state.phase === "exploring",
      features: this.callbacks.getFeatures(),
      classes: this.callbacks.getClasses(),
      subclasses: this.callbacks.getSubclasses(),
    };
  }
}
