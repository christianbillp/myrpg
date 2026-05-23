import Phaser from 'phaser';
import { TILE_SIZE } from '../constants';
import { MonsterDef } from '../data/monsters';
import { Disposition } from '../net/types';

const MOVE_DURATION = 130;
const DPR = window.devicePixelRatio;

export class NpcToken {
  tileX: number;
  tileY: number;
  hp: number;
  label = "";
  readonly maxHp: number;
  readonly id: string;
  readonly def: MonsterDef;
  disposition: Disposition;
  private container: Phaser.GameObjects.Container;
  private hpBar: Phaser.GameObjects.Graphics;
  private selectionRing: Phaser.GameObjects.Graphics;
  private labelText: Phaser.GameObjects.Text;
  private scene: Phaser.Scene;
  private moving = false;

  constructor(
    scene: Phaser.Scene,
    id: string,
    def: MonsterDef,
    tileX: number,
    tileY: number,
    disposition: Disposition,
    hp: number,
    maxHp: number,
  ) {
    this.scene = scene;
    this.id = id;
    this.def = def;
    this.tileX = tileX;
    this.tileY = tileY;
    this.disposition = disposition;
    this.hp = hp;
    this.maxHp = maxHp;

    const radius = (TILE_SIZE - 8) / 2;
    this.selectionRing = scene.add.graphics();
    const body = scene.add.circle(0, 0, radius, def.color);
    this.hpBar = scene.add.graphics();

    const labelY = -(radius + 3);
    if (disposition === 'neutral') {
      this.labelText = scene.add
        .text(0, labelY, def.name, {
          fontSize: '10px',
          color: '#' + def.color.toString(16).padStart(6, '0'),
          fontFamily: 'monospace',
          resolution: DPR,
        })
        .setOrigin(0.5, 1);
    } else {
      this.labelText = scene.add
        .text(0, labelY, '', { fontSize: '10px', color: '#ffffff', fontFamily: 'monospace', resolution: DPR })
        .setOrigin(0.5, 1);
    }

    this.container = scene.add
      .container(tileX * TILE_SIZE + TILE_SIZE / 2, tileY * TILE_SIZE + TILE_SIZE / 2, [
        this.selectionRing, body, this.hpBar, this.labelText,
      ])
      .setDepth(1);

    this.refreshHpBar();
  }

  moveTo(tx: number, ty: number, onComplete: () => void): void {
    if (this.moving) { onComplete(); return; }
    this.tileX = tx;
    this.tileY = ty;
    this.moving = true;
    this.scene.tweens.add({
      targets: this.container,
      x: tx * TILE_SIZE + TILE_SIZE / 2,
      y: ty * TILE_SIZE + TILE_SIZE / 2,
      duration: MOVE_DURATION,
      ease: 'Sine.easeInOut',
      onComplete: () => { this.moving = false; onComplete(); },
    });
  }

  teleport(tx: number, ty: number): void {
    this.tileX = tx;
    this.tileY = ty;
    this.container.setPosition(tx * TILE_SIZE + TILE_SIZE / 2, ty * TILE_SIZE + TILE_SIZE / 2);
  }

  setHp(hp: number): void {
    this.hp = Math.max(0, Math.min(this.maxHp, hp));
    this.refreshHpBar();
  }

  setLabel(label: string): void {
    this.label = label;
  }

  setLabelVisible(visible: boolean): void {
    if (this.disposition === 'neutral') {
      this.labelText.setText(this.def.name);
    } else {
      this.labelText.setText(visible ? this.label : '');
    }
  }

  setSelected(selected: boolean): void {
    this.selectionRing.clear();
    if (selected) {
      this.selectionRing.lineStyle(2, this.def.color, 1);
      this.selectionRing.strokeCircle(0, 0, (TILE_SIZE - 8) / 2 + 3);
    }
  }

  isDead(): boolean { return this.hp <= 0; }
  get gameObject(): Phaser.GameObjects.Container { return this.container; }

  destroy(): void { this.container.destroy(); }

  private refreshHpBar(): void {
    this.hpBar.clear();
    if (this.hp >= this.maxHp) return;
    const pct = this.hp / this.maxHp;
    const radius = (TILE_SIZE - 8) / 2;
    const barW = TILE_SIZE - 10;
    const barX = -(barW / 2);
    const barY = -radius;
    this.hpBar.fillStyle(0x222233);
    this.hpBar.fillRect(barX, barY, barW, 4);
    const barColor = this.disposition === 'ally' ? 0x27ae60 : this.disposition === 'enemy' ? 0xe74c3c : 0x6688aa;
    this.hpBar.fillStyle(barColor);
    this.hpBar.fillRect(barX, barY, Math.floor(barW * pct), 4);
  }
}
