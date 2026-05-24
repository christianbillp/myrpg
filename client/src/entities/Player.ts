import Phaser from 'phaser';
import { TILE_SIZE } from '../constants';

const MOVE_DURATION = 150;

export class Player {
  tileX: number;
  tileY: number;
  private container: Phaser.GameObjects.Container;
  private hpBar: Phaser.GameObjects.Graphics;
  private scene: Phaser.Scene;

  constructor(scene: Phaser.Scene, tileX: number, tileY: number, color = 0x4fc3f7) {
    this.scene = scene;
    this.tileX = tileX;
    this.tileY = tileY;

    const body = scene.add.circle(0, 0, (TILE_SIZE - 6) / 2, color);
    this.hpBar = scene.add.graphics();

    this.container = scene.add
      .container(tileX * TILE_SIZE + TILE_SIZE / 2, tileY * TILE_SIZE + TILE_SIZE / 2, [body, this.hpBar])
      .setDepth(1);
  }

  get gameObject(): Phaser.GameObjects.Container { return this.container; }

  setHp(hp: number, maxHp: number): void {
    this.hpBar.clear();
    if (hp >= maxHp || maxHp <= 0) return;
    const pct = hp / maxHp;
    const radius = (TILE_SIZE - 6) / 2;
    const barW = TILE_SIZE - 10;
    const barX = -(barW / 2);
    const barY = -radius;
    const color = pct > 0.5 ? 0x27ae60 : pct > 0.25 ? 0xf39c12 : 0xe74c3c;
    this.hpBar.fillStyle(0x222233);
    this.hpBar.fillRect(barX, barY, barW, 4);
    this.hpBar.fillStyle(color);
    this.hpBar.fillRect(barX, barY, Math.floor(barW * pct), 4);
  }

  moveTo(tx: number, ty: number, onComplete: () => void): void {
    this.scene.tweens.killTweensOf(this.container);
    this.tileX = tx;
    this.tileY = ty;
    this.scene.tweens.add({
      targets: this.container,
      x: tx * TILE_SIZE + TILE_SIZE / 2,
      y: ty * TILE_SIZE + TILE_SIZE / 2,
      duration: MOVE_DURATION,
      ease: 'Sine.easeInOut',
      onComplete,
    });
  }

  teleport(tx: number, ty: number): void {
    this.scene.tweens.killTweensOf(this.container);
    this.tileX = tx;
    this.tileY = ty;
    this.container.setPosition(tx * TILE_SIZE + TILE_SIZE / 2, ty * TILE_SIZE + TILE_SIZE / 2);
  }
}
