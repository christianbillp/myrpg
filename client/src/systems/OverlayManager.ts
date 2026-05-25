import { PlayerDef } from "../data/player";
import { ItemDef, EquipmentDef } from "../data/equipment";
import { InventoryOverlay } from "../ui/InventoryOverlay";
import { IntroductionOverlay } from "../ui/IntroductionOverlay";
import { GameState } from "../net/types";
import { UIScale } from "../ui/UIScale";

export interface OverlayCallbacks {
  onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void;
  onUnequip: (slot: "armor" | "weapon" | "shield") => void;
  onUsePotion: () => void;
  getItems: () => ItemDef[];
}

export class OverlayManager {
  private readonly scale: UIScale;
  private readonly playerDef: PlayerDef;
  private readonly callbacks: OverlayCallbacks;

  private introOverlay: IntroductionOverlay | null = null;
  private inventoryOverlay: InventoryOverlay | null = null;
  private introShown = false;

  constructor(scale: UIScale, playerDef: PlayerDef, callbacks: OverlayCallbacks) {
    this.scale = scale;
    this.playerDef = playerDef;
    this.callbacks = callbacks;
  }

  get isAnyOpen(): boolean {
    return !!(this.introOverlay || this.inventoryOverlay);
  }

  reset(): void {
    this.introOverlay = null;
    this.inventoryOverlay = null;
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

  openInventory(state: GameState): void {
    if (this.inventoryOverlay) return;
    const allItems = this.callbacks.getItems();
    const byId = Object.fromEntries(allItems.map(i => [i.id, i]));
    const inventory = state.player.inventoryIds.map(id => byId[id]).filter(Boolean) as ItemDef[];

    const { armorId, weaponId, shieldId } = state.player.equippedSlots;
    const equippedItems: Partial<Record<"armor" | "weapon" | "shield", EquipmentDef>> = {};
    if (armorId  && byId[armorId])  equippedItems.armor  = byId[armorId]  as EquipmentDef;
    if (weaponId && byId[weaponId]) equippedItems.weapon = byId[weaponId] as EquipmentDef;
    if (shieldId && byId[shieldId]) equippedItems.shield = byId[shieldId] as EquipmentDef;

    const canUse = state.phase === "exploring"
      || (state.phase === "player_turn" && !state.player.bonusActionUsed);

    this.inventoryOverlay = new InventoryOverlay(
      this.scale,
      this.playerDef,
      equippedItems,
      state.player.equippedSlotLabels,
      inventory,
      state.player.gold,
      canUse,
      (slot, itemId) => { this.callbacks.onEquip(slot, itemId); this.inventoryOverlay = null; },
      (slot)         => { this.callbacks.onUnequip(slot); this.inventoryOverlay = null; },
      (_itemId)      => { this.callbacks.onUsePotion(); this.inventoryOverlay = null; },
      ()             => { this.inventoryOverlay = null; },
    );
  }
}
