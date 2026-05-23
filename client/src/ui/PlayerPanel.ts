import Phaser from "phaser";
import { PLAYER_PANEL_WIDTH, GRID_ROWS, TILE_SIZE } from "../constants";
import { makeButton } from "./UIButton";
import { PlayerDef } from "../data/player";
import { CombatMode } from "../net/types";

export interface QuestDisplay {
  title: string;
  progress: number;
  target: number;
  completed: boolean;
}

export interface PlayerPanelActionState {
  mode: CombatMode;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  playerHp: number;
  secondWindUses: number;
  playerHidden: boolean;
  playerDef: PlayerDef;
  enemies: Array<{ tileX: number; tileY: number; dead: boolean }>;
  playerTileX: number;
  playerTileY: number;
  hitDiceRemaining: number;
}

const DPR = window.devicePixelRatio;
const GRID_H = GRID_ROWS * TILE_SIZE;

type Visible = { setVisible(v: boolean): unknown };

export interface PlayerPanelCallbacks {
  onOpenInventory: () => void;
  onSearch: () => void;
  onAttack: () => void;
  onDash: () => void;
  onDodge: () => void;
  onDisengage: () => void;
  onSecondWind: () => void;
  onHide: () => void;
  onEndTurn: () => void;
  onDeathSave: () => void;
  onShortRest: () => void;
}

function chebyshev(x1: number, y1: number, x2: number, y2: number): number {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

export class PlayerPanel {
  private items: Visible[] = [];
  private hpBar: Phaser.GameObjects.Graphics;
  private hpText: Phaser.GameObjects.Text;
  private xpText: Phaser.GameObjects.Text;
  private questsText: Phaser.GameObjects.Text;
  private combatStatsText: Phaser.GameObjects.Text;
  private searchBtn: Phaser.GameObjects.Container;
  private readonly playerDef: PlayerDef;
  private readonly attackBtn: Phaser.GameObjects.Container;
  private readonly dashBtn: Phaser.GameObjects.Container;
  private readonly dodgeBtn: Phaser.GameObjects.Container;
  private readonly disengageBtn: Phaser.GameObjects.Container;
  private readonly secondWindBtn: Phaser.GameObjects.Container;
  private readonly hideBtn: Phaser.GameObjects.Container;
  private readonly endTurnBtn: Phaser.GameObjects.Container;
  private readonly deathSaveBtn: Phaser.GameObjects.Container;
  private readonly restBtn: Phaser.GameObjects.Container;
  private readonly actionButtons: Phaser.GameObjects.Container[];

  constructor(scene: Phaser.Scene, def: PlayerDef, callbacks: PlayerPanelCallbacks) {
    this.playerDef = def;
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const className = `${def.speciesName} · ${def.className} ${def.level}`;
    const statMod = (v: number) => Math.floor((v - 10) / 2);

    const track = <T extends Visible>(obj: T): T => { this.items.push(obj); return obj; };

    track(scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        scene.scale.height / 2,
        PLAYER_PANEL_WIDTH,
        scene.scale.height,
        0x080810,
      )
      .setDepth(10));
    track(scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH,
        scene.scale.height / 2,
        2,
        scene.scale.height,
        0x334455,
      )
      .setDepth(10));

    track(scene.add
      .text(12, 14, def.name, {
        fontSize: "12px",
        color: colorHex,
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11));
    track(scene.add
      .text(12, 32, className, {
        fontSize: "10px",
        color: "#667788",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11));
    track(scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        50,
        PLAYER_PANEL_WIDTH - 16,
        1,
        0x334455,
      )
      .setDepth(11));

    track(scene.add
      .text(12, 56, "HP", {
        fontSize: "10px",
        color: "#889aaa",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11));
    this.hpBar = track(scene.add.graphics().setDepth(11));
    this.hpText = track(scene.add
      .text(12, 92, "", {
        fontSize: "10px",
        color: "#cccccc",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11));
    track(scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        110,
        PLAYER_PANEL_WIDTH - 16,
        1,
        0x334455,
      )
      .setDepth(11));

    this.combatStatsText = track(scene.add
      .text(
        12,
        116,
        this.buildCombatStatsLines(statMod(def.dex)),
        {
          fontSize: "10px",
          color: "#aabbcc",
          fontFamily: "monospace",
          resolution: DPR,
          lineSpacing: 6,
        },
      )
      .setDepth(11));
    track(scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        192,
        PLAYER_PANEL_WIDTH - 16,
        1,
        0x334455,
      )
      .setDepth(11));

    const abilities: [string, number][] = [
      ["STR", def.str],
      ["DEX", def.dex],
      ["CON", def.con],
      ["INT", def.int],
      ["WIS", def.wis],
      ["CHA", def.cha],
    ];
    track(scene.add
      .text(
        12,
        198,
        abilities
          .map(([name, val]) => {
            const m = statMod(val);
            return `${name}  ${String(val).padStart(2)}  (${m >= 0 ? "+" : ""}${m})`;
          })
          .join("\n"),
        {
          fontSize: "10px",
          color: "#99aabb",
          fontFamily: "monospace",
          resolution: DPR,
          lineSpacing: 6,
        },
      )
      .setDepth(11));
    track(scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        312,
        PLAYER_PANEL_WIDTH - 16,
        1,
        0x334455,
      )
      .setDepth(11));

    this.xpText = track(scene.add
      .text(12, 318, "", {
        fontSize: "10px",
        color: "#aabbcc",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11));

    track(scene.add
      .rectangle(PLAYER_PANEL_WIDTH / 2, 336, PLAYER_PANEL_WIDTH - 16, 1, 0x334455)
      .setDepth(11));
    track(scene.add
      .text(12, 342, "QUESTS", {
        fontSize: "10px",
        color: "#889aaa",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11));
    this.questsText = track(scene.add
      .text(12, 358, "", {
        fontSize: "10px",
        color: "#aabbcc",
        fontFamily: "monospace",
        resolution: DPR,
        lineSpacing: 6,
      })
      .setDepth(11));

    // ── Action buttons (context-sensitive; managed by refreshActions) ──────────
    track(scene.add.rectangle(PLAYER_PANEL_WIDTH / 2, 448, PLAYER_PANEL_WIDTH - 16, 1, 0x334455).setDepth(11));

    const btnW = PLAYER_PANEL_WIDTH - 24;
    const btnX = PLAYER_PANEL_WIDTH / 2;
    this.attackBtn    = makeButton(scene, btnX, 462, "ATTACK",         0x1a4a1e, callbacks.onAttack,     btnW, 28, "11px");
    this.dashBtn      = makeButton(scene, btnX, 496, "DASH",            0x1a3a4a, callbacks.onDash,       btnW, 28, "11px");
    this.dodgeBtn     = makeButton(scene, btnX, 530, "DODGE",           0x1a3a4a, callbacks.onDodge,      btnW, 28, "11px");
    this.disengageBtn = makeButton(scene, btnX, 564, "DISENGAGE",       0x1a3a4a, callbacks.onDisengage,  btnW, 28, "11px");
    this.secondWindBtn= makeButton(scene, btnX, 598, "SECOND WIND",     0x1a3a5a, callbacks.onSecondWind, btnW, 28, "11px");
    this.hideBtn      = makeButton(scene, btnX, 598, "HIDE",            0x1a3a1a, callbacks.onHide,       btnW, 28, "11px");
    this.endTurnBtn   = makeButton(scene, btnX, 632, "END TURN",        0x3a3020, callbacks.onEndTurn,    btnW, 28, "11px");
    this.deathSaveBtn = makeButton(scene, btnX, 632, "ROLL DEATH SAVE", 0x5a1a1a, callbacks.onDeathSave, btnW, 28, "11px");
    this.restBtn      = makeButton(scene, btnX, 462, "SHORT REST",      0x1a2a3a, callbacks.onShortRest,  btnW, 28, "11px");
    this.actionButtons = [
      this.attackBtn, this.dashBtn, this.dodgeBtn, this.disengageBtn,
      this.secondWindBtn, this.hideBtn, this.endTurnBtn, this.deathSaveBtn, this.restBtn,
    ];
    this.actionButtons.forEach(btn => btn.setVisible(false));

    track(scene.add
      .rectangle(PLAYER_PANEL_WIDTH / 2, GRID_H - 88, PLAYER_PANEL_WIDTH - 16, 1, 0x334455)
      .setDepth(11));
    track(makeButton(scene, PLAYER_PANEL_WIDTH / 2, GRID_H - 60, "INVENTORY", 0x0a1a2a, callbacks.onOpenInventory, PLAYER_PANEL_WIDTH - 24, 28, "11px"));
    this.searchBtn = makeButton(scene, PLAYER_PANEL_WIDTH / 2, GRID_H - 24, "SEARCH", 0x1a2a3a, callbacks.onSearch, PLAYER_PANEL_WIDTH - 24, 28, "11px");

    this.hide();
  }

  private visible = false;
  private searchEnabled = false;

  show(): void {
    this.visible = true;
    this.items.forEach(item => item.setVisible(true));
    this.searchBtn.setVisible(this.searchEnabled);
  }
  hide(): void {
    this.visible = false;
    this.items.forEach(item => item.setVisible(false));
    this.searchBtn.setVisible(false);
    this.actionButtons.forEach(btn => btn.setVisible(false));
  }
  toggle(): void { this.visible ? this.hide() : this.show(); }

  refreshActions(state: PlayerPanelActionState): void {
    this.actionButtons.forEach(btn => btn.setVisible(false));
    if (!this.visible) return;

    const { mode, actionUsed, bonusActionUsed, playerDef, playerHp, secondWindUses } = state;

    if (mode === 'exploring') {
      if (state.playerHp < state.playerDef.maxHp && state.hitDiceRemaining > 0) {
        this.restBtn.setVisible(true);
      }
    } else if (mode === 'player_turn') {
      this.endTurnBtn.setVisible(true);
      if (!actionUsed) {
        const hasAdjacent = state.enemies.some(
          (e) => !e.dead && chebyshev(state.playerTileX, state.playerTileY, e.tileX, e.tileY) <= 1,
        );
        const hasAnyLiving = state.enemies.some((e) => !e.dead);
        if (hasAdjacent) this.attackBtn.setVisible(true);
        this.dashBtn.setVisible(true);
        this.dodgeBtn.setVisible(true);
        if (hasAdjacent || hasAnyLiving) this.disengageBtn.setVisible(true);
      }
      if (!bonusActionUsed) {
        if (playerDef.secondWindMaxUses > 0 && secondWindUses > 0 && playerHp < playerDef.maxHp)
          this.secondWindBtn.setVisible(true);
        if (playerDef.sneakAttackDice > 0 && !state.playerHidden && state.enemies.some((e) => !e.dead))
          this.hideBtn.setVisible(true);
      }
    } else if (mode === 'death_saves') {
      this.deathSaveBtn.setVisible(true);
    }
  }

  setSearchEnabled(enabled: boolean): void {
    this.searchEnabled = enabled;
    this.searchBtn.setVisible(this.visible && enabled);
  }


  private buildCombatStatsLines(initBonus: number): string {
    const sign = initBonus >= 0 ? "+" : "";
    return [
      `AC     ${this.playerDef.ac}`,
      `Speed  ${this.playerDef.speedFt} ft`,
      `Prof   +${this.playerDef.proficiencyBonus}`,
      `Init   ${sign}${initBonus}`,
    ].join("\n");
  }

  refresh(hp: number, maxHp: number, xp: number, quests: QuestDisplay[] = [], showSearch = false): void {
    this.setSearchEnabled(showSearch);
    this.combatStatsText.setText(this.buildCombatStatsLines(Math.floor((this.playerDef.dex - 10) / 2)));
    const pct = maxHp > 0 ? hp / maxHp : 0;
    const width = PLAYER_PANEL_WIDTH - 24;
    this.hpBar.clear();
    this.hpBar.fillStyle(0x222233);
    this.hpBar.fillRect(12, 68, width, 11);
    const color = pct > 0.5 ? 0x27ae60 : pct > 0.25 ? 0xf39c12 : 0xe74c3c;
    this.hpBar.fillStyle(color);
    this.hpBar.fillRect(12, 68, Math.floor(width * pct), 11);
    this.hpText.setText(`${hp} / ${maxHp}`);
    this.xpText.setText(`XP  ${xp}`);

    if (quests.length === 0) {
      this.questsText.setText("None");
    } else {
      this.questsText.setText(
        quests.map(q =>
          q.completed
            ? `✓ ${q.title}`
            : `· ${q.title}  ${q.progress}/${q.target}`
        ).join("\n")
      );
    }
  }
}
