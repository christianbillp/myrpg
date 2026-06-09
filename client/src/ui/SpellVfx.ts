import Phaser from 'phaser';
import { TILE_SIZE } from '../constants';
import type { GameEvent } from '../../../shared/types';

type SpellVfxEvent = Extract<GameEvent, { type: 'spell_vfx' }>;
type Pt = { x: number; y: number };

/** [core, glow] colours per palette. New element type = one entry. */
const PALETTES: Record<string, [number, number]> = {
  fire: [0xff7a1a, 0xffd24a], frost: [0x8fd3ff, 0xe6f7ff], poison: [0x6abf3a, 0xb6ff7a],
  acid: [0xaecf2a, 0xe8ff7a], necrotic: [0x7a3b8f, 0xc79be0], radiant: [0xfff0a8, 0xffffff],
  lightning: [0x7ab8ff, 0xeaf2ff], thunder: [0xb0a0ff, 0xe8e0ff], force: [0xc59bff, 0xeedcff],
  psychic: [0xff7ad0, 0xffd0ee], light: [0xfff2c0, 0xffffff], illusion: [0xb0a8ff, 0xe0dcff],
  nature: [0x6abf6a, 0xb6ffb6], arcane: [0xb07aff, 0xe0c8ff],
};
const palette = (name: string): [number, number] => PALETTES[name] ?? PALETTES.arcane;
const centre = (tx: number, ty: number): Pt => ({ x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 });
/** SRD placed-sphere origin: a grid-line intersection — the cursor tile's
 *  top-left corner (the engine centres `placedSphereTiles` on this point). */
const intersection = (tx: number, ty: number): Pt => ({ x: tx * TILE_SIZE, y: ty * TILE_SIZE });

/**
 * The reusable spell-cast visual primitives. `play()` dispatches a `spell_vfx`
 * timeline beat to the matching procedural effect and calls `onComplete` when it
 * "lands", so the event queue blocks on the cast before the damage/heal beat.
 * Procedural (Phaser graphics + tweens) — sprite/particle assets can be swapped
 * in later behind the same style/palette interface.
 */
export class SpellVfx {
  /** `layer` is the GridView container (offset + zoom-scaled + player-scrolled);
   *  all VFX are parented to it so they share the tokens' coordinate space. */
  constructor(private scene: Phaser.Scene, private layer: Phaser.GameObjects.Container) {}

  private at<T extends Phaser.GameObjects.GameObject>(obj: T): T { this.layer.add(obj); return obj; }

  play(ev: SpellVfxEvent, from: Pt | null, to: Pt | null, onComplete: () => void): void {
    const [core, glow] = palette(ev.palette);
    const src = from ? centre(from.x, from.y) : null;
    // A `sphere` AoE is centred on a grid-line intersection (the cursor tile's
    // corner), matching the engine's placed-sphere footprint; every other
    // target resolves to the tile centre.
    const dst = to ? (ev.shape === 'sphere' ? intersection(to.x, to.y) : centre(to.x, to.y)) : src;
    switch (ev.style) {
      case 'projectile': return this.projectile(src, dst, core, glow, ev.count ?? 1, onComplete);
      case 'beam': return this.beam(src, dst, core, glow, onComplete);
      case 'touch-burst': return this.burst(dst, core, glow, TILE_SIZE * 0.55, 170, onComplete);
      case 'target-burst': return this.burst(dst, core, glow, TILE_SIZE * 0.7, 190, onComplete);
      case 'area-burst': {
        const r = Math.max(1, Math.ceil((ev.radiusFeet ?? 5) / 5)) * TILE_SIZE;
        return this.burst(dst, core, glow, r, 300, onComplete);
      }
      case 'zone-spawn': {
        const r = ev.radiusFeet ? Math.max(1, Math.ceil(ev.radiusFeet / 5)) * TILE_SIZE : TILE_SIZE * 1.3;
        return this.burst(dst, core, glow, r, 320, onComplete);
      }
      case 'summon-appear': return this.glow(dst, glow, 300, onComplete);
      case 'target-glow': return this.glow(dst, glow, 220, onComplete);
      case 'self-glow': return this.glow(src, glow, 220, onComplete);
      case 'vanish': return this.glow(src, glow, 240, onComplete);
      case 'ambient': return this.glow(src, glow, 130, onComplete);
      default: return onComplete();
    }
  }

  /** One or more glowing motes flying from caster to target, each with an
   *  impact spark on arrival. Resolves when the last lands. */
  private projectile(src: Pt | null, dst: Pt | null, core: number, glow: number, count: number, onComplete: () => void): void {
    if (!src || !dst) return onComplete();
    let landed = 0;
    const total = Math.max(1, count);
    for (let i = 0; i < total; i++) {
      const dot = this.at(this.scene.add.circle(src.x, src.y, 4, core).setDepth(40));
      const halo = this.at(this.scene.add.circle(src.x, src.y, 7, glow, 0.4).setDepth(39));
      this.scene.tweens.add({
        targets: [dot, halo], x: dst.x, y: dst.y, duration: 200, delay: i * 70, ease: 'Quad.easeIn',
        onComplete: () => {
          dot.destroy(); halo.destroy(); this.spark(dst, glow);
          if (++landed === total) onComplete();
        },
      });
    }
  }

  /** A flashing coloured line from caster to target. */
  private beam(src: Pt | null, dst: Pt | null, core: number, glow: number, onComplete: () => void): void {
    if (!src || !dst) return onComplete();
    const g = this.at(this.scene.add.graphics().setDepth(40));
    g.lineStyle(5, glow, 0.5).lineBetween(src.x, src.y, dst.x, dst.y);
    g.lineStyle(2, core, 1).lineBetween(src.x, src.y, dst.x, dst.y);
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 200, ease: 'Quad.easeOut', onComplete: () => { g.destroy(); this.spark(dst, glow); onComplete(); } });
  }

  /** An expanding translucent disc that emanates FROM the centre point — touch /
   *  target / area / zone bursts. Drawn with Graphics.fillCircle at (at.x,at.y)
   *  each frame so it is unambiguously centred (no scale-origin guesswork). */
  private burst(at: Pt | null, core: number, glow: number, radius: number, dur: number, onComplete: () => void): void {
    if (!at) return onComplete();
    const g = this.at(this.scene.add.graphics().setDepth(40));
    const t = { p: 0 };
    this.scene.tweens.add({
      targets: t, p: 1, duration: dur, ease: 'Quad.easeOut',
      onUpdate: () => {
        const r = Math.max(1, radius * t.p);
        const fade = 1 - t.p;
        g.clear();
        g.fillStyle(core, 0.32 * fade);
        g.fillCircle(at.x, at.y, r);
        g.lineStyle(2.5, glow, 0.9 * fade);
        g.strokeCircle(at.x, at.y, r);
      },
      onComplete: () => { g.destroy(); onComplete(); },
    });
  }

  /** A soft aura that swells and fades, centred on the point — buffs / summons /
   *  teleports / ambient. Graphics-drawn so it stays centred at (at.x,at.y). */
  private glow(at: Pt | null, glow: number, dur: number, onComplete: () => void): void {
    if (!at) return onComplete();
    const g = this.at(this.scene.add.graphics().setDepth(40));
    const base = TILE_SIZE * 0.45;
    const t = { p: 0 };
    this.scene.tweens.add({
      targets: t, p: 1, duration: dur, ease: 'Sine.easeOut',
      onUpdate: () => { g.clear(); g.fillStyle(glow, 0.45 * (1 - t.p)); g.fillCircle(at.x, at.y, base * (0.6 + 0.8 * t.p)); },
      onComplete: () => { g.destroy(); onComplete(); },
    });
  }

  /** A quick fire-and-forget impact puff (not awaited), centred on the point. */
  private spark(at: Pt, glow: number): void {
    const g = this.at(this.scene.add.graphics().setDepth(41));
    const t = { p: 0 };
    this.scene.tweens.add({
      targets: t, p: 1, duration: 160, ease: 'Quad.easeOut',
      onUpdate: () => { g.clear(); g.fillStyle(glow, 0.7 * (1 - t.p)); g.fillCircle(at.x, at.y, 5 + 10 * t.p); },
      onComplete: () => g.destroy(),
    });
  }
}
