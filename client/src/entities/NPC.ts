import Phaser from "phaser";
import { MonsterDef } from "../data/monsters";
import { TILE_SIZE } from "../constants";

const DPR = window.devicePixelRatio;

export class NPC {
  readonly def: MonsterDef;
  private _tileX: number;
  private _tileY: number;
  private container: Phaser.GameObjects.Container;
  private body: Phaser.GameObjects.Rectangle;
  private hint: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, def: MonsterDef, tileX: number, tileY: number) {
    this.def = def;
    this._tileX = tileX;
    this._tileY = tileY;

    const cx = tileX * TILE_SIZE + TILE_SIZE / 2;
    const cy = tileY * TILE_SIZE + TILE_SIZE / 2;

    this.body = scene.add.rectangle(0, 0, TILE_SIZE - 10, TILE_SIZE - 10, def.color);

    const nameLabel = scene.add
      .text(0, -(TILE_SIZE / 2 + 4), def.name, {
        fontSize: "9px",
        color: "#" + def.color.toString(16).padStart(6, "0"),
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 1);

    this.hint = scene.add
      .text(0, -(TILE_SIZE / 2 + 14), "!", {
        fontSize: "11px",
        color: "#e2b96f",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5, 1);

    this.container = scene.add.container(cx, cy, [this.body, nameLabel, this.hint]);
  }

  get tileX(): number { return this._tileX; }
  get tileY(): number { return this._tileY; }
  get gameObject(): Phaser.GameObjects.Container { return this.container; }

  setInteractionHint(visible: boolean): void {
    this.hint.setVisible(visible);
  }

  setSelected(selected: boolean): void {
    this.body.setStrokeStyle(selected ? 2 : 0, this.def.color);
  }

  destroy(): void {
    this.container.destroy();
  }
}
