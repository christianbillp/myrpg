import Phaser from 'phaser';
import { scaleDuration } from "../animationSpeed";
import { TILE_SIZE, DEFAULT_TOKEN_COLOR } from '../constants';

const MOVE_DURATION = 150;

export class Player {
  tileX: number;
  tileY: number;
  private container: Phaser.GameObjects.Container;
  private hpBar: Phaser.GameObjects.Graphics;
  private scene: Phaser.Scene;

  /**
   * @param tokenKey Phaser texture key (typically from `tokenTextureKey(playerDef.tokenAsset)`).
   *                 When the texture is missing the renderer falls back to a coloured circle
   *                 in `color`, so the scene still boots if a token asset failed to load.
   *                 Defaults to `DEFAULT_TOKEN_COLOR` — the shared player-blue.
   */
  constructor(scene: Phaser.Scene, tileX: number, tileY: number, tokenKey: string, color = DEFAULT_TOKEN_COLOR) {
    this.scene = scene;
    this.tileX = tileX;
    this.tileY = tileY;

    const diameter = TILE_SIZE - 6;
    const body: Phaser.GameObjects.GameObject = scene.textures.exists(tokenKey)
      ? scene.add.image(0, 0, tokenKey).setDisplaySize(diameter, diameter)
      : scene.add.circle(0, 0, diameter / 2, color);
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
      duration: scaleDuration(MOVE_DURATION),
      ease: 'Sine.easeInOut',
      onComplete,
    });
  }

  /** Fire-and-forget reconcile glide — see NpcToken.glideTo. */
  glideTo(tx: number, ty: number): void {
    const dist = Math.max(Math.abs(tx - this.tileX), Math.abs(ty - this.tileY));
    if (dist === 0) return;
    this.scene.tweens.killTweensOf(this.container);
    this.tileX = tx;
    this.tileY = ty;
    this.scene.tweens.add({
      targets: this.container,
      x: tx * TILE_SIZE + TILE_SIZE / 2,
      y: ty * TILE_SIZE + TILE_SIZE / 2,
      duration: scaleDuration(Math.min(420, dist * 90)),
      ease: 'Sine.easeInOut',
    });
  }

  teleport(tx: number, ty: number): void {
    this.scene.tweens.killTweensOf(this.container);
    this.tileX = tx;
    this.tileY = ty;
    this.container.setPosition(tx * TILE_SIZE + TILE_SIZE / 2, ty * TILE_SIZE + TILE_SIZE / 2);
  }

  /** Brief lunge toward (tx,ty) and back — the attack "swing" beat. */
  lungeToward(tx: number, ty: number, onComplete: () => void): void {
    const cx = this.tileX * TILE_SIZE + TILE_SIZE / 2;
    const cy = this.tileY * TILE_SIZE + TILE_SIZE / 2;
    const dx = tx - this.tileX;
    const dy = ty - this.tileY;
    const len = Math.hypot(dx, dy) || 1;
    this.scene.tweens.add({
      targets: this.container,
      x: cx + (dx / len) * TILE_SIZE * 0.35,
      y: cy + (dy / len) * TILE_SIZE * 0.35,
      duration: 90, yoyo: true, ease: 'Quad.easeOut',
      onComplete: () => { this.container.setPosition(cx, cy); onComplete(); },
    });
  }

  /** Drop the HP bar to `newHp` and pop the token — the damage-impact beat. */
  flashHit(newHp: number, maxHp: number, onComplete: () => void): void {
    this.setHp(newHp, maxHp);
    this.scene.tweens.add({
      targets: this.container, scaleX: 1.18, scaleY: 1.18,
      duration: 90, yoyo: true, ease: 'Quad.easeOut', onComplete,
    });
  }
}
