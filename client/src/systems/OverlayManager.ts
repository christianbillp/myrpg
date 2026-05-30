import { PlayerDef } from "../data/player";
import { ItemDef, EquipmentDef } from "../data/equipment";
import { CharacterSheetOverlay, CharacterSheetInputs } from "../ui/CharacterSheetOverlay";
import { IntroductionOverlay } from "../ui/IntroductionOverlay";
import { ReactionPromptOverlay } from "../ui/ReactionPromptOverlay";
import { ChapterCompleteOverlay } from "../ui/ChapterCompleteOverlay";
import { NextChapterButton } from "../ui/NextChapterButton";
import type { GameState, SpellDef, PendingReaction } from "../net/types";
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
  /** Player dismissed the IntroductionOverlay — push the introduction text
   *  into the GM chat so it persists as the opening narration after the
   *  modal closes. */
  onIntroClosed: (introduction: string) => void;
  getItems: () => ItemDef[];
  getSpells: () => SpellDef[];
}

export class OverlayManager {
  private readonly scale: UIScale;
  private playerDef: PlayerDef;
  private readonly callbacks: OverlayCallbacks;

  private introOverlay: IntroductionOverlay | null = null;
  private characterSheet: CharacterSheetOverlay | null = null;
  private reactionPrompt: ReactionPromptOverlay | null = null;
  private chapterComplete: ChapterCompleteOverlay | null = null;
  /** Persistent top-center button shown after the chapter-complete overlay is dismissed. */
  private nextChapterButton: NextChapterButton | null = null;
  /** Tracks which pending-reaction the open prompt is for, so we don't rebuild on every state update. */
  private reactionShownFor: PendingReaction | null = null;
  /** Tracks which chapter the complete-overlay was shown for, so reopening on every tick is suppressed. */
  private chapterCompleteShownFor: string | null = null;
  private introShown = false;

  constructor(scale: UIScale, playerDef: PlayerDef, callbacks: OverlayCallbacks) {
    this.scale = scale;
    this.playerDef = playerDef;
    this.callbacks = callbacks;
  }

  get isAnyOpen(): boolean {
    return !!(this.introOverlay || this.characterSheet || this.reactionPrompt || this.chapterComplete);
  }

  reset(): void {
    this.introOverlay = null;
    this.characterSheet = null;
    this.reactionPrompt = null;
    this.reactionShownFor = null;
    if (this.chapterComplete) { this.chapterComplete.destroy(); this.chapterComplete = null; }
    if (this.nextChapterButton) { this.nextChapterButton.destroy(); this.nextChapterButton = null; }
    this.chapterCompleteShownFor = null;
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

  openCharacterSheet(state: GameState): void {
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
    });
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
   * Two-stage flow when a chapter completes:
   *   1. The first time `state.chapterComplete` is true, open the
   *      "Wrap Up Loose Ends" overlay. The player can dismiss it (close
   *      button, X, or backdrop click) and continue exploring.
   *   2. Once dismissed, render a persistent NEXT CHAPTER button at the
   *      top-center of the screen. Clicking it fires `onAdvanceChapter`.
   *
   * The overlay only opens once per chapter (`chapterCompleteShownFor`
   * tracks the chapter id). The persistent button stays visible until the
   * scene resets (next chapter starts or player returns to menu).
   */
  syncChapterComplete(state: GameState): void {
    const ctx = state.adventureContext;
    if (!ctx || !state.chapterComplete) return;
    if (this.chapterCompleteShownFor === ctx.chapterId) return;
    this.chapterCompleteShownFor = ctx.chapterId;
    const isFinal = ctx.chapterIndex >= ctx.totalChapters - 1;
    const buttonLabel = isFinal ? "Finish Adventure" : `Next Chapter →`;
    const advance = () => {
      this.closeChapterComplete();
      if (this.nextChapterButton) { this.nextChapterButton.destroy(); this.nextChapterButton = null; }
      this.callbacks.onAdvanceChapter();
    };
    WorldPause.acquire('overlay:chapter-complete');
    this.chapterComplete = new ChapterCompleteOverlay(
      this.scale,
      state.encounterTitle,
      ctx.chapterIndex,
      ctx.totalChapters,
      () => {
        this.closeChapterComplete();
        this.showNextChapterButton(buttonLabel);
      },
      advance,
    );
  }

  private closeChapterComplete(): void {
    if (!this.chapterComplete) return;
    this.chapterComplete.destroy();
    this.chapterComplete = null;
    WorldPause.release('overlay:chapter-complete');
  }

  private showNextChapterButton(label: string): void {
    if (this.nextChapterButton) return;
    this.nextChapterButton = new NextChapterButton(this.scale, label, () => {
      if (this.nextChapterButton) { this.nextChapterButton.destroy(); this.nextChapterButton = null; }
      this.callbacks.onAdvanceChapter();
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
    };
  }
}
