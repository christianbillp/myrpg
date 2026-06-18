import Phaser from 'phaser';
import { scaleDuration } from "../animationSpeed";
import { TIMING } from "../animationTimings";
import { TILE_SIZE, DEFAULT_TOKEN_COLOR_HEX } from '../constants';
import { MonsterDef } from '../../../shared/types';
import { Disposition } from '../../../shared/types';

const MOVE_DURATION = TIMING.moveNpcMs;
const DPR = window.devicePixelRatio;

export class NpcToken {
  tileX: number;
  tileY: number;
  hp: number;
  combatLabel = "";
  readonly maxHp: number;
  readonly id: string;
  readonly def: MonsterDef;
  disposition: Disposition;
  private container: Phaser.GameObjects.Container;
  private hpBar: Phaser.GameObjects.Graphics;
  private selectionRing: Phaser.GameObjects.Graphics;
  private nameText: Phaser.GameObjects.Text;
  private labelText: Phaser.GameObjects.Text;
  private scene: Phaser.Scene;
  private moving = false;

  /**
   * @param tokenKey Phaser texture key for this creature's SVG token. NPCs may
   *                 override their monster's token via `NPCDef.tokenAsset`; the
   *                 caller is responsible for resolving the fallback chain
   *                 (npc.tokenAsset → monster.tokenAsset) before passing it.
   *                 If the texture isn't loaded, falls back to a `def.color`
   *                 circle so the scene still renders.
   */
  constructor(
    scene: Phaser.Scene,
    id: string,
    def: MonsterDef,
    tileX: number,
    tileY: number,
    disposition: Disposition,
    hp: number,
    maxHp: number,
    tokenKey: string,
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
    const diameter = radius * 2;
    const nameY = -(radius + 3);

    this.selectionRing = scene.add.graphics();
    const body: Phaser.GameObjects.GameObject = scene.textures.exists(tokenKey)
      ? scene.add.image(0, 0, tokenKey).setDisplaySize(diameter, diameter)
      : scene.add.circle(0, 0, radius, def.color);
    this.hpBar = scene.add.graphics();

    // Name rendered above the circle in the default token colour so every
    // nameplate reads in a unified accent regardless of the creature's
    // individual `def.color`.
    this.nameText = scene.add
      .text(0, nameY, def.name, {
        fontSize: '10px',
        color: DEFAULT_TOKEN_COLOR_HEX,
        fontFamily: 'monospace',
        resolution: DPR,
      })
      .setOrigin(0.5, 1);

    // Combat label always centered inside the circle, in white.
    // Shown only during combat for enemy/ally tokens (see setLabelVisible).
    this.labelText = scene.add
      .text(0, 0, '', { fontSize: '11px', color: '#ffffff', fontFamily: 'monospace', resolution: DPR })
      .setOrigin(0.5, 0.5);

    this.container = scene.add
      .container(tileX * TILE_SIZE + TILE_SIZE / 2, tileY * TILE_SIZE + TILE_SIZE / 2, [
        this.selectionRing, body, this.hpBar, this.nameText, this.labelText,
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
      duration: scaleDuration(MOVE_DURATION),
      ease: 'Sine.easeInOut',
      onComplete: () => { this.moving = false; onComplete(); },
    });
  }

  /** Fire-and-forget reconcile glide — a short distance-aware tween used when
   *  state reconciliation finds the token off its tile (off-camera sim moves),
   *  so neutrals stop teleporting on screen (docs/design/systems/animation-timeline.md).
   *  Long jumps (resume, map swap) still snap via teleport(). */
  glideTo(tx: number, ty: number): void {
    const dist = Math.max(Math.abs(tx - this.tileX), Math.abs(ty - this.tileY));
    if (dist === 0) return;
    this.tileX = tx;
    this.tileY = ty;
    this.scene.tweens.add({
      targets: this.container,
      x: tx * TILE_SIZE + TILE_SIZE / 2,
      y: ty * TILE_SIZE + TILE_SIZE / 2,
      duration: scaleDuration(Math.min(TIMING.glideMaxMs, dist * TIMING.glidePerTileMs)),
      ease: 'Sine.easeInOut',
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

  setCombatLabel(label: string): void {
    this.combatLabel = label;
  }

  setNameText(name: string): void {
    this.nameText.setText(name);
  }

  /** Show/hide the nameplate above the token (independent of the combat
   *  label inside the token — combat labels stay visible because they're
   *  functional, not decorative). Driven by the GM panel's LABELS toggle. */
  setNameVisible(visible: boolean): void {
    this.nameText.setVisible(visible);
  }

  setLabelVisible(visible: boolean): void {
    this.labelText.setText(this.disposition !== 'neutral' && visible ? this.combatLabel : '');
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

  setDead(): void {
    this.container.setAlpha(0.4);
    this.hpBar.clear();
    this.labelText.setText('');
  }

  /** Brief lunge a fraction of a tile toward (tx,ty) and back — the attack
   *  "swing" beat. Returns to the resting tile centre on completion. */
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
      duration: scaleDuration(TIMING.lungeMs), yoyo: true, ease: 'Quad.easeOut',
      onComplete: () => { this.container.setPosition(cx, cy); onComplete(); },
    });
  }

  /** A quick sidestep perpendicular to an incoming attack — the whiff/dodge on a
   *  miss (Animation Roadmap · M4). Fire-and-forget; returns to the tile centre. */
  dodge(fromDx: number, fromDy: number): void {
    const cx = this.tileX * TILE_SIZE + TILE_SIZE / 2;
    const cy = this.tileY * TILE_SIZE + TILE_SIZE / 2;
    const len = Math.hypot(fromDx, fromDy) || 1;
    const px = -fromDy / len, py = fromDx / len;
    this.scene.tweens.add({
      targets: this.container,
      x: cx + px * TILE_SIZE * 0.3, y: cy + py * TILE_SIZE * 0.3,
      duration: scaleDuration(TIMING.lungeMs), yoyo: true, ease: 'Quad.easeOut',
      onComplete: () => this.container.setPosition(cx, cy),
    });
  }

  /** Drop the HP bar to `newHp` and pop the token — the damage-impact beat. */
  flashHit(newHp: number, onComplete: () => void): void {
    this.setHp(newHp);
    this.scene.tweens.add({
      targets: this.container, scaleX: 1.18, scaleY: 1.18,
      duration: scaleDuration(TIMING.flashMs), yoyo: true, ease: 'Quad.easeOut', onComplete,
    });
  }

  /** Fade to the dead/corpse state — the death beat (Animation Roadmap · M4: the
   *  corpse topples to one side so deaths read more distinctly than a flat fade).
   *  The topple direction alternates by tile so a wiped-out cluster doesn't fall
   *  in lockstep. */
  fadeToDead(onComplete: () => void): void {
    const topple = this.tileX % 2 === 0 ? 12 : -12;
    this.scene.tweens.add({
      targets: this.container, alpha: 0.4, angle: topple, duration: scaleDuration(TIMING.deathFadeMs), ease: 'Quad.easeOut',
      onComplete: () => { this.setDead(); onComplete(); },
    });
  }

  destroy(): void { this.container.destroy(); }

  private refreshHpBar(): void {
    this.hpBar.clear();
    if (this.hp <= 0) return;
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
