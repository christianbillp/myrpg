/**
 * MonsterPicker — scrollable list of monster defs with `+ ALLY` / `+ ENEMY`
 * buttons on each row, plus an ally/enemy summary block and a CLEAR button.
 * Used by the Deterministic tab of `GenerateSetupScene` to populate an
 * encounter's `allyIds` and `enemyIds` from the live monsters registry.
 *
 * The component creates its own Phaser objects against the parent
 * `container` and exposes the chosen ids via `getAllyIds()` / `getEnemyIds()`.
 * `destroy()` detaches its scene-level wheel listener so successive
 * instantiations don't stack handlers.
 */
import Phaser from "phaser";
import type { MonsterDef } from "../../data/monsters";

const DPR = window.devicePixelRatio;
const ROW_H = 22;
const LIST_H = 130;

export interface MonsterPickerOptions {
  scene: Phaser.Scene;
  parent: Phaser.GameObjects.Container;
  monsters: MonsterDef[];
  x: number;
  y: number;
  width: number;
  /** Optional initial selections, used by the RANDOMIZE flow to seed rolled monsters into the picker. */
  initialAllyIds?: string[];
  initialEnemyIds?: string[];
  initialNeutralIds?: string[];
}

export class MonsterPicker {
  private readonly scene: Phaser.Scene;
  private readonly monsters: MonsterDef[];
  private readonly allySelections = new Map<string, number>();
  private readonly neutralSelections = new Map<string, number>();
  private readonly enemySelections = new Map<string, number>();
  private readonly allyListText: Phaser.GameObjects.Text;
  private readonly neutralListText: Phaser.GameObjects.Text;
  private readonly enemyListText: Phaser.GameObjects.Text;
  private readonly wheelHandler: (
    pointer: Phaser.Input.Pointer,
    objs: unknown,
    dx: number,
    dy: number,
  ) => void;
  private scrollOffset = 0;

  constructor(opts: MonsterPickerOptions) {
    this.scene = opts.scene;
    this.monsters = opts.monsters;

    // Seed selections from any rolled / preset ids before the summary lines render.
    for (const id of opts.initialAllyIds    ?? []) this.allySelections.set(id, (this.allySelections.get(id) ?? 0) + 1);
    for (const id of opts.initialEnemyIds   ?? []) this.enemySelections.set(id, (this.enemySelections.get(id) ?? 0) + 1);
    for (const id of opts.initialNeutralIds ?? []) this.neutralSelections.set(id, (this.neutralSelections.get(id) ?? 0) + 1);

    const { scene, parent, monsters, x, y, width } = opts;
    const listY = y + 20;

    parent.add(scene.add.text(x, y, "MONSTERS — click +ALLY or +ENEMY to add to the encounter", {
      fontSize: "10px", color: "#778899", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0, 0));

    // Backing rectangle.
    parent.add(scene.add.rectangle(x + width / 2, listY + LIST_H / 2, width, LIST_H, 0x0a0e16).setStrokeStyle(1, 0x334455));

    // Scroll container clipped to the list rect.
    const scroll = scene.add.container(x, listY);
    parent.add(scroll);
    const mask = scene.make.graphics({ x: 0, y: 0 }, false);
    mask.fillStyle(0xffffff);
    mask.fillRect(x, listY, width, LIST_H);
    scroll.setMask(mask.createGeometryMask());

    monsters.forEach((mon, i) => {
      const ry = i * ROW_H;
      const rowBg = scene.add.rectangle(width / 2, ry + ROW_H / 2, width - 4, ROW_H - 2, i % 2 === 0 ? 0x111122 : 0x141426);
      scroll.add(rowBg);
      const label = `${mon.name}  (${mon.type ?? "—"}, ${mon.maxHp} HP)`;
      scroll.add(scene.add.text(12, ry + ROW_H / 2, label, {
        fontSize: "11px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR,
      }).setOrigin(0, 0.5));

      const allyBg = scene.add.rectangle(width - 195, ry + ROW_H / 2, 60, 18, 0x1a3a55).setStrokeStyle(1, 0x4477aa).setInteractive({ useHandCursor: true });
      scroll.add(allyBg);
      scroll.add(scene.add.text(width - 195, ry + ROW_H / 2, "+ ALLY", {
        fontSize: "9px", color: "#cce4ff", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
      }).setOrigin(0.5));
      allyBg.on("pointerdown", () => this.addMonster(mon.id, "ally"));

      const neutralBg = scene.add.rectangle(width - 125, ry + ROW_H / 2, 70, 18, 0x3a3a1a).setStrokeStyle(1, 0x9a8a44).setInteractive({ useHandCursor: true });
      scroll.add(neutralBg);
      scroll.add(scene.add.text(width - 125, ry + ROW_H / 2, "+ NEUTRAL", {
        fontSize: "9px", color: "#ffe9a8", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
      }).setOrigin(0.5));
      neutralBg.on("pointerdown", () => this.addMonster(mon.id, "neutral"));

      const enemyBg = scene.add.rectangle(width - 50, ry + ROW_H / 2, 60, 18, 0x551a1a).setStrokeStyle(1, 0xaa4444).setInteractive({ useHandCursor: true });
      scroll.add(enemyBg);
      scroll.add(scene.add.text(width - 50, ry + ROW_H / 2, "+ ENEMY", {
        fontSize: "9px", color: "#ffcccc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
      }).setOrigin(0.5));
      enemyBg.on("pointerdown", () => this.addMonster(mon.id, "enemy"));
    });

    // Scene-level wheel listener, scoped to the list's screen bounds. No hit
    // rect is layered on top of the buttons (an earlier version of this code
    // did that and the rect stole every click).
    const totalContentH = monsters.length * ROW_H;
    const maxScroll = Math.max(0, totalContentH - LIST_H);
    this.wheelHandler = (pointer, _objs, _dx, dy) => {
      if (pointer.x < x || pointer.x > x + width || pointer.y < listY || pointer.y > listY + LIST_H) return;
      this.scrollOffset = Phaser.Math.Clamp(this.scrollOffset + dy * 0.5, 0, maxScroll);
      scroll.setY(listY - this.scrollOffset);
    };
    scene.input.on("wheel", this.wheelHandler);

    // Selected lists.
    const summaryY = listY + LIST_H + 12;
    this.allyListText = scene.add.text(x, summaryY, this.formatSelected(this.allySelections, "ALLIES"), {
      fontSize: "11px", color: "#cce4ff", fontFamily: "monospace", resolution: DPR,
      wordWrap: { width },
    }).setOrigin(0, 0);
    parent.add(this.allyListText);
    this.neutralListText = scene.add.text(x, summaryY + 16, this.formatSelected(this.neutralSelections, "NEUTRALS"), {
      fontSize: "11px", color: "#ffe9a8", fontFamily: "monospace", resolution: DPR,
      wordWrap: { width },
    }).setOrigin(0, 0);
    parent.add(this.neutralListText);
    this.enemyListText = scene.add.text(x, summaryY + 32, this.formatSelected(this.enemySelections, "ENEMIES"), {
      fontSize: "11px", color: "#ffcccc", fontFamily: "monospace", resolution: DPR,
      wordWrap: { width },
    }).setOrigin(0, 0);
    parent.add(this.enemyListText);

    // Clear-selections button.
    const clearBg = scene.add.rectangle(x + width - 80, summaryY + 16, 140, 22, 0x222233).setStrokeStyle(1, 0x556677).setInteractive({ useHandCursor: true });
    parent.add(clearBg);
    parent.add(scene.add.text(x + width - 80, summaryY + 16, "CLEAR MONSTERS", {
      fontSize: "9px", color: "#aabbcc", fontFamily: "monospace", resolution: DPR, letterSpacing: 1,
    }).setOrigin(0.5));
    clearBg.on("pointerdown", () => {
      this.allySelections.clear();
      this.neutralSelections.clear();
      this.enemySelections.clear();
      this.refreshSelectedLists();
    });
  }

  /** Flat id list — `["bandit","bandit"]` for two bandits as allies. */
  getAllyIds(): string[] {
    return this.expand(this.allySelections);
  }

  /** Flat id list — `["wolf","wolf","wolf"]` for three wolves as enemies. */
  getEnemyIds(): string[] {
    return this.expand(this.enemySelections);
  }

  /** Flat id list — creatures placed as neutral NPCs (don't fight unless flipped). */
  getNeutralIds(): string[] {
    return this.expand(this.neutralSelections);
  }

  destroy(): void {
    this.scene.input.off("wheel", this.wheelHandler);
  }

  private addMonster(id: string, side: "ally" | "neutral" | "enemy"): void {
    const target = side === "ally" ? this.allySelections
                 : side === "enemy" ? this.enemySelections
                 : this.neutralSelections;
    target.set(id, (target.get(id) ?? 0) + 1);
    this.refreshSelectedLists();
  }

  private refreshSelectedLists(): void {
    this.allyListText.setText(this.formatSelected(this.allySelections, "ALLIES"));
    this.neutralListText.setText(this.formatSelected(this.neutralSelections, "NEUTRALS"));
    this.enemyListText.setText(this.formatSelected(this.enemySelections, "ENEMIES"));
  }

  private formatSelected(sel: Map<string, number>, label: string): string {
    if (sel.size === 0) return `${label}: (none)`;
    const parts = Array.from(sel.entries()).map(([id, n]) => {
      const mon = this.monsters.find((m) => m.id === id);
      return `${mon?.name ?? id}${n > 1 ? ` ×${n}` : ""}`;
    });
    return `${label}: ${parts.join(", ")}`;
  }

  private expand(sel: Map<string, number>): string[] {
    const out: string[] = [];
    for (const [id, n] of sel) for (let i = 0; i < n; i++) out.push(id);
    return out;
  }
}
