import Phaser from 'phaser';
import { TILE_SIZE } from '../constants';
import { EnemyDef } from '../data/enemies';

const MOVE_DURATION = 130;
const DPR = window.devicePixelRatio;

export class Enemy {
  tileX: number;
  tileY: number;
  hp: number;
  label = "";
  readonly maxHp: number;
  readonly def: EnemyDef;
  private container: Phaser.GameObjects.Container;
  private hpBar: Phaser.GameObjects.Graphics;
  private selectionRing: Phaser.GameObjects.Graphics;
  private labelText: Phaser.GameObjects.Text;
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
    this.selectionRing = scene.add.graphics();
    this.labelText = scene.add
      .text(0, -4, "", {
        fontSize: "13px",
        color: "#ffffff",
        fontFamily: "monospace",
        resolution: DPR,
      })
      .setOrigin(0.5);
    this.container = scene.add
      .container(tileX * TILE_SIZE + TILE_SIZE / 2, tileY * TILE_SIZE + TILE_SIZE / 2, [
        this.selectionRing,
        body,
        this.hpBar,
        this.labelText,
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
      x: tx * TILE_SIZE + TILE_SIZE / 2,
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

  setLabel(label: string): void {
    this.label = label;
    this.labelText.setText(label);
  }

  setSelected(selected: boolean): void {
    this.selectionRing.clear();
    if (selected) {
      const half = (TILE_SIZE - 8) / 2 + 3;
      this.selectionRing.lineStyle(2, this.def.color, 1);
      this.selectionRing.strokeRect(-half, -half, half * 2, half * 2);
    }
  }

  get gameObject(): Phaser.GameObjects.Container { return this.container; }

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
