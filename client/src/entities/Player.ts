import Phaser from 'phaser';
import { TILE_SIZE, PANEL_WIDTH } from '../constants';

const MOVE_DURATION = 150;

export class Player {
  private sprite: Phaser.GameObjects.Rectangle;
  private scene: Phaser.Scene;
  tileX: number;
  tileY: number;
  private moving = false;

  constructor(scene: Phaser.Scene, tileX: number, tileY: number, color = 0x4fc3f7) {
    this.scene = scene;
    this.tileX = tileX;
    this.tileY = tileY;
    this.sprite = scene.add.rectangle(
      PANEL_WIDTH + tileX * TILE_SIZE + TILE_SIZE / 2,
      tileY * TILE_SIZE + TILE_SIZE / 2,
      TILE_SIZE - 6,
      TILE_SIZE - 6,
      color
    );
    this.sprite.setDepth(1);
  }

  move(dx: number, dy: number, cols: number, rows: number): void {
    if (this.moving) return;

    const nx = this.tileX + dx;
    const ny = this.tileY + dy;

    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return;

    this.tileX = nx;
    this.tileY = ny;
    this.moving = true;

    this.scene.tweens.add({
      targets: this.sprite,
      x: PANEL_WIDTH + nx * TILE_SIZE + TILE_SIZE / 2,
      y: ny * TILE_SIZE + TILE_SIZE / 2,
      duration: MOVE_DURATION,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        this.moving = false;
      },
    });
  }
}
