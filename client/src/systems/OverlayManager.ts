import { PlayerDef } from "../data/player";
import { ItemDef, EquipmentDef } from "../data/equipment";
import { CharacterSheetOverlay, CharacterSheetInputs } from "../ui/CharacterSheetOverlay";
import { IntroductionOverlay } from "../ui/IntroductionOverlay";
import type { GameState, SpellDef } from "../net/types";
import { UIScale } from "../ui/UIScale";

export interface OverlayCallbacks {
  onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void;
  onUnequip: (slot: "armor" | "weapon" | "shield") => void;
  onUsePotion: () => void;
  getItems: () => ItemDef[];
  getSpells: () => SpellDef[];
}

export class OverlayManager {
  private readonly scale: UIScale;
  private readonly playerDef: PlayerDef;
  private readonly callbacks: OverlayCallbacks;

  private introOverlay: IntroductionOverlay | null = null;
  private characterSheet: CharacterSheetOverlay | null = null;
  private introShown = false;

  constructor(scale: UIScale, playerDef: PlayerDef, callbacks: OverlayCallbacks) {
    this.scale = scale;
    this.playerDef = playerDef;
    this.callbacks = callbacks;
  }

  get isAnyOpen(): boolean {
    return !!(this.introOverlay || this.characterSheet);
  }

  reset(): void {
    this.introOverlay = null;
    this.characterSheet = null;
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
      onClose:   ()             => { this.characterSheet = null; },
    });
  }

  /** Rebuild the active sheet against the latest state when a server update arrives. */
  refreshCharacterSheetIfOpen(state: GameState): void {
    if (!this.characterSheet) return;
    this.characterSheet.rebuild(this.buildInputs(state));
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
    };
  }
}
