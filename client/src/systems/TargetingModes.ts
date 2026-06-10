import Phaser from "phaser";
import type { GameState, NpcState, PlayerAction, SpellDef } from "../../../shared/types";
import { TILE_SIZE } from "../constants";
import { SpellTargetSelector, type SpellTargetCandidate } from "../ui/SpellTargetSelector";
import type { UIScale } from "../ui/UIScale";

type AbilityChoice = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

/**
 * The scene services a targeting mode is allowed to touch. Kept narrow on
 * purpose — modes never reach into the Game Scene's internals; everything
 * they need (state, defs, the preview layer, action dispatch) comes through
 * this interface.
 */
export interface TargetingModeContext {
  getGameState(): GameState | null;
  getSpells(): SpellDef[];
  sendAction(action: PlayerAction): void;
  /** Cursor-following preview layer (`spellAoeLayer`). The scene clears it
   *  before every `drawPreview` call and on mode exit; modes only paint. */
  getPreviewLayer(): Phaser.GameObjects.Graphics;
  /** Live player-token tile (animation position, not server state) — the
   *  preview origin. Null until the token exists. */
  getPlayerTokenTile(): { x: number; y: number } | null;
  toTile(pointer: Phaser.Input.Pointer): { tileX: number; tileY: number };
  toIntersectionTile(pointer: Phaser.Input.Pointer): { tileX: number; tileY: number };
  /** Exit the active mode: runs `cancel()`, clears the preview layer, and
   *  refreshes the Action Buttons. */
  exitTargetingMode(): void;
  /** Create a text object parented to the map container so it scrolls/zooms
   *  with the tiles (multi-projectile count badges). */
  addMapLabel(x: number, y: number, text: string, style: Phaser.Types.GameObjects.Text.TextStyle): Phaser.GameObjects.Text;
  getUiScale(): UIScale;
}

/**
 * One click-to-target state machine variant. The Game Scene holds at most one
 * active mode and delegates map clicks, mouse-move preview drawing, the
 * Player Panel's Spell Targeting Prompt, and ESC/exit cleanup to it.
 */
export interface TargetingMode {
  /** Spell Targeting Prompt content for the Player Panel. Null keeps the
   *  Action Buttons visible (tile-targeted features work that way). */
  readonly hint: { spellName: string; asRitual: boolean } | null;
  /** Click on a tile holding a creature (living preferred; a dead one when
   *  no living creature shares the tile). */
  onEntityClick(npc: NpcState, tileX: number, tileY: number, pointer: Phaser.Input.Pointer): void;
  /** Click on a tile with no creature on it. */
  onTileClick(tileX: number, tileY: number, pointer: Phaser.Input.Pointer): void;
  /** Paint the cursor-following preview. The scene has already cleared the layer. */
  drawPreview(pointer: Phaser.Input.Pointer): void;
  /** Mode-specific resource cleanup (DOM panels, badges). Runs once when the
   *  mode exits or is replaced. */
  cancel(): void;
}

/** Range underlay: every tile within the spell's range from the caster,
 *  painted before any AOE shape so AOE colour wins on overlap. Cool teal
 *  tint (distinct from move highlight + AOE orange + summon blue). */
function paintRangeUnderlay(ctx: TargetingModeContext, spellId: string): void {
  const state = ctx.getGameState();
  const playerTile = ctx.getPlayerTokenTile();
  if (!state || !playerTile) return;
  const layer = ctx.getPreviewLayer();
  const { cols, rows } = state.map;
  const spell = ctx.getSpells().find((sp) => sp.id === spellId);
  if (spell && spell.rangeFeet > 0) {
    const rangeTiles = Math.max(1, Math.ceil(spell.rangeFeet / 5));
    layer.fillStyle(0x44aacc, 0.14);
    for (let dy = -rangeTiles; dy <= rangeTiles; dy++) {
      for (let dx = -rangeTiles; dx <= rangeTiles; dx++) {
        if (dx === 0 && dy === 0) continue;  // caster's own tile
        const x = playerTile.x + dx, y = playerTile.y + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        layer.fillRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
    }
  }
}

/**
 * Creature-target spells (attack-roll / auto-hit / single-target save /
 * touch buffs): waits for a creature click. A self-click resolves as
 * self-target for touch-range buffs; anything else cancels.
 */
export class CreatureTargetingMode implements TargetingMode {
  readonly hint: { spellName: string; asRitual: boolean };

  constructor(
    private readonly ctx: TargetingModeContext,
    private readonly params: {
      spellId: string; spellName: string; asRitual: boolean; slotLevel?: number;
      damageTypeChoice?: string; abilityChoice?: AbilityChoice;
    },
  ) {
    this.hint = { spellName: params.spellName, asRitual: params.asRitual };
  }

  onEntityClick(npc: NpcState, tileX: number, tileY: number): void {
    this.resolveClick(npc, tileX, tileY);
  }

  onTileClick(tileX: number, tileY: number): void {
    this.resolveClick(undefined, tileX, tileY);
  }

  /** Self-click during creature-target mode resolves as self-target so
   *  touch-range buff spells (Longstrider, Jump, …) work via the existing
   *  target picker. Spare the Dying targets a creature at 0 HP, so it accepts
   *  a downed (hp === 0) click; every other creature-target spell needs a
   *  living one. */
  private resolveClick(npc: NpcState | undefined, tileX: number, tileY: number): void {
    const state = this.ctx.getGameState();
    if (!state) return;
    const ps = state.player;
    const isSelfClick = tileX === ps.tileX && tileY === ps.tileY;
    const allowDowned = this.params.spellId === 'spare-the-dying';
    const validTarget = isSelfClick ? 'player' : (npc && (npc.hp > 0 || allowDowned) ? npc.id : null);

    const spell = this.ctx.getSpells().find((sp) => sp.id === this.params.spellId);
    if (!spell) { this.ctx.exitTargetingMode(); return; }
    // US-116: honour the upcast level chosen in beginSpellCast (stored on the
    // target mode); fall back to the spell's base level.
    const slotLevel = spell.level === 0 ? 0 : (this.params.slotLevel ?? spell.level);

    if (!validTarget) { this.ctx.exitTargetingMode(); return; }
    // Self-target click: fire the cast with no targetIds. The engine
    // routes the cast through `resolveUtilitySpell` (or its specific case)
    // which applies the buff to the caster. Only valid for touch-range
    // buff spells; clicking self for a Charm Person or Chill Touch
    // cancels (it's not a legal self-target).
    if (validTarget === 'player') {
      const isTouchBuff = spell.range === 'touch' &&
        !spell.attack && !spell.save && !spell.area && !spell.summon && !spell.darts;
      // Ranged self-targetable utility (Sanctuary wards, Enlarge/Reduce in
      // its Enlarge mode buffs the caster) also accepts a self-click; a
      // Charm Person / Chill Touch self-click cancels.
      const selfTargetable = isTouchBuff || this.params.spellId === 'sanctuary' || this.params.spellId === 'enlarge-reduce';
      if (!selfTargetable) { this.ctx.exitTargetingMode(); return; }
      this.ctx.sendAction({ type: "castSpell", spellId: this.params.spellId, slotLevel, asRitual: this.params.asRitual, damageTypeChoice: this.params.damageTypeChoice, abilityChoice: this.params.abilityChoice });
      this.ctx.exitTargetingMode();
      return;
    }
    this.ctx.sendAction({ type: "castSpell", spellId: this.params.spellId, slotLevel, targetIds: [validTarget], asRitual: this.params.asRitual, damageTypeChoice: this.params.damageTypeChoice, abilityChoice: this.params.abilityChoice });
    this.ctx.exitTargetingMode();
  }

  drawPreview(): void {
    paintRangeUnderlay(this.ctx, this.params.spellId);
  }

  cancel(): void { /* no mode-specific resources */ }
}

/**
 * AOE spells: waits for a tile click. The area shape determines what gets
 * highlighted as the cursor moves:
 *   shape "cone"  — origin = player tile, direction = cursor.
 *   shape "sphere"/"cube" + selfAnchored — disc on player tile.
 *   shape "sphere"/"cube" otherwise        — disc on cursor tile.
 */
export class AoeTargetingMode implements TargetingMode {
  readonly hint: { spellName: string; asRitual: boolean };

  constructor(
    private readonly ctx: TargetingModeContext,
    private readonly params: {
      spellId: string; spellName: string; asRitual: boolean; slotLevel?: number;
      /** For cone: the cone's max reach in tiles. For sphere/cube/line: the long-axis length of the area in tiles. */
      sideTiles: number;
      /** Width of the area perpendicular to the axis (Gust of Wind: 2 tiles for a 10-ft-wide line). Only consulted for `shape: 'line'`. */
      widthTiles?: number;
      selfAnchored: boolean;
      shape: "cone" | "sphere" | "cube" | "line";
      damageTypeChoice?: string; abilityChoice?: AbilityChoice;
    },
  ) {
    this.hint = { spellName: params.spellName, asRitual: params.asRitual };
  }

  onEntityClick(_npc: NpcState, tileX: number, tileY: number, pointer: Phaser.Input.Pointer): void {
    this.onTileClick(tileX, tileY, pointer);
  }

  onTileClick(tileX: number, tileY: number, pointer: Phaser.Input.Pointer): void {
    // Placed sphere: the AoE centres on a grid-line intersection — snap to
    // the one nearest the cursor so the centre tracks the pointer (matches
    // the preview + `placedSphereTiles`).
    if (this.params.shape === "sphere" && !this.params.selfAnchored && this.params.sideTiles > 0) {
      const c = this.ctx.toIntersectionTile(pointer);
      this.resolveAtTile(c.tileX, c.tileY);
    } else {
      this.resolveAtTile(tileX, tileY);
    }
  }

  /** AOE: the `tile` payload is the cursor click. For cones it tells the
   *  server the direction; for spheres/cubes it's the centre. Self-anchored
   *  sphere spells ignore the tile server-side but we still pass cursor —
   *  server resolves correctly either way. */
  private resolveAtTile(tileX: number, tileY: number): void {
    const spell = this.ctx.getSpells().find((sp) => sp.id === this.params.spellId);
    if (!spell) { this.ctx.exitTargetingMode(); return; }
    const slotLevel = spell.level === 0 ? 0 : (this.params.slotLevel ?? spell.level);
    const tile = { x: tileX, y: tileY };

    // SRD "creature of your choice" spells (Sleep) get a second-step picker
    // listing the creatures actually inside the area, defaulting to every
    // non-ally. Confirm fires the cast with the chosen ids; cancel aborts.
    if (spell.area?.creaturesOfYourChoice) {
      const candidates = this.creaturesInPlacedArea(spell, tile);
      this.ctx.exitTargetingMode();
      new SpellTargetSelector(
        this.ctx.getUiScale(),
        spell.name,
        candidates,
        (selectedIds) => {
          this.ctx.sendAction({
            type: "castSpell",
            spellId: this.params.spellId,
            slotLevel,
            tile,
            targetIds: selectedIds,
            asRitual: this.params.asRitual,
            damageTypeChoice: this.params.damageTypeChoice,
          });
        },
        () => { /* cancelled — no slot consumed */ },
      );
      return;
    }

    this.ctx.sendAction({ type: "castSpell", spellId: this.params.spellId, slotLevel, tile, asRitual: this.params.asRitual, damageTypeChoice: this.params.damageTypeChoice, abilityChoice: this.params.abilityChoice });
    this.ctx.exitTargetingMode();
  }

  /**
   * Mirror server `tilesInArea` to enumerate the creatures the AOE actually
   * covers, so the SpellTargetSelector can list them. Non-ally creatures are
   * tagged for the picker's default-checked state.
   *
   * Sphere placed at a click follows the SRD grid-intersection rule —
   * 2*r tiles per side anchored at the click. Cube uses tile-side length,
   * centred for odd sizes, extends right+down for even sizes. Sleep is the
   * currently-shipped consumer.
   */
  private creaturesInPlacedArea(spell: SpellDef, tile: { x: number; y: number }): SpellTargetCandidate[] {
    const state = this.ctx.getGameState();
    if (!state) return [];
    const sizeFeet = spell.area?.sizeFeet ?? 5;
    const r = Math.max(1, Math.ceil(sizeFeet / 5));
    let xMin: number, xMax: number, yMin: number, yMax: number;
    if (spell.area?.shape === 'sphere') {
      // Match `placedSphereTiles` on the server: 2r-wide square centered on
      // the cursor (`r` tiles on each side of the click). The pre-centering
      // version of this code anchored the square top-left at the cursor,
      // which made the picker miss creatures that the server-side AOE
      // actually covered.
      const sideTiles = 2 * r;
      const halfLow = r;
      xMin = tile.x - halfLow; xMax = tile.x + (sideTiles - halfLow) - 1;
      yMin = tile.y - halfLow; yMax = tile.y + (sideTiles - halfLow) - 1;
    } else {
      const side = r;
      if (side % 2 === 1) {
        const rr = (side - 1) / 2;
        xMin = tile.x - rr; xMax = tile.x + rr; yMin = tile.y - rr; yMax = tile.y + rr;
      } else {
        const offset = side - 1;
        xMin = tile.x; xMax = tile.x + offset; yMin = tile.y; yMax = tile.y + offset;
      }
    }
    const out: SpellTargetCandidate[] = [];
    for (const npc of state.npcs) {
      if (npc.hp <= 0) continue;
      if (npc.tileX < xMin || npc.tileX > xMax || npc.tileY < yMin || npc.tileY > yMax) continue;
      const label = npc.combatLabel
        ? `${npc.revealedName ?? npc.name} (${npc.combatLabel})`
        : (npc.revealedName ?? npc.name);
      out.push({ id: npc.id, label, isAlly: npc.disposition === 'ally' });
    }
    return out;
  }

  /**
   * AOE preview. The shape of the highlight matches the spell's `area.shape`
   * and the same tile-set logic the server uses to find affected creatures,
   * so what you see is what gets hit.
   */
  drawPreview(pointer: Phaser.Input.Pointer): void {
    paintRangeUnderlay(this.ctx, this.params.spellId);
    const state = this.ctx.getGameState();
    const playerTile = this.ctx.getPlayerTokenTile();
    if (!state || !playerTile) return;
    const layer = this.ctx.getPreviewLayer();
    const { tileX, tileY } = this.ctx.toTile(pointer);
    const { cols, rows } = state.map;
    const side = this.params.sideTiles;
    layer.fillStyle(0xff8844, 0.28);

    const paintTile = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      layer.fillRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    };

    if (this.params.shape === "cone") {
      // Cone semantic: `sideTiles` is the cone's reach in tiles.
      const r = side;
      const ox = playerTile.x, oy = playerTile.y;
      let dx = tileX - ox, dy = tileY - oy;
      const len = Math.hypot(dx, dy);
      if (len === 0) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
      for (let ry = -r; ry <= r; ry++) {
        for (let rx = -r; rx <= r; rx++) {
          if (rx === 0 && ry === 0) continue;
          const along = rx * dx + ry * dy;
          if (along <= 0 || along > r + 0.5) continue;
          const perp = Math.abs(-rx * dy + ry * dx);
          if (perp > along * 0.5 + 0.5) continue;
          paintTile(ox + rx, oy + ry);
        }
      }
    } else if (this.params.shape === "line") {
      // Line preview — mirrors the continuous-direction
      // `lineFromCasterTiles` on the server. Any angle around the caster
      // works; the line follows the exact cursor direction with a
      // perpendicular width band.
      const length = side;
      const width = Math.max(1, this.params.widthTiles ?? 1);
      const ox = playerTile.x, oy = playerTile.y;
      const dirX = tileX - ox;
      const dirY = tileY - oy;
      const len = Math.hypot(dirX, dirY);
      if (len > 0) {
        const ux = dirX / len;
        const uy = dirY / len;
        const perpX = -uy;
        const perpY = ux;
        const halfLow = Math.floor((width - 1) / 2);
        const halfHigh = Math.ceil((width - 1) / 2);
        for (let step = 1; step <= length; step++) {
          for (let off = -halfLow; off <= halfHigh; off++) {
            const fx = ox + ux * step + perpX * off;
            const fy = oy + uy * step + perpY * off;
            paintTile(Math.round(fx), Math.round(fy));
          }
        }
      }
    } else if (this.params.shape === "sphere") {
      // Sphere preview:
      //   single-tile (r=0) → just the cursor tile (Flaming Sphere).
      //   self-anchored     → chebyshev disc on the caster's tile centre.
      //   placed            → SRD grid-intersection rule: 2*r tiles per
      //                       side, centered on the cursor (matches
      //                       `placedSphereTiles` in SpellSystem).
      const r = side;
      if (r === 0) {
        paintTile(tileX, tileY);
        return;
      }
      if (this.params.selfAnchored) {
        const cx = playerTile.x, cy = playerTile.y;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) paintTile(cx + dx, cy + dy);
        }
      } else {
        // Placed sphere centres on the grid intersection NEAREST the cursor
        // (round, not floor) so the highlight tracks the pointer.
        const c = this.ctx.toIntersectionTile(pointer);
        const sideTiles = 2 * r;
        const halfLow = r;
        for (let dy = -halfLow; dy < sideTiles - halfLow; dy++) {
          for (let dx = -halfLow; dx < sideTiles - halfLow; dx++) paintTile(c.tileX + dx, c.tileY + dy);
        }
      }
    } else {
      // Cube preview. Self-anchored (Thunderwave) extends FROM the caster
      // in the cursor direction — caster's tile is NOT in the cube.
      // Click-anchored (Grease) extends from the clicked tile.
      if (this.params.selfAnchored) {
        let ddx = Math.sign(tileX - playerTile.x);
        let ddy = Math.sign(tileY - playerTile.y);
        if (ddx === 0 && ddy === 0) ddx = 1;
        const halfLow  = Math.floor((side - 1) / 2);
        const halfHigh = Math.ceil((side - 1) / 2);
        const cx0 = playerTile.x, cy0 = playerTile.y;
        let xMin: number, xMax: number, yMin: number, yMax: number;
        if (ddx === 0)      { xMin = cx0 - halfLow; xMax = cx0 + halfHigh; }
        else if (ddx > 0)   { xMin = cx0 + 1;       xMax = cx0 + side; }
        else                { xMin = cx0 - side;    xMax = cx0 - 1; }
        if (ddy === 0)      { yMin = cy0 - halfLow; yMax = cy0 + halfHigh; }
        else if (ddy > 0)   { yMin = cy0 + 1;       yMax = cy0 + side; }
        else                { yMin = cy0 - side;    yMax = cy0 - 1; }
        for (let y = yMin; y <= yMax; y++) {
          for (let x = xMin; x <= xMax; x++) paintTile(x, y);
        }
      } else {
        const cx = tileX, cy = tileY;
        let xMin: number, xMax: number, yMin: number, yMax: number;
        if (side % 2 === 1) {
          const r = (side - 1) / 2;
          xMin = cx - r; xMax = cx + r; yMin = cy - r; yMax = cy + r;
        } else {
          const offset = side - 1;
          xMin = cx; xMax = cx + offset; yMin = cy; yMax = cy + offset;
        }
        for (let y = yMin; y <= yMax; y++) {
          for (let x = xMin; x <= xMax; x++) paintTile(x, y);
        }
      }
    }
  }

  cancel(): void { /* no mode-specific resources */ }
}

/**
 * Multi-projectile spells (Magic Missile darts, Scorching Ray rays): each
 * creature click adds one projectile to that creature's assignment; a small
 * floating HUD panel shows the running tally and a FIRE button. The cast
 * sends the expanded `targetIds` array (one id per projectile).
 */
export class MultiProjectileTargetingMode implements TargetingMode {
  readonly hint: { spellName: string; asRitual: boolean };
  /** Per-target assignment count, keyed by NPC id. */
  private readonly assignments = new Map<string, number>();
  private panel: HTMLDivElement | null = null;
  /** Per-target count badges drawn over each NPC token while the player
   *  is distributing projectiles. Cleared when the cast resolves. */
  private badges: Phaser.GameObjects.Text[] = [];

  constructor(
    private readonly ctx: TargetingModeContext,
    private readonly params: {
      spellId: string; spellName: string; asRitual: boolean; slotLevel: number;
      /** Total projectiles the player must distribute. */
      total: number;
      /** Display word — "dart" / "ray". */
      projectileNoun: string;
      damageTypeChoice?: string;
    },
  ) {
    this.hint = { spellName: params.spellName, asRitual: params.asRitual };
    this.openPanel();
    this.refreshBadges();
  }

  /** Click on an in-range hostile/neutral creature → assign one more
   *  projectile to it. Click anywhere else → ignored (the panel's CANCEL
   *  button is the way out). Clicking past the cap is a no-op so the player
   *  can't over-commit. */
  onEntityClick(npc: NpcState): void {
    const state = this.ctx.getGameState();
    if (!state) return;
    if (npc.hp <= 0 || npc.disposition === 'ally') return;
    const spell = this.ctx.getSpells().find((sp) => sp.id === this.params.spellId);
    if (!spell) return;
    const rangeTiles = Math.max(1, Math.ceil(spell.rangeFeet / 5));
    const ps = state.player;
    const dist = Math.max(Math.abs(npc.tileX - ps.tileX), Math.abs(npc.tileY - ps.tileY));
    if (dist > rangeTiles) return;
    const used = [...this.assignments.values()].reduce((a, b) => a + b, 0);
    if (used >= this.params.total) return;
    this.assignments.set(npc.id, (this.assignments.get(npc.id) ?? 0) + 1);
    this.refreshPanel();
    this.refreshBadges();
  }

  onTileClick(): void { /* empty-tile clicks are ignored — CANCEL/ESC is the way out */ }

  drawPreview(): void {
    paintRangeUnderlay(this.ctx, this.params.spellId);
  }

  cancel(): void {
    this.closePanel();
    this.clearBadges();
  }

  /** Build the floating "Select Targets" HUD. Lists the per-target assignment
   *  counts plus a running "X / N" tally; FIRE submits the cast and CANCEL
   *  aborts without consuming the slot. */
  private openPanel(): void {
    this.closePanel();
    const root = document.createElement('div');
    root.style.cssText = `
      position: fixed; left: 50%; top: 14px; transform: translateX(-50%);
      background: #1a1a22; border: 2px solid #ffaa66; color: #ffe4b3;
      font-family: monospace; font-size: 12px; padding: 10px 14px;
      display: flex; flex-direction: column; gap: 6px; z-index: 9050;
      min-width: 280px;
    `;
    document.body.appendChild(root);
    this.panel = root;
    this.refreshPanel();
  }

  private refreshPanel(): void {
    const root = this.panel;
    if (!root) return;
    const used = [...this.assignments.values()].reduce((a, b) => a + b, 0);
    const ready = used === this.params.total;
    root.replaceChildren();

    const header = document.createElement('div');
    header.textContent = `${this.params.spellName.toUpperCase()} — select targets`;
    header.style.cssText = 'font-size: 12px; letter-spacing: 2px;';
    root.appendChild(header);

    const help = document.createElement('div');
    help.textContent = `Click a creature to add a ${this.params.projectileNoun}. ESC or CANCEL aborts.`;
    help.style.cssText = 'font-size: 10px; color: #cc9966; line-height: 1.5;';
    root.appendChild(help);

    const tally = document.createElement('div');
    tally.textContent = `${used} / ${this.params.total} ${this.params.projectileNoun}${this.params.total === 1 ? '' : 's'} assigned`;
    tally.style.cssText = `font-size: 11px; color: ${ready ? '#aaff99' : '#cc9966'};`;
    root.appendChild(tally);

    // Per-target rows — only show creatures that have at least one
    // projectile assigned, sorted by id for a stable layout.
    if (this.assignments.size > 0) {
      const list = document.createElement('div');
      list.style.cssText = 'display: flex; flex-direction: column; gap: 2px; max-height: 120px; overflow-y: auto;';
      const ids = [...this.assignments.keys()].sort();
      for (const id of ids) {
        const count = this.assignments.get(id) ?? 0;
        if (count === 0) continue;
        const npc = this.ctx.getGameState()?.npcs.find((n) => n.id === id);
        if (!npc) continue;
        const label = (npc.combatLabel ? `${npc.revealedName ?? npc.name} (${npc.combatLabel})` : (npc.revealedName ?? npc.name));
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 11px;';
        const name = document.createElement('span');
        name.textContent = label;
        name.style.color = '#cce4ff';
        row.appendChild(name);
        const right = document.createElement('span');
        right.style.cssText = 'display: flex; align-items: center; gap: 6px;';
        const countEl = document.createElement('span');
        countEl.textContent = `×${count}`;
        countEl.style.color = '#ffd699';
        right.appendChild(countEl);
        const minus = document.createElement('button');
        minus.textContent = '−';
        minus.style.cssText = 'width: 22px; height: 20px; background: #2a1a1a; border: 1px solid #aa5533; color: #ffd699; cursor: pointer; font-family: monospace;';
        minus.addEventListener('click', () => {
          const cur = this.assignments.get(id) ?? 0;
          if (cur <= 1) this.assignments.delete(id);
          else this.assignments.set(id, cur - 1);
          this.refreshPanel();
          this.refreshBadges();
        });
        right.appendChild(minus);
        row.appendChild(right);
        list.appendChild(row);
      }
      root.appendChild(list);
    }

    const actions = document.createElement('div');
    actions.style.cssText = 'display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'CANCEL';
    cancelBtn.style.cssText = 'background: #222233; border: 2px solid #556677; color: #aabbcc; font-family: monospace; font-size: 11px; padding: 5px 10px; cursor: pointer;';
    cancelBtn.addEventListener('click', () => this.ctx.exitTargetingMode());
    actions.appendChild(cancelBtn);
    const fire = document.createElement('button');
    fire.textContent = 'FIRE';
    fire.disabled = !ready;
    fire.style.cssText = `background: #3a1a1a; border: 2px solid #aa5533; color: #ffd699; font-family: monospace; font-size: 11px; padding: 5px 10px; cursor: ${ready ? 'pointer' : 'not-allowed'}; opacity: ${ready ? '1' : '0.45'};`;
    fire.addEventListener('click', () => {
      if (!ready) return;
      this.fire();
    });
    actions.appendChild(fire);
    root.appendChild(actions);
  }

  private closePanel(): void {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  }

  /** Stamp a small "×N" badge next to each targeted creature's token,
   *  re-drawn on every assignment change. */
  private refreshBadges(): void {
    this.clearBadges();
    for (const [id, count] of this.assignments.entries()) {
      if (count === 0) continue;
      const npc = this.ctx.getGameState()?.npcs.find((n) => n.id === id);
      if (!npc) continue;
      const text = this.ctx.addMapLabel(
        npc.tileX * TILE_SIZE + TILE_SIZE - 4,
        npc.tileY * TILE_SIZE + 2,
        `×${count}`,
        { fontFamily: 'monospace', fontSize: '12px', color: '#ffd699', backgroundColor: '#3a1a1aee', padding: { x: 3, y: 1 } },
      ).setOrigin(1, 0);
      this.badges.push(text);
    }
  }

  private clearBadges(): void {
    for (const b of this.badges) b.destroy();
    this.badges = [];
  }

  private fire(): void {
    const ids: string[] = [];
    for (const [id, n] of this.assignments.entries()) {
      for (let i = 0; i < n; i++) ids.push(id);
    }
    this.ctx.sendAction({
      type: 'castSpell',
      spellId: this.params.spellId,
      slotLevel: this.params.slotLevel,
      asRitual: this.params.asRitual,
      targetIds: ids,
      damageTypeChoice: this.params.damageTypeChoice,
    });
    this.ctx.exitTargetingMode();
  }
}

/**
 * "Click to move the summon" mode (Mage Hand, Unseen Servant): the next tile
 * click within the summon's movement allowance fires `commandSummon`;
 * out-of-range clicks cancel.
 */
export class SummonDirectTargetingMode implements TargetingMode {
  readonly hint: { spellName: string; asRitual: boolean };

  constructor(
    private readonly ctx: TargetingModeContext,
    private readonly params: {
      summonNpcId: string; summonName: string;
      /** Movement allowance in tiles (Mage Hand 6, Unseen Servant 3). */
      moveRangeTiles: number;
      /** Summon's current tile — preview shows reachable tiles around this. */
      fromTileX: number; fromTileY: number;
    },
  ) {
    this.hint = { spellName: `Direct ${params.summonName}`, asRitual: false };
  }

  onEntityClick(_npc: NpcState, tileX: number, tileY: number): void {
    this.onTileClick(tileX, tileY);
  }

  onTileClick(tileX: number, tileY: number): void {
    const dx = Math.abs(tileX - this.params.fromTileX);
    const dy = Math.abs(tileY - this.params.fromTileY);
    if (Math.max(dx, dy) > this.params.moveRangeTiles) {
      this.ctx.exitTargetingMode();
      return;
    }
    this.ctx.sendAction({ type: "commandSummon", summonNpcId: this.params.summonNpcId, tile: { x: tileX, y: tileY } });
    this.ctx.exitTargetingMode();
  }

  /** Paint the chebyshev reach disc around the summon's current tile in a
   *  softer blue tint. Out-of-range cursor clicks cancel, matching the spell
   *  target-mode UX. */
  drawPreview(): void {
    const state = this.ctx.getGameState();
    if (!state || !this.ctx.getPlayerTokenTile()) return;
    const layer = this.ctx.getPreviewLayer();
    const { cols, rows } = state.map;
    layer.fillStyle(0x66aaff, 0.24);
    const r = this.params.moveRangeTiles;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = this.params.fromTileX + dx, y = this.params.fromTileY + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        layer.fillRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
    }
  }

  cancel(): void { /* no mode-specific resources */ }
}

/**
 * Deploy-gear mode (caltrops, ball bearings): the next in-range tile click
 * scatters the gear there (creating an area-denial zone). Out-of-range
 * clicks cancel.
 */
export class DeployGearTargetingMode implements TargetingMode {
  readonly hint: { spellName: string; asRitual: boolean };

  constructor(
    private readonly ctx: TargetingModeContext,
    private readonly params: {
      itemId: string; gearName: string;
      /** How far the gear can be placed (tiles) and the square it covers. */
      rangeTiles: number; sideTiles: number;
      /** Player's tile — preview shows reachable placement tiles around this. */
      fromTileX: number; fromTileY: number;
    },
  ) {
    this.hint = { spellName: `Place ${params.gearName}`, asRitual: false };
  }

  onEntityClick(_npc: NpcState, tileX: number, tileY: number): void {
    this.onTileClick(tileX, tileY);
  }

  onTileClick(tileX: number, tileY: number): void {
    const dx = Math.abs(tileX - this.params.fromTileX);
    const dy = Math.abs(tileY - this.params.fromTileY);
    if (Math.max(dx, dy) > this.params.rangeTiles) {
      this.ctx.exitTargetingMode();
      return;
    }
    this.ctx.sendAction({ type: "deployGear", itemId: this.params.itemId, tileX, tileY });
    this.ctx.exitTargetingMode();
  }

  /** Amber reach disc for valid placement tiles, plus the square the gear
   *  will cover under the cursor (when in range). */
  drawPreview(pointer: Phaser.Input.Pointer): void {
    const state = this.ctx.getGameState();
    if (!state || !this.ctx.getPlayerTokenTile()) return;
    const layer = this.ctx.getPreviewLayer();
    const { cols, rows } = state.map;
    const paintRect = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      layer.fillRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    };
    layer.fillStyle(0xc9a23b, 0.18);
    const r = this.params.rangeTiles;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) paintRect(this.params.fromTileX + dx, this.params.fromTileY + dy);
    }
    const { tileX, tileY } = this.ctx.toTile(pointer);
    if (Math.max(Math.abs(tileX - this.params.fromTileX), Math.abs(tileY - this.params.fromTileY)) <= r) {
      layer.fillStyle(0xd24a3a, 0.34);
      const side = this.params.sideTiles;
      const rr = side % 2 === 1 ? (side - 1) / 2 : 0;
      const x0 = tileX - rr, y0 = tileY - rr;
      for (let yy = 0; yy < side; yy++) {
        for (let xx = 0; xx < side; xx++) paintRect(x0 + xx, y0 + yy);
      }
    }
  }

  cancel(): void { /* no mode-specific resources */ }
}

/**
 * Tile-targeted feature mode (Goliath Cloud's Jaunt): awaiting a destination
 * click. `rangeTiles` bounds the valid teleport disc. Unlike the spell modes
 * this one keeps the Action Buttons visible (`hint` is null).
 */
export class FeatureTargetingMode implements TargetingMode {
  readonly hint = null;

  constructor(
    private readonly ctx: TargetingModeContext,
    private readonly params: { featureId: string; rangeTiles: number },
  ) {}

  onEntityClick(npc: NpcState, tileX: number, tileY: number): void {
    this.resolveClick(npc, tileX, tileY);
  }

  onTileClick(tileX: number, tileY: number): void {
    this.resolveClick(undefined, tileX, tileY);
  }

  /** The click is the teleport destination. Dispatch only when it's an
   *  in-range, passable, unoccupied tile (the server re-validates); any
   *  click exits the mode. */
  private resolveClick(npc: NpcState | undefined, tileX: number, tileY: number): void {
    const state = this.ctx.getGameState();
    if (!state) return;
    this.ctx.exitTargetingMode();
    const ps = state.player;
    const dist = Math.max(Math.abs(tileX - ps.tileX), Math.abs(tileY - ps.tileY));
    const passable = !state.map.blocksMovement[tileY]?.[tileX];
    const occupied = !!npc && npc.hp > 0;
    const isSelf = tileX === ps.tileX && tileY === ps.tileY;
    if (dist >= 1 && dist <= this.params.rangeTiles && passable && !occupied && !isSelf) {
      this.ctx.sendAction({ type: "useFeature", featureId: this.params.featureId, tile: { x: tileX, y: tileY } });
    }
  }

  /** Tint the in-range teleport disc and highlight the hovered destination.
   *  Note: anchored on the SERVER state's player tile, unlike the spell
   *  previews which use the live token tile. */
  drawPreview(pointer: Phaser.Input.Pointer): void {
    const state = this.ctx.getGameState();
    if (!state) return;
    const layer = this.ctx.getPreviewLayer();
    const { rangeTiles } = this.params;
    const ps = state.player;
    const { cols, rows, blocksMovement } = state.map;
    layer.fillStyle(0x55aaff, 0.14);
    for (let y = Math.max(0, ps.tileY - rangeTiles); y <= Math.min(rows - 1, ps.tileY + rangeTiles); y++) {
      for (let x = Math.max(0, ps.tileX - rangeTiles); x <= Math.min(cols - 1, ps.tileX + rangeTiles); x++) {
        if ((x === ps.tileX && y === ps.tileY) || blocksMovement[y]?.[x]) continue;
        layer.fillRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
    }
    const { tileX, tileY } = this.ctx.toTile(pointer);
    const dist = Math.max(Math.abs(tileX - ps.tileX), Math.abs(tileY - ps.tileY));
    if (dist >= 1 && dist <= rangeTiles && tileX >= 0 && tileX < cols && tileY >= 0 && tileY < rows && !blocksMovement[tileY]?.[tileX]) {
      layer.fillStyle(0x88ccff, 0.35);
      layer.fillRect(tileX * TILE_SIZE + 1, tileY * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
    }
  }

  cancel(): void { /* no mode-specific resources */ }
}
