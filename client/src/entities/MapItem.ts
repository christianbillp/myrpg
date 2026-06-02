import Phaser from 'phaser';
import { TILE_SIZE } from '../constants';
import { ItemDef } from '../../../shared/types';

export class MapItem {
  readonly def: ItemDef;
  readonly tileX: number;
  readonly tileY: number;
  private container: Phaser.GameObjects.Container;

  constructor(scene: Phaser.Scene, def: ItemDef, tileX: number, tileY: number) {
    this.def = def;
    this.tileX = tileX;
    this.tileY = tileY;

    const gem = scene.add.rectangle(0, 0, 12, 12, 0x2ecc71).setAngle(45);
    this.container = scene.add
      .container(tileX * TILE_SIZE + TILE_SIZE / 2, tileY * TILE_SIZE + TILE_SIZE / 2, [gem]);
  }

  get gameObject(): Phaser.GameObjects.Container { return this.container; }

  destroy(): void {
    this.container.destroy();
  }
}
