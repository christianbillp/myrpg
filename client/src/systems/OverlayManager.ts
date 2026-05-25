import { PlayerDef } from "../data/player";
import { ItemDef, EquipmentDef } from "../data/equipment";
import { CharacterSheetOverlay, CharacterSheetInputs } from "../ui/CharacterSheetOverlay";
import { IntroductionOverlay } from "../ui/IntroductionOverlay";
import { ReactionPromptOverlay } from "../ui/ReactionPromptOverlay";
import type { GameState, SpellDef, PendingReaction } from "../net/types";
import { UIScale } from "../ui/UIScale";

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
  getItems: () => ItemDef[];
  getSpells: () => SpellDef[];
}

export class OverlayManager {
  private readonly scale: UIScale;
  private readonly playerDef: PlayerDef;
  private readonly callbacks: OverlayCallbacks;

  private introOverlay: IntroductionOverlay | null = null;
  private characterSheet: CharacterSheetOverlay | null = null;
  private reactionPrompt: ReactionPromptOverlay | null = null;
  /** Tracks which pending-reaction the open prompt is for, so we don't rebuild on every state update. */
  private reactionShownFor: PendingReaction | null = null;
  private introShown = false;

  constructor(scale: UIScale, playerDef: PlayerDef, callbacks: OverlayCallbacks) {
    this.scale = scale;
    this.playerDef = playerDef;
    this.callbacks = callbacks;
  }

  get isAnyOpen(): boolean {
    return !!(this.introOverlay || this.characterSheet || this.reactionPrompt);
  }

  reset(): void {
    this.introOverlay = null;
    this.characterSheet = null;
    this.reactionPrompt = null;
    this.reactionShownFor = null;
    this.introShown = false;
  }

  markResumed(): void {
    this.introShown = true;
  }

  showIntroIfNeeded(state: GameState): void {
    if (this.introShown || !state.introduction) return;
    this.introShown = true;
    this.introOverlay = new IntroductionOverlay(
      this.scale,
      state.encounterTitle,
      this.playerDef,
      state.introduction,
      () => { this.introOverlay = null; },
    );
  }

  openCharacterSheet(state: GameState): void {
    if (this.characterSheet) return;
    const inputs = this.buildInputs(state);
    this.characterSheet = new CharacterSheetOverlay(this.scale, inputs, {
      onEquip:   (slot, itemId) => this.callbacks.onEquip(slot, itemId),
      onUnequip: (slot)         => this.callbacks.onUnequip(slot),
      onUse:     (_itemId)      => this.callbacks.onUsePotion(),
      onCastSpell:  (spellId)   => { this.closeCharacterSheet(); this.callbacks.onBeginSpellCast(spellId); },
      onRitualCast: (spellId)   => { this.closeCharacterSheet(); this.callbacks.onBeginRitualCast(spellId); },
      onClose:   ()             => { this.characterSheet = null; },
    });
  }

  /** Imperatively close the sheet (used when a spell-cast button is clicked from inside it). */
  private closeCharacterSheet(): void {
    if (!this.characterSheet) return;
    this.characterSheet.destroy();
    this.characterSheet = null;
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
