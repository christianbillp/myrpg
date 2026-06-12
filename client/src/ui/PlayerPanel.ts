import { PLAYER_PANEL_WIDTH, GRID_ROWS, TILE_SIZE, HUD_HEIGHT } from '../constants';
import { PlayerDef } from '../../../shared/types';
import { AvailableActions, CombatMode } from '../../../shared/types';
import { UIScale } from './UIScale';
import { STATUS_TONE_COLOR } from './PlayerStatus';
import { DevMode } from '../devMode';
import { actionIdForLabel, glyphForActionId, readHiddenActions, readCompactView } from './actionPanelPrefs';
import { PanelSetupOverlay } from './PanelSetupOverlay';
import { splitGameplayTips, escapeTipHtml, TIP_COLOR, TIP_GLYPH } from './gameplayTips';

const GRID_H   = GRID_ROWS * TILE_SIZE;
const PANEL_H  = GRID_H + HUD_HEIGHT;
const MAX_PICKER_SLOTS = 6;
const PANEL_MIN_WIDTH = 120;
const PANEL_MAX_WIDTH = 480;
/** Diameter (game units) of the floating round END TURN button. */
const END_TURN_BTN = 64;
const PANEL_WIDTH_KEY = 'myrpg_player_panel_width';
/** Reserved height (px) for the footer — now just the centered Panel Setup
 *  button. END TURN floats over the map, LEAVE ENCOUNTER moved to DevTools,
 *  and CHARACTER SHEET lives in the top section. No divider above it. */
const FOOTER_H = 48;

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
  /** SRD Knocking Out (US-052): true while KNOCK OUT (non-lethal melee) mode is on. */
  nonLethal: boolean;
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
  /** Spells the player added to the quickcast menu (Character Sheet → Spells),
   *  filtered to ones the character currently knows. `castable` mirrors the
   *  engine's gate so the panel greys out spells that can't be cast right now.
   *  The CAST button opens this menu. */
  quickcastSpells: Array<{ id: string; name: string; castable: boolean }>;
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
  /** Open the Quest Log overlay — wired to the OBJECTIVE line. */
  onOpenQuestLog: () => void;
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
  /** Toggle KNOCK OUT (non-lethal melee, US-052). */
  onToggleNonLethal: (on: boolean) => void;
  /** Help — Assist an Attack (US-057): distract the adjacent enemy. */
  onHelp: () => void;
  /** Ready an attack (US-057): strike an enemy that closes into reach. */
  onReady: () => void;
  /** Study / Utilize / Influence / Magic (US-057): prime the GM chat for adjudication. */
  onActionPrompt: (kind: 'study' | 'utilize' | 'influence' | 'magic') => void;
  /** Study an authored feature tile: enters a tile picker gated to ≤1 tile,
   *  prompting the player to move closer if they pick it from too far. */
  onStudyFeature: () => void;
  /** The Magic action on an authored rite tile (the keystone): same range-gated
   *  picker as Study; performs the tile's rite. */
  onMagicFeature: () => void;
  /** Attune to a magic item (US-124). */
  onAttune: (itemId: string) => void;
  onDetach: () => void;
  /** Escape a monster grapple — Athletics/Acrobatics vs the escape DC (US-125). */
  onEscape: () => void;
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
  /** Toggle the DevTools overlay (only wired when `DevMode.showDevToolsPanel`).
   *  Fired by the small dev button beside the Panel Setup ⚙ in the footer. */
  onToggleDevTools: () => void;
  /** Open the inline TALK input near the player token so the player can
   *  type a line for the currently-selected target. No-op when no target
   *  is selected — the button greys out in that state. */
  onTalk: () => void;
  /** Open the Character Sheet directly on the Spells tab — used by the
   *  quickcast menu's "MANAGE SPELLS" button so the player can add spells. */
  onOpenSpells: () => void;
  /** Begin casting a specific spell (enters the targeting flow) — wired to the
   *  quickcast menu entries. Same path as the Character Sheet's CAST button. */
  onCastSpell: (spellId: string) => void;
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

/** Leading glyph per action so the button stack reads at a glance. Keyed by
 *  the full label or its first word. Labels that already begin with a glyph
 *  (★ LEVEL UP, ☾ LONG REST) are left alone — see `iconFor`. */
const ACTION_ICONS: Record<string, string> = {
  ATTACK: '⚔', THROW: '➶', DODGE: '❖', DASH: '»', DISENGAGE: '↩', DETACH: '⤴',
  GRAPPLE: '✊', SHOVE: '🤚', 'SHOVE PRONE': '⤓', ATTUNE: '✶', IDENTIFY: '🔎', 'KNOCK OUT': '☄', HELP: '🤝', READY: '⏳', STUDY: '📖', UTILIZE: '🛠', INFLUENCE: '💬',
  HIDE: '◐', SEARCH: '⚲', MOVE: '⤧', TALK: '❝', CAST: '✦', MAGIC: '🪄',
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
  /** The ⚙ Panel Setup toggle button — re-styled to show whether its overlay is open. */
  private readonly setupBtn: HTMLButtonElement;
  /** The live Panel Setup overlay, or null when closed. Drives the toggle. */
  private setupOverlay: PanelSetupOverlay | null = null;
  /** Floating round END TURN button over the lower-left of the map (combat only). */
  private readonly endTurnFloatBtn: HTMLButtonElement;
  private readonly offResize: () => void;

  private visible = true;
  private pickerOpen = false;
  /** Whether the CAST quickcast menu is open (replaces the action stack). */
  private quickcastOpen = false;
  private lastActionState: PlayerPanelActionState | null = null;
  /** Action-button ids the player chose to hide (Panel Setup). Cached so
   *  `appendVisible` doesn't re-read localStorage per button; refreshed when the
   *  Panel Setup Overlay reports a change. */
  private hiddenActions: Set<string> = readHiddenActions();
  /** Compact View (Panel Setup → Configuration): icon-only square buttons. */
  private compactView: boolean = readCompactView();
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
      <div style="display:flex;align-items:center;gap:8px;padding:14px 12px 0;">
        <button class="gui-btn" data-charsheet title="Character Sheet" style="width:26px;height:26px;font-size:13px;padding:0;margin:0;flex:none;display:flex;align-items:center;justify-content:center;line-height:1;background:#11202e;color:#9bb3cc;">☰</button>
        <div style="flex:1;min-width:0;font-size:12px;color:${colorHex};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${def.name}</div>
      </div>
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

      <div data-actions style="position:absolute;left:0;right:0;bottom:${FOOTER_H}px;display:flex;flex-direction:column;gap:3px;padding:0 8px 4px;"></div>

      <div class="gui-sep" style="position:absolute;left:8px;right:8px;bottom:${FOOTER_H}px;"></div>
      <div style="position:absolute;bottom:0;left:0;right:0;height:${FOOTER_H}px;display:flex;justify-content:center;align-items:flex-end;padding:0 8px 8px;box-sizing:border-box;">
        <button class="gui-btn" data-panel-setup title="Player Panel setup" style="background:#11202e;color:#9bb3cc;width:36px;height:36px;font-size:16px;padding:0;margin:0;display:flex;align-items:center;justify-content:center;line-height:1;">⚙</button>
      </div>
      <!-- Dev-only toggle — absolutely positioned in the bottom-left corner so it
           never shifts the centered Panel Setup ⚙ (see CLAUDE.md dev-button rule). -->
      <button class="gui-btn" data-dev-toggle title="Toggle Dev Tools overlay" style="position:absolute;left:8px;bottom:8px;background:#1a1020;color:#cc88cc;border:1px solid #663366;width:30px;height:30px;font-size:13px;padding:0;margin:0;align-items:center;justify-content:center;line-height:1;display:none;">⚒</button>
    `;

    const ref = (attr: string) => this.el.querySelector(`[data-${attr}]`) as HTMLElement;
    this.hpFill    = ref('hp-fill');
    this.hpText    = ref('hp-text');
    this.resourcesEl = ref('resources');
    this.objectiveEl = ref('objective');
    this.actionArea = ref('actions');
    this.headerSubEl = ref('header-sub');

    (ref('charsheet') as HTMLButtonElement).onclick = () => callbacks.onOpenCharacterSheet();
    this.setupBtn = ref('panel-setup') as HTMLButtonElement;
    this.setupBtn.onclick = () => this.openPanelSetup();
    // The OBJECTIVE line opens the Quest Log.
    this.objectiveEl.style.cursor = 'pointer';
    this.objectiveEl.title = 'Open Quest Log';
    this.objectiveEl.onclick = () => callbacks.onOpenQuestLog();
    this.objectiveEl.addEventListener('mouseenter', () => { this.objectiveEl.style.textDecoration = 'underline'; });
    this.objectiveEl.addEventListener('mouseleave', () => { this.objectiveEl.style.textDecoration = 'none'; });
    // Dev-tools toggle — only shown when DevTools is enabled in the main config.
    const devToggle = ref('dev-toggle') as HTMLButtonElement;
    if (DevMode.showDevToolsPanel) {
      devToggle.style.display = 'flex';
      devToggle.onclick = () => callbacks.onToggleDevTools();
    }

    // Floating round END TURN button — sits at the lower-left of the map, a
    // fixed distance from the (resizable) Player Panel's right edge. Visible
    // only on the player's combat turn; positioned by `placeEndTurn`.
    this.endTurnFloatBtn = document.createElement('button');
    this.endTurnFloatBtn.title = 'End your turn';
    this.endTurnFloatBtn.innerHTML = 'END<br>TURN';
    const etb = this.endTurnFloatBtn;
    const ET_SHADOW = '0 2px 6px rgba(0,0,0,0.55)';
    const ET_GLOW = '0 0 16px rgba(255,233,168,0.75)';
    etb.style.cssText = `
      position:absolute; transform-origin:top left; z-index:11; display:none;
      width:${END_TURN_BTN}px; height:${END_TURN_BTN}px; border-radius:50%;
      background:#3a3020; color:#ffe9a8; border:2px solid #6a5a30;
      font-family:monospace; font-size:12px; line-height:1.15; text-align:center;
      align-items:center; justify-content:center; cursor:pointer;
      box-shadow:${ET_SHADOW}; transition:filter 0.08s, box-shadow 0.1s, background 0.1s, border-color 0.1s;`;
    // Hover + press feedback so a click reads clearly (the button vanishes once
    // the turn ends, so the cue has to be immediate).
    const etReset = () => { etb.style.filter = ''; etb.style.boxShadow = ET_SHADOW; etb.style.background = '#3a3020'; etb.style.borderColor = '#6a5a30'; };
    etb.addEventListener('mouseenter', () => { etb.style.filter = 'brightness(1.2)'; etb.style.boxShadow = ET_GLOW; etb.style.background = '#4a4028'; etb.style.borderColor = '#caa84a'; });
    etb.addEventListener('mouseleave', etReset);
    etb.addEventListener('pointerdown', () => { etb.style.filter = 'brightness(0.8)'; etb.style.boxShadow = `inset 0 0 10px rgba(0,0,0,0.6)`; });
    etb.addEventListener('pointerup', () => { etb.style.filter = 'brightness(1.35)'; etb.style.boxShadow = ET_GLOW; });
    etb.onclick = () => callbacks.onEndTurn();
    document.body.appendChild(this.endTurnFloatBtn);

    this.el.appendChild(this.buildResizeHandle());

    document.body.appendChild(this.el);
    const place = () => { scale.placePanel(this.el, 0, 0); this.placeEndTurn(); };
    place();
    this.offResize = scale.onChange(place);
  }

  /** Position the floating END TURN button at the bottom of the screen, a fixed
   *  gap to the right of the Player Panel's current (resizable) right edge. */
  private placeEndTurn(): void {
    const w = parseInt(this.el.style.width) || PLAYER_PANEL_WIDTH;
    this.scale.placePanel(this.endTurnFloatBtn, w + 16, PANEL_H - END_TURN_BTN - 16);
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
      this.placeEndTurn();  // keep the floating END TURN button a fixed gap away
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

    this.setObjectiveText(objective);
  }

  /** Render the objective immersive-first: the in-character text in the gold
   *  OBJECTIVE colour, with any `[[TIP: …]]` gameplay hint pulled out and shown
   *  beneath as a clearly out-of-character tip. */
  private setObjectiveText(objective: string): void {
    if (!objective) { this.objectiveEl.textContent = '—'; return; }
    const { body, tips } = splitGameplayTips(objective);
    let html = escapeTipHtml(body);
    for (const tip of tips) {
      html += `<div style="margin-top:3px;color:${TIP_COLOR};font-style:italic;">${TIP_GLYPH} ${escapeTipHtml(tip)}</div>`;
    }
    this.objectiveEl.innerHTML = html;
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
    // Floating round END TURN button — shown only on the player's combat turn.
    this.placeEndTurn();
    this.endTurnFloatBtn.style.display = state.mode === 'player_turn' ? 'flex' : 'none';
    // Compact View lays the buttons out as a wrapping row of icon-only squares;
    // the throw picker and quickcast menu stay full-width (names must be readable).
    const compact = this.compactView && !this.pickerOpen && !this.quickcastOpen;
    this.actionArea.style.flexFlow = compact ? 'row wrap' : 'column nowrap';
    this.actionArea.style.gap = compact ? '4px' : '3px';

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

    if (this.quickcastOpen) {
      this.renderQuickcastMenu(state);
      return;
    }

    if (state.mode === 'death_saves') {
      this.appendVisible([this.makeBtn('ROLL DEATH SAVE', '#5a1a1a', this.callbacks.onDeathSave)]);
      return;
    }

    // Exploration and combat render the SAME buttons in the SAME order — each is
    // simply enabled or greyed for the current mode + availability — so nothing
    // shifts position between the two. Companion chips append last.
    const buttons = this.buildActionButtons(state);
    this.collectCompanionChips(state, buttons);
    this.appendVisible(buttons);
  }

  /** Append buttons, dropping any the player hid via Panel Setup (by stable
   *  `data-action-id`). Buttons without an id (e.g. ROLL DEATH SAVE, companion
   *  chips) are never filtered. */
  private appendVisible(btns: HTMLButtonElement[]): void {
    for (const b of btns) {
      const id = b.dataset.actionId;
      if (id && this.hiddenActions.has(id)) continue;
      this.actionArea.appendChild(b);
    }
  }

  /** Build the unified, fixed-order Action Button list — identical in
   *  exploration and combat so buttons keep their position; each is enabled or
   *  greyed for the current mode + availability. Build-/state-gated buttons
   *  (CAST for non-casters, RELEASE when not concentrating) and entity-driven
   *  ones (summons, traps, gear) appear only when they apply, independent of
   *  mode. */
  private buildActionButtons(state: PlayerPanelActionState): HTMLButtonElement[] {
    const { mode, actionUsed, movesLeft, moveMode, availableActions: aa } = state;
    const combat = mode === 'player_turn';
    const GREEN = '#1a4a1e', TEAL = '#1a3a4a';
    // Cunning Action (Rogue L2+): Dash / Disengage / Hide read bonus-action blue.
    const hasCunningAction = (this.playerDef.defaultFeatureIds ?? []).includes('cunning-action');
    const BLUE = hasCunningAction ? '#1a3a5a' : GREEN;
    const out: HTMLButtonElement[] = [];
    const add = (b: HTMLButtonElement, disabled: boolean): void => { b.disabled = disabled; out.push(b); };

    const atk = this.makeTwoLineBtn('ATTACK', state.mainAttackName, GREEN, aa.canAttack ? this.callbacks.onAttack : () => {});
    add(atk, !aa.canAttack);
    add(this.makeBtn('THROW', GREEN, () => { this.pickerOpen = true; this.refreshActions(state); }),
      state.throwableItems.length === 0 || (combat && actionUsed));
    add(this.makeBtn('DODGE', GREEN, this.callbacks.onDodge), !(combat && !actionUsed));
    add(this.makeBtn('DASH', BLUE, this.callbacks.onDash), !aa.canDash);
    add(this.makeBtn('DISENGAGE', BLUE, this.callbacks.onDisengage), !aa.canDisengage);
    add(this.makeBtn('GRAPPLE', GREEN, this.callbacks.onGrapple), aa.grappleableTargetIds.length === 0);
    add(this.makeBtn('SHOVE', GREEN, () => this.callbacks.onShove('push')), aa.shoveableTargetIds.length === 0);
    add(this.makeBtn('SHOVE PRONE', GREEN, () => this.callbacks.onShove('prone')), aa.shoveableTargetIds.length === 0);
    add(this.makeBtn('HELP', GREEN, this.callbacks.onHelp), !aa.canHelp);
    add(this.makeBtn('READY', GREEN, this.callbacks.onReady), !aa.canReady);
    add(this.makeBtn('DETACH', GREEN, this.callbacks.onDetach), !aa.canDetach);
    add(this.makeBtn('ESCAPE', GREEN, this.callbacks.onEscape), !aa.canEscapeGrapple);
    add(this.makeBtn('KNOCK OUT', state.nonLethal ? '#5a4800' : '#2a2a1a', () => this.callbacks.onToggleNonLethal(!state.nonLethal)), !combat);
    add(this.makeBtn('HIDE', BLUE, this.callbacks.onHide), !aa.canHide);
    add(this.makeBtn('SEARCH', GREEN, this.callbacks.onSearch), !aa.canSearch);
    add(this.makeBtn('MOVE', moveMode ? '#5a4800' : '#3a3000', this.callbacks.onToggleMoveMode), combat && movesLeft <= 0);
    add(this.makeBtn('TALK', TEAL, this.callbacks.onTalk), !state.hasSelectedTarget);
    // CAST opens the in-panel quickcast menu (the spells the player added from
    // the Character Sheet), mirroring the throw picker.
    if (this.playerDef.spellcastingAbility) add(this.makeBtn('CAST', TEAL, () => { this.quickcastOpen = true; this.refreshActions(state); }), false);

    // Class features (character-specific) — greyed when not currently usable.
    const usable = new Set(aa.usableFeatureIds);
    for (const feat of state.features) {
      if (!feat.buttonLabel) continue;
      const f = this.makeBtn(feat.buttonLabel, feat.buttonColor, () => this.callbacks.onUseFeature(feat.id));
      f.dataset.actionId = 'feature';  // all class-feature buttons share one Panel Setup toggle
      add(f, !usable.has(feat.id));
    }
    // Player-owned summons (entity-driven). Bonus-action summons gate on the
    // bonus action; the rest on the action (in combat only).
    for (const summon of state.summons) {
      add(this.makeBtn(`DIRECT ${summon.name.toUpperCase()}`, '#2a3a55', () => this.callbacks.onCommandSummon(summon.id)),
        summon.costsBonusAction ? state.bonusActionUsed : (combat && actionUsed));
    }
    this.pushTrapButtons(state, out);                       // DISARM TRAP / SET <gear>
    if (state.concentratingOn) out.push(this.makeReleaseBtn(state));

    add(this.makeBtn('STUDY', '#1a2a3a', () => {
      // With an authored study point in the encounter, STUDY targets a tile
      // (move-closer gating); otherwise it primes the GM chat for free-form study.
      if (aa.studyPointTiles && aa.studyPointTiles.length > 0) this.callbacks.onStudyFeature();
      else this.callbacks.onActionPrompt('study');
    }), false);
    add(this.makeBtn('UTILIZE', '#1a2a3a', () => this.callbacks.onActionPrompt('utilize')), false);
    add(this.makeBtn('INFLUENCE', '#1a2a3a', () => this.callbacks.onActionPrompt('influence')), false);
    add(this.makeBtn('MAGIC', '#1a2a3a', () => {
      // With an authored rite point (the keystone) in reach, MAGIC targets a tile
      // (move-closer gating); otherwise it primes the GM chat for free-form magic.
      if (aa.magicPointTiles && aa.magicPointTiles.length > 0) this.callbacks.onMagicFeature();
      else this.callbacks.onActionPrompt('magic');
    }), false);
    add(this.makeBtn('SHORT REST', '#1a2a3a', this.callbacks.onShortRest), !aa.canShortRest);
    add(this.makeBtn('ATTUNE', '#2a2a5a', () => { if (aa.attunableItemIds[0]) this.callbacks.onAttune(aa.attunableItemIds[0]); }), aa.attunableItemIds.length === 0);
    add(this.makeBtn('★ LEVEL UP', '#3a2a5a', this.callbacks.onLevelUp), !aa.canLevelUp);
    add(this.makeBtn('☾ LONG REST', '#1a2a4a', this.callbacks.onLongRest), !aa.canLongRest);
    return out;
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

  /** The CAST quickcast menu — the spells the player added (Character Sheet →
   *  Spells). Each casts on click (greyed when not castable now); MANAGE SPELLS
   *  opens the sheet to add more. Mirrors the throw picker. */
  private renderQuickcastMenu(state: PlayerPanelActionState): void {
    const spells = state.quickcastSpells;
    if (spells.length === 0) {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:10px;color:#778899;line-height:1.5;padding:6px 8px;text-align:center;';
      hint.textContent = 'No quickcast spells yet. Add some from the Character Sheet → Spells (the ✦ button).';
      this.actionArea.appendChild(hint);
    }
    for (const sp of spells) {
      const b = this.makeBtn(`✦ ${sp.name}`, '#16243a', () => {
        this.quickcastOpen = false;
        this.callbacks.onCastSpell(sp.id);
        if (this.lastActionState) this.refreshActions(this.lastActionState);
      }, '10px');
      b.disabled = !sp.castable;
      this.actionArea.appendChild(b);
    }
    this.actionArea.appendChild(this.makeBtn('✚ MANAGE SPELLS', '#1a1a2a', () => {
      this.quickcastOpen = false;
      this.callbacks.onOpenSpells();
      if (this.lastActionState) this.refreshActions(this.lastActionState);
    }, '10px'));
    this.actionArea.appendChild(this.makeBtn('↩ CANCEL', '#2a1a1a', () => {
      this.quickcastOpen = false;
      if (this.lastActionState) this.refreshActions(this.lastActionState);
    }));
  }

  private makeBtn(label: string, bg: string, onClick: () => void, fontSize = '11px'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'gui-btn';
    b.onclick = onClick;
    const id = actionIdForLabel(label);
    if (id) b.dataset.actionId = id;  // drives Panel Setup visibility filtering
    if (this.compactView && !this.pickerOpen && !this.quickcastOpen) {
      this.applyCompact(b, label, id, bg);
    } else {
      const icon = iconFor(label);
      b.textContent = icon ? `${icon}  ${label}` : label;
      b.style.background = bg;
      b.style.fontSize = fontSize;
      b.style.marginBottom = '0';
    }
    return b;
  }

  /** Style a button as a compact icon-only square: the action's glyph, the full
   *  label as a hover tooltip. Falls back to the catalog glyph, then a letter. */
  private applyCompact(b: HTMLButtonElement, label: string, id: string, bg: string): void {
    const glyph = iconFor(label) || glyphForActionId(id) || (label.replace(/[^A-Za-z]/g, '')[0] ?? '•');
    b.textContent = glyph;
    b.title = label;
    b.style.cssText = `background:${bg};width:36px;height:36px;padding:0;margin:0;font-size:16px;`
      + 'display:flex;align-items:center;justify-content:center;flex:none;line-height:1;';
  }

  /**
   * Two-line button: primary label on top, smaller subtitle in parentheses below.
   * Used for ATTACK so the player sees which weapon will resolve the swing.
   */
  private makeTwoLineBtn(label: string, subtitle: string, bg: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'gui-btn';
    b.onclick = onClick;
    const id = actionIdForLabel(label);
    if (id) b.dataset.actionId = id;
    if (this.compactView && !this.pickerOpen && !this.quickcastOpen) {
      this.applyCompact(b, label, id, bg);  // drop the weapon subtitle in compact mode
      return b;
    }
    b.style.background = bg;
    b.style.fontSize = '11px';
    b.style.marginBottom = '0';
    b.style.height = '42px';
    b.style.whiteSpace = 'normal';
    b.style.lineHeight = '1.2';
    b.style.padding = '4px 0';
    const icon = iconFor(label);
    b.innerHTML = `${icon ? icon + ' ' : ''}${escHtml(label)}<br><span style="font-size:9px;color:#bbccdd;opacity:0.85;">(${escHtml(subtitle)})</span>`;
    return b;
  }

  /** Toggle the Panel Setup overlay. Clicking the ⚙ again (or Done/Escape)
   *  closes it; the button is re-styled to show whether the overlay is open.
   *  Toggling an action's "Visible in panel" persists immediately and re-renders
   *  the action stack with the new set. */
  private openPanelSetup(): void {
    if (this.setupOverlay) {
      this.setupOverlay.close();   // onClose clears the ref + restyles the button
      return;
    }
    this.setupOverlay = new PanelSetupOverlay(
      this.el,
      () => {
        this.hiddenActions = readHiddenActions();
        this.compactView = readCompactView();
        if (this.lastActionState) this.refreshActions(this.lastActionState);
      },
      () => {
        this.setupOverlay = null;
        this.updateSetupButtonState();
      },
    );
    this.updateSetupButtonState();
  }

  /** Reflect whether the Panel Setup overlay is open on the ⚙ button: an open
   *  overlay lights the button (brighter fill + accent border) and flips its
   *  tooltip, so the control reads as a clearly-toggled state. */
  private updateSetupButtonState(): void {
    const open = this.setupOverlay !== null;
    this.setupBtn.style.background = open ? '#234a63' : '#11202e';
    this.setupBtn.style.color = open ? '#eaf4ff' : '#9bb3cc';
    this.setupBtn.style.border = open ? '1px solid #7aadcc' : '';
    this.setupBtn.title = open ? 'Close Player Panel setup' : 'Player Panel setup';
    this.setupBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  destroy(): void {
    this.setupOverlay?.close();
    this.offResize();
    this.el.remove();
    this.endTurnFloatBtn.remove();
  }
}
