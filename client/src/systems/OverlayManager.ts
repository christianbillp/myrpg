import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/items";
import { AIDMOverlay, ChatMessage, DMPersona } from "../ui/AIDMOverlay";
import { InventoryOverlay } from "../ui/InventoryOverlay";
import { IntroductionOverlay } from "../ui/IntroductionOverlay";
import { GameState, EquipmentSlots } from "../net/types";
import { UIScale } from "../ui/UIScale";

export interface OverlayCallbacks {
  onEquip: (slot: "armor" | "weapon" | "shield", itemId: string) => void;
  onUnequip: (slot: "armor" | "weapon" | "shield") => void;
  onUsePotion: () => void;
  onSendAIDM: (message: string, history: ChatMessage[], persona: DMPersona) => Promise<{ reply: string; rollResults: string[] }>;
  onDisableKeyboard: () => void;
  onEnableKeyboard: () => void;
  onRefresh: () => void;
  getItems: () => ItemDef[];
}

export class OverlayManager {
  private readonly scale: UIScale;
  private readonly playerDef: PlayerDef;
  private readonly callbacks: OverlayCallbacks;

  private introOverlay: IntroductionOverlay | null = null;
  private aidmOverlay: AIDMOverlay | null = null;
  private inventoryOverlay: InventoryOverlay | null = null;
  private aidmHistory: ChatMessage[] = [];
  private aidmPersona: DMPersona = "story";
  private introShown = false;

  constructor(scale: UIScale, playerDef: PlayerDef, callbacks: OverlayCallbacks) {
    this.scale = scale;
    this.playerDef = playerDef;
    this.callbacks = callbacks;
  }

  get isAnyOpen(): boolean {
    return !!(this.introOverlay || this.aidmOverlay || this.inventoryOverlay);
  }

  reset(): void {
    this.introOverlay = null;
    this.aidmOverlay = null;
    this.inventoryOverlay = null;
    this.aidmHistory = [];
    this.aidmPersona = "story";
    this.introShown = false;
  }

  showIntroIfNeeded(state: GameState): void {
    if (this.introShown || !state.introduction) return;
    this.introShown = true;
    const introduction = state.introduction;
    this.introOverlay = new IntroductionOverlay(
      this.scale,
      state.encounterTypes,
      this.playerDef,
      { introduction, context: state.encounterContext, enemyCount: 0, secrets: [], riddle: null, quests: [] },
      () => {
        this.introOverlay = null;
        this.aidmHistory = [{ role: "assistant", content: introduction }];
      },
    );
  }

  openInventory(state: GameState): void {
    if (this.aidmOverlay || this.inventoryOverlay) return;
    const allItems = this.callbacks.getItems();
    const byId = Object.fromEntries(allItems.map(i => [i.id, i]));
    const inventory = state.player.inventoryIds.map(id => byId[id]).filter(Boolean) as ItemDef[];
    const slots: EquipmentSlots = { ...state.player.equippedSlots };
    const canUse = state.phase === "exploring"
      || (state.phase === "player_turn" && !state.player.bonusActionUsed);

    this.inventoryOverlay = new InventoryOverlay(
      this.scale,
      this.playerDef,
      slots,
      state.player.equippedSlotLabels,
      inventory,
      allItems,
      state.player.gold,
      canUse,
      (slot, itemId) => { this.callbacks.onEquip(slot, itemId); this.inventoryOverlay = null; },
      (slot) => { this.callbacks.onUnequip(slot); this.inventoryOverlay = null; },
      (_itemId) => { this.callbacks.onUsePotion(); this.inventoryOverlay = null; },
      () => { this.inventoryOverlay = null; },
    );
  }

  openDM(): void {
    if (this.aidmOverlay) return;
    this.aidmOverlay = new AIDMOverlay(
      this.scale,
      this.aidmHistory,
      this.aidmPersona,
      (msg, history, persona) => this.callbacks.onSendAIDM(msg, history, persona),
      (history, persona) => {
        this.aidmHistory = history;
        this.aidmPersona = persona;
        this.aidmOverlay = null;
        this.callbacks.onRefresh();
      },
      () => this.callbacks.onDisableKeyboard(),
      () => this.callbacks.onEnableKeyboard(),
    );
  }
}
