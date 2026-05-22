import Phaser from "phaser";
import { PLAYER_PANEL_WIDTH, GRID_ROWS, TILE_SIZE } from "../constants";
import { makeButton } from "./UIButton";
import { PlayerDef } from "../data/player";

export interface QuestDisplay {
  title: string;
  progress: number;
  target: number;
  completed: boolean;
}

const DPR = window.devicePixelRatio;
const GRID_H = GRID_ROWS * TILE_SIZE;

type Visible = { setVisible(v: boolean): unknown };

export interface PlayerPanelCallbacks {
  onOpenInventory: () => void;
  onSearch: () => void;
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
  }
  toggle(): void { this.visible ? this.hide() : this.show(); }

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
