import Phaser from 'phaser';
import { TILE_SIZE } from '../constants';
import { ItemDef } from '../../../shared/types';

export class MapItem {
  readonly def: ItemDef;
  readonly tileX: number;
  readonly tileY: number;
  private container: Phaser.GameObjects.Container;
  private readonly scene: Phaser.Scene;
  private aura?: Phaser.GameObjects.Arc;

  constructor(scene: Phaser.Scene, def: ItemDef, tileX: number, tileY: number) {
    this.def = def;
    this.tileX = tileX;
    this.tileY = tileY;
    this.scene = scene;

    const gem = scene.add.rectangle(0, 0, 12, 12, 0x2ecc71).setAngle(45);
    this.container = scene.add
      .container(tileX * TILE_SIZE + TILE_SIZE / 2, tileY * TILE_SIZE + TILE_SIZE / 2, [gem]);
  }

  get gameObject(): Phaser.GameObjects.Container { return this.container; }

  /** Toggle a Detect-Magic aura — a soft violet glow behind the item — shown
   *  once the player has sensed this item as magical. */
  setMagicAura(on: boolean): void {
    if (on && !this.aura) {
      this.aura = this.scene.add.circle(0, 0, 13, 0xa87adf, 0.35);
      this.container.addAt(this.aura, 0);
    } else if (!on && this.aura) {
      this.aura.destroy();
      this.aura = undefined;
    }
  }

  destroy(): void {
    this.container.destroy();
  }
}
