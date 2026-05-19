import Phaser from 'phaser';
import { TILE_SIZE, PANEL_WIDTH } from '../constants';
import { EnemyDef } from '../data/enemies';

const MOVE_DURATION = 130;

export class Enemy {
  tileX: number;
  tileY: number;
  hp: number;
  readonly maxHp: number;
  readonly def: EnemyDef;
  private container: Phaser.GameObjects.Container;
  private hpBar: Phaser.GameObjects.Graphics;
  private scene: Phaser.Scene;
  private moving = false;

  constructor(scene: Phaser.Scene, def: EnemyDef, tileX: number, tileY: number) {
    this.scene = scene;
    this.def = def;
    this.tileX = tileX;
    this.tileY = tileY;
    this.hp = def.maxHp;
    this.maxHp = def.maxHp;

    const body = scene.add.rectangle(0, 0, TILE_SIZE - 8, TILE_SIZE - 8, def.color);
    this.hpBar = scene.add.graphics();
    this.container = scene.add
      .container(PANEL_WIDTH + tileX * TILE_SIZE + TILE_SIZE / 2, tileY * TILE_SIZE + TILE_SIZE / 2, [
        body,
        this.hpBar,
      ])
      .setDepth(1);

    this.refreshHpBar();
  }

  moveTo(tx: number, ty: number, onComplete: () => void): void {
    if (this.moving) {
      onComplete();
      return;
    }
    this.tileX = tx;
    this.tileY = ty;
    this.moving = true;

    this.scene.tweens.add({
      targets: this.container,
      x: PANEL_WIDTH + tx * TILE_SIZE + TILE_SIZE / 2,
      y: ty * TILE_SIZE + TILE_SIZE / 2,
      duration: MOVE_DURATION,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        this.moving = false;
        onComplete();
      },
    });
  }

  takeDamage(amount: number): void {
    this.hp = Math.max(0, this.hp - amount);
    this.refreshHpBar();
  }

  isDead(): boolean {
    return this.hp <= 0;
  }

  destroy(): void {
    this.container.destroy();
  }

  private refreshHpBar(): void {
    this.hpBar.clear();
    const pct = this.hp / this.maxHp;
    const barW = TILE_SIZE - 10;
    const barX = -(barW / 2);
    const barY = TILE_SIZE / 2 - 7;
    this.hpBar.fillStyle(0x222233);
    this.hpBar.fillRect(barX, barY, barW, 4);
    this.hpBar.fillStyle(0xe74c3c);
    this.hpBar.fillRect(barX, barY, Math.floor(barW * pct), 4);
  }
}
