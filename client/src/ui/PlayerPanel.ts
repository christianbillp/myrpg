import { PLAYER_PANEL_WIDTH, GRID_ROWS, TILE_SIZE, HUD_HEIGHT } from '../constants';
import { PlayerDef } from '../../../shared/types';
import { AvailableActions, CombatMode } from '../../../shared/types';
import { UIScale } from './UIScale';
import { STATUS_TONE_COLOR } from './PlayerStatus';
import { DevMode } from '../devMode';

const GRID_H   = GRID_ROWS * TILE_SIZE;
const PANEL_H  = GRID_H + HUD_HEIGHT;
const MAX_PICKER_SLOTS = 6;
const PANEL_MIN_WIDTH = 120;
const PANEL_MAX_WIDTH = 480;
const PANEL_WIDTH_KEY = 'myrpg_player_panel_width';
/** Reserved height (px) for the fixed footer (END TURN + meta row). */
const FOOTER_H = 104;

/** Display info for a class feature button + resource chip. */
export interface PlayerPanelFeature {
  id: string;
  name: string;
  buttonLabel: string;
  buttonColor: string;
  /** Computed label for the resource chip, e.g. "Second Wind: 2/2". null when no chip. */
  resourceChipText: string | null;
}

export interface PlayerPanelActionState {
  mode: CombatMode;
  actionUsed: boolean;
  bonusActionUsed: boolean;
  movesLeft: number;
  moveMode: boolean;
  throwableItems: Array<{ id: string; name: string }>;
  availableActions: AvailableActions;
  mainAttackName: string;
  /** Currently remaining spell slots indexed by level − 1. */
  spellSlots: number[];
  /** Spell id currently being concentrated on, or null. */
  concentratingOn: string | null;
  /** Display name of the concentrated spell (for the chip), or null. */
  concentratingOnName: string | null;
  /** Class features this character knows — used to render class-specific buttons + resource chips. */
  features: PlayerPanelFeature[];
  /** When set, the action area is replaced with a "Select target for: NAME" banner instead of the usual buttons. */
  spellTargetPrompt: { spellName: string; asRitual: boolean } | null;
  /** Resolved status chips — conditions, buffs, ongoing effects affecting
   *  the player right now. Built by GameScene via `buildPlayerStatusChips`
   *  in `client/src/ui/PlayerStatus.ts`. Empty when nothing applies. */
  statusChips: import("./PlayerStatus").PlayerStatusChip[];
  /** Active player-owned summons (Mage Hand, Unseen Servant). The panel
   *  renders one DIRECT button per entry — clicking enters a "click a tile
   *  to move the summon" mode in the GameScene. */
  summons: Array<{ id: string; name: string; spellName: string; costsBonusAction?: boolean }>;
  /** Area-denial gear the player could deploy right now (caltrops, ball
   *  bearings) — resolved id→name from `availableActions.deployableGearIds`.
   *  The panel renders one SET button per entry. */
  deployableGear: Array<{ id: string; name: string }>;
  /** True when a creature is currently selected as the target. The TALK
   *  button needs a target so the line can be routed to a `sayto`. */
  hasSelectedTarget: boolean;
  /** Id of the currently-selected target NPC, or null. Required by the
   *  COMPANION: ATTACK TARGET chip — without it the companion command
   *  has no `targetId` to send. */
  selectedTargetId: string | null;
  /** The companion NPC currently in scope (single-companion assumption
   *  for step 2). Null when the player has no companion on the map.
   *  Drives the COMPANION chip. */
  companion: { npcId: string; displayName: string; currentMode: 'follow' | 'wait' | 'move_to' } | null;
  /** True while the GameScene's companion-move-to mode is active — the
   *  player has pressed "→ POSITION" and the next tile click sends the
   *  move_to command. The chip flips to a "PICK TILE / CANCEL" state
   *  while this is true. */
  companionPickingTile?: boolean;
}

export interface PlayerPanelCallbacks {
  onOpenCharacterSheet: () => void;
  onSearch: () => void;
  onAttack: () => void;
  onThrow: (itemId: string) => void;
  onUseFeature: (featureId: string) => void;
  onDash: () => void;
  onDodge: () => void;
  onDisengage: () => void;
  /** Grapple (US-110) / Shove (US-050) the selected adjacent enemy. */
  onGrapple: () => void;
  onShove: (effect: 'push' | 'prone') => void;
  onDetach: () => void;
  onHide: () => void;
  onDeathSave: () => void;
  onShortRest: () => void;
  onToggleMoveMode: () => void;
  onEndTurn: () => void;
  onLeaveEncounter: () => void;
  onLevelUp: () => void;
  onLongRest: () => void;
  /** Dev-only fast-forward — server fires the encounter completion path
   *  (set completion flag + clear enemies). Only sent when the
   *  `DevMode.completePrimaryObjective` flag is on, which is also what
   *  governs the button's visibility. */
  onDevCompleteObjective: () => void;
  onCommandSummon: (summonNpcId: string) => void;
  /** Open the inline TALK input near the player token so the player can
   *  type a line for the currently-selected target. No-op when no target
   *  is selected — the button greys out in that state. */
  onTalk: () => void;
  /** Open the Character Sheet directly on the Spells tab — wired to the
   *  CAST button above TALK so the player can pick a spell without first
   *  having to open CHARACTER and switch tabs. */
  onOpenSpells: () => void;
  /** Drop the spell currently in `PlayerState.concentratingOn`. Visible
   *  only when concentrating — wired to a small RELEASE button beside the
   *  CAST button. SRD: ending concentration is free, no action cost. */
  onReleaseConcentration: () => void;
  /** Companion command — sent when the player toggles the COMPANION chip.
   *  `npcId` is the companion's id (the panel only shows the chip when
   *  exactly one companion is on the map for now). */
  onCompanionCommand: (npcId: string, command: import('../../../shared/types').CompanionCommand) => void;
  /** Enter companion-move-to mode — the scene paints a cursor overlay
   *  and the next tile click sends a `move_to` companion command. ESC
   *  cancels. The Player Panel only knows about the entry; the scene
   *  owns the targeting mode lifecycle. */
  onCompanionPickTile: (npcId: string) => void;
  /** Attempt to disarm the discovered, armed trap on the given tile. */
  onDisarmTrap: (tileX: number, tileY: number) => void;
  /** Enter deploy-gear targeting mode for the given area-denial item — the
   *  scene paints a placement cursor and the next tile click deploys it. */
  onDeployGear: (itemId: string) => void;
}

/** Which economy bucket an Action Button belongs to. Drives the grouped,
 *  headed layout and what folds under the "⋯ More" expander. */
type ActionGroup = 'action' | 'bonus' | 'move' | 'free' | 'more' | 'companion';

/** Leading glyph per action so the button stack reads at a glance. Keyed by
 *  the full label or its first word. Labels that already begin with a glyph
 *  (★ LEVEL UP, ☾ LONG REST) are left alone — see `iconFor`. */
const ACTION_ICONS: Record<string, string> = {
  ATTACK: '⚔', THROW: '➶', DODGE: '❖', DASH: '»', DISENGAGE: '↩', DETACH: '⤴',
  GRAPPLE: '✊', SHOVE: '🤚', 'SHOVE PRONE': '⤓',
  HIDE: '◐', SEARCH: '⚲', MOVE: '⤧', TALK: '❝', CAST: '✦',
  'SHORT REST': '☕', 'ROLL DEATH SAVE': '☠',
};

function iconFor(label: string): string {
  // Already prefixed with a non-letter glyph (e.g. "★ LEVEL UP") → leave as-is.
  if (label.length > 0 && !/[A-Za-z]/.test(label[0])) return '';
  return ACTION_ICONS[label] ?? ACTION_ICONS[label.split(' ')[0]] ?? '';
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hpColor(pct: number): string {
  return pct > 0.5 ? '#27ae60' : pct > 0.25 ? '#f39c12' : '#e74c3c';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class PlayerPanel {
  private readonly el: HTMLDivElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  /** One unified chip strip: spell slots + feature pools + status chips. */
  private readonly resourcesEl: HTMLElement;
  private readonly objectiveEl: HTMLElement;
  private readonly actionArea: HTMLElement;
  private readonly devCompleteBtn: HTMLButtonElement;
  private readonly endTurnBtn: HTMLButtonElement;
  private readonly leaveBtn: HTMLButtonElement;
  private readonly offResize: () => void;

  private visible = true;
  private pickerOpen = false;
  /** Whether the "⋯ More" group of situational actions is expanded. */
  private moreOpen = false;
  private lastActionState: PlayerPanelActionState | null = null;
  private readonly callbacks: PlayerPanelCallbacks;
  private playerDef: PlayerDef;
  private readonly scale: UIScale;
  private readonly headerSubEl: HTMLElement;

  constructor(scale: UIScale, def: PlayerDef, callbacks: PlayerPanelCallbacks) {
    this.scale = scale;
    this.playerDef = def;
    this.callbacks = callbacks;

    const colorHex = '#' + def.color.toString(16).padStart(6, '0');

    const savedWidth = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? '', 10);
    const initWidth = savedWidth >= PANEL_MIN_WIDTH ? savedWidth : PLAYER_PANEL_WIDTH;

    this.el = document.createElement('div');
    this.el.className = 'gui-panel';
    this.el.style.cssText += `
      width: ${initWidth}px;
      height: ${PANEL_H}px;
      background: #080810;
      border-right: 2px solid #334455;
      color: #aabbcc;
      z-index: 10;
    `;

    this.el.innerHTML = `
      <div style="padding:14px 12px 0;font-size:12px;color:${colorHex};">${def.name}</div>
      <div data-header-sub style="padding:2px 12px 4px;font-size:10px;color:#667788;">${def.speciesName} · ${def.className} ${def.level}</div>
      <div class="gui-sep"></div>

      <div class="gui-label">HP</div>
      <div class="gui-hp-track" style="position:relative;">
        <div class="gui-hp-fill" data-hp-fill></div>
        <div data-hp-text style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#eef4fa;text-shadow:0 1px 2px #000,0 0 2px #000;font-family:monospace;pointer-events:none;"></div>
      </div>

      <div data-resources style="padding:6px 12px 2px;display:none;flex-wrap:wrap;gap:4px;"></div>

      <div class="gui-sep" style="margin-top:2px;"></div>
      <div class="gui-label">OBJECTIVE</div>
      <div data-objective style="padding:2px 12px 6px;font-size:10px;color:#e2b96f;line-height:1.4;">—</div>

      <div class="gui-sep" style="position:absolute;left:8px;right:0;bottom:${FOOTER_H}px;"></div>
      <div data-actions style="position:absolute;left:0;right:0;bottom:${FOOTER_H}px;display:flex;flex-direction:column;gap:3px;padding:0 8px 4px;"></div>

      <div style="position:absolute;bottom:0;left:0;right:0;height:${FOOTER_H}px;display:flex;flex-direction:column;gap:4px;padding:8px;box-sizing:border-box;">
        <button class="gui-btn" style="background:#3a3020;display:none;" data-end-turn>⏭ END TURN</button>
        <button class="gui-btn" style="background:#11202e;color:#9bb3cc;font-size:10px;" data-charsheet>☰ CHARACTER</button>
        <button class="gui-btn" style="background:#2a1616;color:#cc9b9b;font-size:10px;" data-leave-enc>⏏ LEAVE ENCOUNTER</button>
        <button class="gui-btn" style="background:#1a3a1a;color:#bbeeaa;display:none;font-size:10px;" data-dev-complete>★ COMPLETE OBJECTIVE [DEV]</button>
      </div>
    `;

    const ref = (attr: string) => this.el.querySelector(`[data-${attr}]`) as HTMLElement;
    this.hpFill    = ref('hp-fill');
    this.hpText    = ref('hp-text');
    this.resourcesEl = ref('resources');
    this.objectiveEl = ref('objective');
    this.actionArea = ref('actions');
    this.headerSubEl = ref('header-sub');
    this.endTurnBtn = ref('end-turn') as HTMLButtonElement;

    (ref('charsheet') as HTMLButtonElement).onclick = () => callbacks.onOpenCharacterSheet();
    this.leaveBtn = ref('leave-enc') as HTMLButtonElement;
    this.leaveBtn.onclick = () => callbacks.onLeaveEncounter();
    this.endTurnBtn.onclick = () => callbacks.onEndTurn();
    this.devCompleteBtn = ref('dev-complete') as HTMLButtonElement;
    this.devCompleteBtn.onclick = () => callbacks.onDevCompleteObjective();
    // The ★ COMPLETE OBJECTIVE dev button lives in the DevTools panel now.
    // Surface a fallback copy here only when DevTools is hidden, so the
    // player still has a way to trigger it without first enabling the
    // panel from the Configuration scene.
    if (DevMode.completePrimaryObjective && !DevMode.showDevToolsPanel) {
      this.devCompleteBtn.style.display = "block";
    }

    this.el.appendChild(this.buildResizeHandle());

    document.body.appendChild(this.el);
    const place = () => scale.placePanel(this.el, 0, 0);
    place();
    this.offResize = scale.onChange(place);
  }


  /**
   * Replace the cached `PlayerDef` (used after a level-up so the subtitle
   * and `defaultSpellSlots` max-cap re-render with the new level + maxima).
   * Triggers a refresh of the action panel.
   */
  setPlayerDef(def: PlayerDef): void {
    this.playerDef = def;
    this.headerSubEl.textContent = `${def.speciesName} · ${def.className} ${def.level}`;
    if (this.lastActionState) this.refreshActions(this.lastActionState);
  }

  show(): void {
    this.visible = true;
    this.el.style.display = 'block';
    this.el.style.opacity = '1';
    this.el.style.transition = '';
    if (this.lastActionState) this.refreshActions(this.lastActionState);
  }

  hide(): void {
    this.visible = false;
    this.el.style.display = 'none';
    this.el.style.opacity = '1';
    this.el.style.transition = '';
    this.pickerOpen = false;
  }

  /** Fade in over `durationMs` (default 250 ms) and resolve when the
   *  transition completes. Pairs with `fadeOut` so callers can sequence the
   *  panel ahead of / behind another visual (e.g. a focused announcement). */
  fadeIn(durationMs = 250): Promise<void> {
    this.visible = true;
    this.el.style.display = 'block';
    this.el.style.transition = '';
    this.el.style.opacity = '0';
    // Force a reflow so the new transition catches the opacity flip.
    void this.el.offsetWidth;
    this.el.style.transition = `opacity ${durationMs}ms ease-out`;
    this.el.style.opacity = '1';
    if (this.lastActionState) this.refreshActions(this.lastActionState);
    return waitMs(durationMs);
  }

  fadeOut(durationMs = 250): Promise<void> {
    this.visible = false;
    this.el.style.transition = `opacity ${durationMs}ms ease-in`;
    this.el.style.opacity = '0';
    this.pickerOpen = false;
    return waitMs(durationMs).then(() => {
      this.el.style.display = 'none';
    });
  }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  private buildResizeHandle(): HTMLDivElement {
    const handle = document.createElement('div');
    handle.style.cssText = `
      position:absolute;top:0;right:0;width:8px;height:100%;
      cursor:col-resize;z-index:20;
    `;

    let dragging = false;
    let dragStartX = 0;
    let dragStartW = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStartX = e.clientX;
      dragStartW = parseInt(this.el.style.width) || PLAYER_PANEL_WIDTH;
      handle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const newW = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH,
        dragStartW + (e.clientX - dragStartX) / this.scale.factor,
      ));
      this.el.style.width = `${newW}px`;
    });

    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      localStorage.setItem(PANEL_WIDTH_KEY, String(parseInt(this.el.style.width)));
    });

    return handle;
  }

  refresh(hp: number, maxHp: number, objective = ''): void {
    const pct = maxHp > 0 ? hp / maxHp : 0;
    this.hpFill.style.width = `${Math.floor(pct * 100)}%`;
    this.hpFill.style.background = hpColor(pct);
    this.hpText.textContent = `${hp} / ${maxHp}`;

    this.objectiveEl.textContent = objective || '—';
  }

  /** Relabel the exit button to match context. Inside an authored adventure it
   *  reads LEAVE ADVENTURE (and routes back to Adventure Setup); otherwise
   *  LEAVE ENCOUNTER. Called each state tick from the scene's HUD refresh. */
  setInAdventure(inAdventure: boolean): void {
    this.leaveBtn.textContent = inAdventure ? '⏏ LEAVE ADVENTURE' : '⏏ LEAVE ENCOUNTER';
  }

  /** Append DISARM / SET-gear buttons. The server only populates the source
   *  lists when the action is legal right now (reach + action economy), so a
   *  rendered button is always clickable — no manual disable needed. */
  private pushTrapButtons(state: PlayerPanelActionState, into: HTMLButtonElement[]): void {
    for (const tile of state.availableActions.disarmableTrapTiles) {
      into.push(this.makeBtn('DISARM TRAP', '#5a2a1a', () => this.callbacks.onDisarmTrap(tile.x, tile.y)));
    }
    for (const gear of state.deployableGear) {
      into.push(this.makeBtn(`SET ${gear.name.toUpperCase()}`, '#4a3a1a', () => this.callbacks.onDeployGear(gear.id)));
    }
  }

  refreshActions(state: PlayerPanelActionState): void {
    this.lastActionState = state;
    this.actionArea.innerHTML = '';
    this.endTurnBtn.style.display = state.mode === 'player_turn' ? 'block' : 'none';

    // Unified resource strip: spell slots + feature pools + status chips.
    this.renderResources(state);

    if (!this.visible) return;

    // Spell-targeting mode replaces all action buttons with a guidance banner.
    // The Game Scene owns the actual click handling; this is purely the prompt.
    if (state.spellTargetPrompt) {
      const banner = document.createElement('div');
      const ritualSuffix = state.spellTargetPrompt.asRitual ? ' (ritual)' : '';
      banner.style.cssText = `padding:14px 12px;font-size:11px;color:#c8dae8;text-align:center;
        background:#0a1a2a;border:1px solid #2a4a6a;line-height:1.5;margin:0 8px;`;
      banner.innerHTML = `Select target for:<br/><span style="color:#7aadcc;font-size:12px;">${escHtml(state.spellTargetPrompt.spellName)}${escHtml(ritualSuffix)}</span><br/><span style="color:#556677;font-size:10px;">Click a creature, or press ESC to cancel.</span>`;
      this.actionArea.appendChild(banner);
      return;
    }

    if (this.pickerOpen) {
      this.renderPicker();
      return;
    }

    // Buttons are collected into economy buckets and rendered grouped (with
    // headers in combat). Situational utilities fold under a "⋯ More" expander;
    // context-only buttons (TALK with no target, CAST for non-casters, RELEASE
    // when not concentrating) are omitted rather than shown greyed.
    const groups: Record<ActionGroup, HTMLButtonElement[]> = {
      action: [], bonus: [], move: [], free: [], more: [], companion: [],
    };
    const { mode, actionUsed, movesLeft, moveMode, availableActions: aa } = state;

    // Cunning Action (Rogue L2+): Dash / Disengage / Hide spend a Bonus Action,
    // so they read BLUE and live in the BONUS group instead of ACTION.
    const hasCunningAction = (this.playerDef.defaultFeatureIds ?? []).includes('cunning-action');
    const BONUS_BLUE = '#1a3a5a';

    if (mode === 'exploring') {
      const GREEN = '#1a4a1e';
      const atk = this.makeTwoLineBtn('ATTACK', state.mainAttackName, GREEN, aa.canAttack ? this.callbacks.onAttack : () => {});
      atk.disabled = !aa.canAttack;
      groups.action.push(atk);

      if (state.throwableItems.length > 0) {
        groups.action.push(this.makeBtn('THROW', GREEN, () => { this.pickerOpen = true; this.refreshActions(state); }));
      }

      // Free utilities during exploration → tucked under More.
      const search = this.makeBtn('SEARCH', GREEN, this.callbacks.onSearch);
      search.disabled = !aa.canSearch;
      groups.more.push(search);
      if (aa.canHide) groups.more.push(this.makeBtn('HIDE', hasCunningAction ? BONUS_BLUE : '#1a3a1a', this.callbacks.onHide));
      this.pushTrapButtons(state, groups.more);
      if (aa.canShortRest) groups.more.push(this.makeBtn('SHORT REST', '#1a2a3a', this.callbacks.onShortRest));
      for (const summon of state.summons) {
        groups.more.push(this.makeBtn(`DIRECT ${summon.name.toUpperCase()}`, '#2a3a55', () => this.callbacks.onCommandSummon(summon.id)));
      }
      if (aa.canLevelUp) groups.more.push(this.makeBtn('★ LEVEL UP', '#3a2a5a', this.callbacks.onLevelUp));
      if (aa.canLongRest) groups.more.push(this.makeBtn('☾ LONG REST', '#1a2a4a', this.callbacks.onLongRest));

      groups.move.push(this.makeBtn('MOVE', moveMode ? '#5a4800' : '#3a3000', this.callbacks.onToggleMoveMode));

      if (state.hasSelectedTarget) groups.free.push(this.makeBtn('TALK', '#1a3a4a', this.callbacks.onTalk));
      if (this.playerDef.spellcastingAbility) groups.free.push(this.makeBtn('CAST', '#1a3a4a', this.callbacks.onOpenSpells));
      if (state.concentratingOn) groups.free.push(this.makeReleaseBtn(state));

    } else if (mode === 'player_turn') {
      const GREEN = '#1a4a1e';
      const dashDisColor = hasCunningAction ? BONUS_BLUE : GREEN;
      const econ = (): HTMLButtonElement[] => (hasCunningAction ? groups.bonus : groups.action);

      const atk = this.makeTwoLineBtn('ATTACK', state.mainAttackName, GREEN, aa.canAttack ? this.callbacks.onAttack : () => {});
      atk.disabled = !aa.canAttack;
      groups.action.push(atk);

      if (state.throwableItems.length > 0) {
        const th = this.makeBtn('THROW', GREEN, !actionUsed ? () => { this.pickerOpen = true; this.refreshActions(state); } : () => {});
        th.disabled = actionUsed;
        groups.action.push(th);
      }

      const dod = this.makeBtn('DODGE', GREEN, this.callbacks.onDodge);
      dod.disabled = actionUsed;
      groups.action.push(dod);

      const dash = this.makeBtn('DASH', dashDisColor, this.callbacks.onDash);
      dash.disabled = !aa.canDash;
      econ().push(dash);

      const dis = this.makeBtn('DISENGAGE', dashDisColor, this.callbacks.onDisengage);
      dis.disabled = !aa.canDisengage;
      econ().push(dis);

      // SRD Unarmed Strike options (US-110 Grapple / US-050 Shove). The server
      // populates the target lists only when an adjacent, size-eligible enemy
      // exists and the Action is free, so a rendered button is always usable.
      if (aa.grappleableTargetIds.length > 0) {
        groups.action.push(this.makeBtn('GRAPPLE', GREEN, this.callbacks.onGrapple));
      }
      if (aa.shoveableTargetIds.length > 0) {
        groups.action.push(this.makeBtn('SHOVE', GREEN, () => this.callbacks.onShove('push')));
        groups.action.push(this.makeBtn('SHOVE PRONE', GREEN, () => this.callbacks.onShove('prone')));
      }

      if (aa.canDetach) groups.action.push(this.makeBtn('DETACH', GREEN, this.callbacks.onDetach));

      // Class-specific features — the server's `usableFeatureIds` decides which
      // are clickable; the rest grey out.
      const usable = new Set(aa.usableFeatureIds);
      for (const feat of state.features) {
        if (!feat.buttonLabel) continue;
        const f = this.makeBtn(feat.buttonLabel, feat.buttonColor, () => this.callbacks.onUseFeature(feat.id));
        f.disabled = !usable.has(feat.id);
        groups.action.push(f);
      }

      // Player-owned summons. Flaming Sphere costs a Bonus Action (→ bonus group).
      for (const summon of state.summons) {
        const s = this.makeBtn(`DIRECT ${summon.name.toUpperCase()}`, '#2a3a55', () => this.callbacks.onCommandSummon(summon.id));
        s.disabled = summon.costsBonusAction ? state.bonusActionUsed : actionUsed;
        (summon.costsBonusAction ? groups.bonus : groups.action).push(s);
      }

      if (aa.canHide) econ().push(this.makeBtn('HIDE', hasCunningAction ? BONUS_BLUE : '#1a3a1a', this.callbacks.onHide));

      const search = this.makeBtn('SEARCH', GREEN, this.callbacks.onSearch);
      search.disabled = !aa.canSearch;
      groups.action.push(search);

      this.pushTrapButtons(state, groups.action);

      const move = this.makeBtn('MOVE', moveMode ? '#5a4800' : '#3a3000', this.callbacks.onToggleMoveMode);
      move.disabled = movesLeft <= 0;
      groups.move.push(move);

      if (state.hasSelectedTarget) groups.free.push(this.makeBtn('TALK', '#1a3a4a', this.callbacks.onTalk));
      if (this.playerDef.spellcastingAbility) groups.free.push(this.makeBtn('CAST', '#1a3a4a', this.callbacks.onOpenSpells));
      if (state.concentratingOn) groups.free.push(this.makeReleaseBtn(state));

    } else if (mode === 'death_saves') {
      groups.action.push(this.makeBtn('ROLL DEATH SAVE', '#5a1a1a', this.callbacks.onDeathSave));
    }

    this.collectCompanionChips(state, groups.companion);
    this.renderGroups(groups, mode === 'player_turn');
  }

  /** RELEASE-concentration button (free action). */
  private makeReleaseBtn(state: PlayerPanelActionState): HTMLButtonElement {
    const label = state.concentratingOnName
      ? `RELEASE ${state.concentratingOnName.toUpperCase()}`
      : 'RELEASE CONCENTRATION';
    return this.makeBtn(label, '#3a2a4a', this.callbacks.onReleaseConcentration);
  }

  /** Push the companion chip(s) into the companion group. Exploration shows a
   *  FOLLOW/WAIT toggle + a "→ POSITION" tile-pick chip; combat shows an
   *  ATTACK-TARGET chip (or a dim "select a target" hint). */
  private collectCompanionChips(state: PlayerPanelActionState, out: HTMLButtonElement[]): void {
    const companion = state.companion;
    if (!companion) return;
    const name = companion.displayName.toUpperCase();

    if (state.mode === 'exploring') {
      const label = companion.currentMode === 'wait'
        ? `${name}: WAIT`
        : companion.currentMode === 'move_to'
          ? `${name}: MOVING…`
          : `${name}: FOLLOW`;
      const color = companion.currentMode === 'wait' ? '#3a3a4a'
        : companion.currentMode === 'move_to' ? '#2a3a55'
          : '#1a3a3a';
      out.push(this.makeBtn(label, color, () => {
        // Toggle wait ↔ follow; MOVE TO is one-shot via the POSITION chip, so
        // tapping the status chip while moving cancels back to FOLLOW.
        const nextCommand = companion.currentMode === 'wait'
          ? { kind: 'follow' as const, mode: 'loose' as const }
          : companion.currentMode === 'move_to'
            ? { kind: 'follow' as const, mode: 'loose' as const }
            : { kind: 'wait' as const };
        this.callbacks.onCompanionCommand(companion.npcId, nextCommand);
      }));

      if (state.companionPickingTile) {
        out.push(this.makeBtn(`${name}: PICK TILE — ESC TO CANCEL`, '#3a2a55', () => this.callbacks.onCompanionPickTile(companion.npcId)));
      } else {
        out.push(this.makeBtn(`${name}: → POSITION`, '#2a2a3a', () => this.callbacks.onCompanionPickTile(companion.npcId)));
      }
    } else if (state.mode === 'player_turn') {
      const targetId = state.selectedTargetId;
      if (targetId) {
        out.push(this.makeBtn(`${name}: ATTACK TARGET`, '#5a2a2a', () => {
          this.callbacks.onCompanionCommand(companion.npcId, { kind: 'attack', targetId });
        }));
      } else {
        const dim = this.makeBtn(`${name} — SELECT A TARGET`, '#2a2a2a', () => {});
        dim.disabled = true;
        out.push(dim);
      }
    }
  }

  /** Lay the collected groups into the action area, top → bottom: ACTION,
   *  BONUS, MOVE, FREE, the collapsible MORE, then COMPANION. Economy headers
   *  only show in combat (`showEconomy`); exploration stays header-light. */
  private renderGroups(groups: Record<ActionGroup, HTMLButtonElement[]>, showEconomy: boolean): void {
    const header = (text: string): HTMLElement => {
      const h = document.createElement('div');
      h.textContent = text;
      h.style.cssText = 'font-size:9px;letter-spacing:1.5px;color:#556677;padding:5px 2px 0;';
      return h;
    };

    if (groups.action.length > 0) {
      if (showEconomy && (groups.bonus.length > 0 || groups.action.length > 1)) this.actionArea.appendChild(header('ACTION'));
      for (const el of groups.action) this.actionArea.appendChild(el);
    }
    if (groups.bonus.length > 0) {
      if (showEconomy) this.actionArea.appendChild(header('BONUS ACTION'));
      for (const el of groups.bonus) this.actionArea.appendChild(el);
    }
    for (const el of groups.move) this.actionArea.appendChild(el);
    for (const el of groups.free) this.actionArea.appendChild(el);

    if (groups.more.length > 0) {
      const toggle = document.createElement('button');
      toggle.className = 'gui-btn';
      toggle.style.cssText = 'background:#15151f;color:#8899aa;font-size:10px;margin-bottom:0;';
      toggle.textContent = this.moreOpen ? '⋯ LESS' : `⋯ MORE (${groups.more.length})`;
      toggle.onclick = () => {
        this.moreOpen = !this.moreOpen;
        if (this.lastActionState) this.refreshActions(this.lastActionState);
      };
      this.actionArea.appendChild(toggle);
      if (this.moreOpen) for (const el of groups.more) this.actionArea.appendChild(el);
    }

    for (const el of groups.companion) this.actionArea.appendChild(el);
  }

  /** Build the unified resource strip: spell slots, feature pools, and status
   *  chips (conditions / buffs / concentration) on one wrap-flow row, each with
   *  a hover tooltip. Hidden when nothing applies. */
  private renderResources(state: PlayerPanelActionState): void {
    this.resourcesEl.replaceChildren();
    const chip = (label: string, bg: string, border: string, text: string, tooltip?: string): void => {
      const s = document.createElement('span');
      s.textContent = label;
      if (tooltip) s.title = tooltip;
      s.style.cssText = `background:${bg};color:${text};border:1px solid ${border};padding:1px 6px;font-size:9px;line-height:1.5;white-space:nowrap;`;
      this.resourcesEl.appendChild(s);
    };

    // Spell slots — one chip per tier the character has.
    const maxSlots = this.playerDef.defaultSpellSlots ?? [];
    for (let i = 0; i < maxSlots.length; i++) {
      if (maxSlots[i] > 0) {
        chip(`◆ L${i + 1} ${state.spellSlots[i] ?? 0}/${maxSlots[i]}`, '#10202e', '#2a4a66', '#8eb8e0', `Level ${i + 1} spell slots`);
      }
    }
    // Class-feature resource pools (Second Wind, Rage, Channel Divinity, …).
    for (const f of state.features) {
      if (f.resourceChipText) chip(f.resourceChipText, '#1a1830', '#3a3060', '#b8a8e8', f.name);
    }
    // Conditions / buffs / ongoing effects / concentration.
    for (const c of state.statusChips ?? []) {
      const p = STATUS_TONE_COLOR[c.tone];
      chip(c.label, p.bg, p.border, p.text, c.tooltip);
    }

    this.resourcesEl.style.display = this.resourcesEl.childElementCount > 0 ? 'flex' : 'none';
  }

  private renderPicker(): void {
    const items = this.lastActionState!.throwableItems.slice(0, MAX_PICKER_SLOTS);
    for (const item of items) {
      this.actionArea.appendChild(this.makeBtn(item.name, '#1e2e1e', () => {
        this.pickerOpen = false;
        this.callbacks.onThrow(item.id);
        if (this.lastActionState) this.refreshActions(this.lastActionState);
      }, '10px'));
    }
    this.actionArea.appendChild(this.makeBtn('↩ CANCEL', '#2a1a1a', () => {
      this.pickerOpen = false;
      if (this.lastActionState) this.refreshActions(this.lastActionState);
    }));
  }

  private makeBtn(label: string, bg: string, onClick: () => void, fontSize = '11px'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'gui-btn';
    const icon = iconFor(label);
    b.textContent = icon ? `${icon}  ${label}` : label;
    b.style.background = bg;
    b.style.fontSize = fontSize;
    b.style.marginBottom = '0';
    b.onclick = onClick;
    return b;
  }

  /**
   * Two-line button: primary label on top, smaller subtitle in parentheses below.
   * Used for ATTACK so the player sees which weapon will resolve the swing.
   */
  private makeTwoLineBtn(label: string, subtitle: string, bg: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'gui-btn';
    b.style.background = bg;
    b.style.fontSize = '11px';
    b.style.marginBottom = '0';
    b.style.height = '42px';
    b.style.whiteSpace = 'normal';
    b.style.lineHeight = '1.2';
    b.style.padding = '4px 0';
    const icon = iconFor(label);
    b.innerHTML = `${icon ? icon + ' ' : ''}${escHtml(label)}<br><span style="font-size:9px;color:#bbccdd;opacity:0.85;">(${escHtml(subtitle)})</span>`;
    b.onclick = onClick;
    return b;
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
