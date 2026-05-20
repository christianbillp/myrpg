import Phaser from "phaser";
import { PLAYER_PANEL_WIDTH } from "../constants";
import { PlayerDef } from "../data/player";
import { ItemDef } from "../data/items";
import { QuestDisplay } from "../data/quests";

const DPR = window.devicePixelRatio;

export class PlayerPanel {
  private hpBar: Phaser.GameObjects.Graphics;
  private hpText: Phaser.GameObjects.Text;
  private xpText: Phaser.GameObjects.Text;
  private gpText: Phaser.GameObjects.Text;
  private inventoryText: Phaser.GameObjects.Text;
  private usePotionBg: Phaser.GameObjects.Rectangle;
  private questsText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, def: PlayerDef, onUsePotion: () => void) {
    const colorHex = "#" + def.color.toString(16).padStart(6, "0");
    const className = `${def.speciesName} · ${def.className} ${def.level}`;
    const statMod = (v: number) => Math.floor((v - 10) / 2);

    scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        scene.scale.height / 2,
        PLAYER_PANEL_WIDTH,
        scene.scale.height,
        0x080810,
      )
      .setDepth(10);
    scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH,
        scene.scale.height / 2,
        2,
        scene.scale.height,
        0x334455,
      )
      .setDepth(10);

    scene.add
      .text(12, 14, def.name, {
        fontSize: "12px",
        color: colorHex,
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);
    scene.add
      .text(12, 32, className, {
        fontSize: "10px",
        color: "#667788",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);
    scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        50,
        PLAYER_PANEL_WIDTH - 16,
        1,
        0x334455,
      )
      .setDepth(11);

    scene.add
      .text(12, 56, "HP", {
        fontSize: "10px",
        color: "#889aaa",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);
    this.hpBar = scene.add.graphics().setDepth(11);
    this.hpText = scene.add
      .text(12, 92, "", {
        fontSize: "10px",
        color: "#cccccc",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);
    scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        110,
        PLAYER_PANEL_WIDTH - 16,
        1,
        0x334455,
      )
      .setDepth(11);

    const initBonus = statMod(def.dex);
    scene.add
      .text(
        12,
        116,
        [
          `AC     ${def.ac}`,
          `Speed  ${def.speedFt} ft`,
          `Prof   +${def.proficiencyBonus}`,
          `Init   ${initBonus >= 0 ? "+" : ""}${initBonus}`,
        ].join("\n"),
        {
          fontSize: "10px",
          color: "#aabbcc",
          fontFamily: "monospace",
          resolution: DPR,
          lineSpacing: 6,
        },
      )
      .setDepth(11);
    scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        192,
        PLAYER_PANEL_WIDTH - 16,
        1,
        0x334455,
      )
      .setDepth(11);

    const abilities: [string, number][] = [
      ["STR", def.str],
      ["DEX", def.dex],
      ["CON", def.con],
      ["INT", def.int],
      ["WIS", def.wis],
      ["CHA", def.cha],
    ];
    scene.add
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
      .setDepth(11);
    scene.add
      .rectangle(
        PLAYER_PANEL_WIDTH / 2,
        312,
        PLAYER_PANEL_WIDTH - 16,
        1,
        0x334455,
      )
      .setDepth(11);

    this.xpText = scene.add
      .text(12, 318, "", {
        fontSize: "10px",
        color: "#aabbcc",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);
    this.gpText = scene.add
      .text(12, 332, "", {
        fontSize: "10px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);

    scene.add
      .rectangle(PLAYER_PANEL_WIDTH / 2, 352, PLAYER_PANEL_WIDTH - 16, 1, 0x334455)
      .setDepth(11);
    scene.add
      .text(12, 358, "INVENTORY", {
        fontSize: "10px",
        color: "#889aaa",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);
    this.inventoryText = scene.add
      .text(12, 374, "Empty", {
        fontSize: "10px",
        color: "#aabbcc",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);

    this.usePotionBg = scene.add
      .rectangle(PLAYER_PANEL_WIDTH / 2, 400, PLAYER_PANEL_WIDTH - 24, 22, 0x1a3a1a)
      .setStrokeStyle(1, 0x334455)
      .setDepth(11)
      .setAlpha(0.4);
    scene.add
      .text(PLAYER_PANEL_WIDTH / 2, 400, "USE POTION", {
        fontSize: "10px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5)
      .setDepth(12);
    this.usePotionBg.setInteractive({ useHandCursor: true });
    this.usePotionBg.on("pointerover", () => { if (this.usePotionBg.alpha > 0.5) this.usePotionBg.setAlpha(0.75); });
    this.usePotionBg.on("pointerout", () => { if (this.usePotionBg.alpha > 0.5) this.usePotionBg.setAlpha(1); });
    this.usePotionBg.on("pointerdown", onUsePotion);

    scene.add
      .rectangle(PLAYER_PANEL_WIDTH / 2, 422, PLAYER_PANEL_WIDTH - 16, 1, 0x334455)
      .setDepth(11);
    scene.add
      .text(12, 428, "QUESTS", {
        fontSize: "10px",
        color: "#889aaa",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setDepth(11);
    this.questsText = scene.add
      .text(12, 444, "", {
        fontSize: "10px",
        color: "#aabbcc",
        fontFamily: "monospace",
        resolution: DPR,
        lineSpacing: 6,
      })
      .setDepth(11);
  }

  refresh(hp: number, maxHp: number, xp: number, gold: number, inventory: ItemDef[], bonusActionUsed = false, quests: QuestDisplay[] = []): void {
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
    this.gpText.setText(`GP  ${gold}`);

    const potions = inventory.filter(i => i.type === "consumable").length;
    this.inventoryText.setText(potions > 0 ? `Health Potion  ×${potions}` : "Empty");
    this.usePotionBg.setAlpha(potions > 0 && !bonusActionUsed ? 1 : 0.4);

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
