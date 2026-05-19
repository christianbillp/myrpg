import Phaser from "phaser";
import {
  PLAYER_PANEL_WIDTH,
  TILE_SIZE,
  GRID_COLS,
  TARGET_PANEL_WIDTH,
} from "../constants";
import { EnemyDef } from "../data/enemies";

const DPR = window.devicePixelRatio;
const PX = PLAYER_PANEL_WIDTH + GRID_COLS * TILE_SIZE;

type Visible = { setVisible(v: boolean): unknown };

export class TargetPanel {
  private items: Visible[] = [];
  private hpBar: Phaser.GameObjects.Graphics;
  private hpText: Phaser.GameObjects.Text;
  private nameText: Phaser.GameObjects.Text;
  private typeText: Phaser.GameObjects.Text;
  private statsText: Phaser.GameObjects.Text;
  private abilitiesText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene) {
    const track = <T extends Visible>(obj: T): T => {
      this.items.push(obj);
      return obj;
    };

    track(
      scene.add
        .rectangle(
          PX + TARGET_PANEL_WIDTH / 2,
          scene.scale.height / 2,
          TARGET_PANEL_WIDTH,
          scene.scale.height,
          0x080810,
        )
        .setDepth(10),
    );
    track(
      scene.add
        .rectangle(PX, scene.scale.height / 2, 2, scene.scale.height, 0x334455)
        .setDepth(10),
    );

    this.nameText = track(
      scene.add
        .text(PX + 12, 14, "", {
          fontSize: "12px",
          color: "#ffffff",
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setDepth(11),
    );
    this.typeText = track(
      scene.add
        .text(PX + 12, 32, "", {
          fontSize: "10px",
          color: "#667788",
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setDepth(11),
    );
    track(
      scene.add
        .rectangle(
          PX + TARGET_PANEL_WIDTH / 2,
          50,
          TARGET_PANEL_WIDTH - 16,
          1,
          0x334455,
        )
        .setDepth(11),
    );

    track(
      scene.add
        .text(PX + 12, 56, "HP", {
          fontSize: "10px",
          color: "#889aaa",
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setDepth(11),
    );
    this.hpBar = track(scene.add.graphics().setDepth(11));
    this.hpText = track(
      scene.add
        .text(PX + 12, 92, "", {
          fontSize: "10px",
          color: "#cccccc",
          fontFamily: "monospace",
          resolution: DPR,
        })
        .setDepth(11),
    );
    track(
      scene.add
        .rectangle(
          PX + TARGET_PANEL_WIDTH / 2,
          110,
          TARGET_PANEL_WIDTH - 16,
          1,
          0x334455,
        )
        .setDepth(11),
    );

    this.statsText = track(
      scene.add
        .text(PX + 12, 116, "", {
          fontSize: "10px",
          color: "#aabbcc",
          fontFamily: "monospace",
          resolution: DPR,
          lineSpacing: 6,
        })
        .setDepth(11),
    );
    track(
      scene.add
        .rectangle(
          PX + TARGET_PANEL_WIDTH / 2,
          192,
          TARGET_PANEL_WIDTH - 16,
          1,
          0x334455,
        )
        .setDepth(11),
    );

    this.abilitiesText = track(
      scene.add
        .text(PX + 12, 198, "", {
          fontSize: "10px",
          color: "#99aabb",
          fontFamily: "monospace",
          resolution: DPR,
          lineSpacing: 6,
        })
        .setDepth(11),
    );

    this.hide();
  }

  show(def: EnemyDef, hp: number): void {
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    this.nameText.setText(def.name).setColor(colorHex);
    this.typeText.setText(`CR ${def.cr}`);

    this.statsText.setText(
      [`AC     ${def.ac}`, `Speed  ${def.speedFt} ft`].join("\n"),
    );

    const statMod = (v: number) => Math.floor((v - 10) / 2);
    const abilities: [string, number][] = [
      ["STR", def.str],
      ["DEX", def.dex],
      ["CON", def.con],
      ["INT", def.int],
      ["WIS", def.wis],
      ["CHA", def.cha],
    ];
    this.abilitiesText.setText(
      abilities
        .map(([name, val]) => {
          const m = statMod(val);
          return `${name}  ${String(val).padStart(2)}  (${m >= 0 ? "+" : ""}${m})`;
        })
        .join("\n"),
    );

    this.refresh(hp, def.maxHp);
    this.items.forEach((item) => item.setVisible(true));
  }

  hide(): void {
    this.items.forEach((item) => item.setVisible(false));
  }

  refresh(hp: number, maxHp: number): void {
    const pct = maxHp > 0 ? hp / maxHp : 0;
    const width = TARGET_PANEL_WIDTH - 24;
    this.hpBar.clear();
    this.hpBar.fillStyle(0x222233);
    this.hpBar.fillRect(PX + 12, 68, width, 11);
    const color = pct > 0.5 ? 0x27ae60 : pct > 0.25 ? 0xf39c12 : 0xe74c3c;
    this.hpBar.fillStyle(color);
    this.hpBar.fillRect(PX + 12, 68, Math.floor(width * pct), 11);
    this.hpText.setText(`${hp} / ${maxHp}`);
  }
}
