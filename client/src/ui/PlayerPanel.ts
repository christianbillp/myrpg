import { PLAYER_PANEL_WIDTH, GRID_ROWS, TILE_SIZE, HUD_HEIGHT } from '../constants';
import { PlayerDef } from '../data/player';
import { AvailableActions, CombatMode } from '../net/types';
import { UIScale } from './UIScale';
import { STATUS_TONE_COLOR } from './PlayerStatus';
import { DevMode } from '../devMode';

const GRID_H   = GRID_ROWS * TILE_SIZE;
const PANEL_H  = GRID_H + HUD_HEIGHT;
const MAX_PICKER_SLOTS = 6;
const PANEL_MIN_WIDTH = 120;
const PANEL_MAX_WIDTH = 480;
const PANEL_WIDTH_KEY = 'myrpg_player_panel_width';

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
  summons: Array<{ id: string; name: string; spellName: string }>;
  /** True when a creature is currently selected as the target. The TALK
   *  button needs a target so the line can be routed to a `sayto`. */
  hasSelectedTarget: boolean;
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
  private readonly slotsEl: HTMLElement;
  private readonly featureChipsEl: HTMLElement;
  private readonly concentrationEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly objectiveEl: HTMLElement;
  private readonly actionArea: HTMLElement;
  private readonly devCompleteBtn: HTMLButtonElement;
  private readonly endTurnBtn: HTMLButtonElement;
  private readonly offResize: () => void;

  private visible = true;
  private pickerOpen = false;
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
      <div class="gui-hp-track"><div class="gui-hp-fill" data-hp-fill></div></div>
      <div style="padding:2px 12px;font-size:10px;color:#cccccc;" data-hp-text></div>
      <div class="gui-sep"></div>

      <div style="padding:2px 12px;font-size:10px;color:#8eb8e0;display:none;" data-slots></div>
      <div style="padding:2px 12px;font-size:10px;color:#a8c8e8;display:none;line-height:1.6;" data-feature-chips></div>
      <div style="padding:2px 12px;font-size:10px;color:#b8a8e8;display:none;" data-concentration></div>
      <div style="padding:4px 12px 2px;display:none;flex-wrap:wrap;gap:3px;" data-status></div>
      <div class="gui-sep" style="margin-top:2px;"></div>
      <div class="gui-label">OBJECTIVE</div>
      <div style="padding:2px 12px 6px;font-size:10px;color:#e2b96f;line-height:1.4;" data-objective>—</div>

      <div class="gui-sep" style="position:absolute;left:8px;right:0;bottom:108px;"></div>
      <div style="position:absolute;left:0;right:0;bottom:108px;display:flex;flex-direction:column-reverse;gap:4px;padding-bottom:4px;" data-actions></div>

      <div style="position:absolute;bottom:0;left:0;right:0;height:108px;display:flex;flex-direction:column-reverse;gap:4px;padding:0 8px 8px;">
        <button class="gui-btn" style="background:#3a1a1a;" data-leave-enc>LEAVE ENCOUNTER</button>
        <button class="gui-btn" style="background:#3a3020;display:none;" data-end-turn>END TURN</button>
        <button class="gui-btn" style="background:#0a1a2a;" data-charsheet>CHARACTER</button>
        <button class="gui-btn" style="background:#1a3a1a;color:#bbeeaa;display:none;" data-dev-complete>★ COMPLETE OBJECTIVE [DEV]</button>
      </div>
    `;

    const ref = (attr: string) => this.el.querySelector(`[data-${attr}]`) as HTMLElement;
    this.hpFill    = ref('hp-fill');
    this.hpText    = ref('hp-text');
    this.slotsEl   = ref('slots');
    this.featureChipsEl = ref('feature-chips');
    this.concentrationEl = ref('concentration');
    this.statusEl = ref('status');
    this.objectiveEl = ref('objective');
    this.actionArea = ref('actions');
    this.headerSubEl = ref('header-sub');
    this.endTurnBtn = ref('end-turn') as HTMLButtonElement;

    (ref('charsheet') as HTMLButtonElement).onclick = () => callbacks.onOpenCharacterSheet();
    (ref('leave-enc') as HTMLButtonElement).onclick = () => callbacks.onLeaveEncounter();
    this.endTurnBtn.onclick = () => callbacks.onEndTurn();
    this.devCompleteBtn = ref('dev-complete') as HTMLButtonElement;
    this.devCompleteBtn.onclick = () => callbacks.onDevCompleteObjective();
    if (DevMode.completePrimaryObjective) this.devCompleteBtn.style.display = "block";

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

  refreshActions(state: PlayerPanelActionState): void {
    this.lastActionState = state;
    this.actionArea.innerHTML = '';
    this.endTurnBtn.style.display = state.mode === 'player_turn' ? 'block' : 'none';

    // Spell slots: show "current/max" per slot level when the character has any.
    const maxSlots = this.playerDef.defaultSpellSlots ?? [];
    if (maxSlots.length > 0) {
      const parts: string[] = [];
      for (let i = 0; i < maxSlots.length; i++) {
        if (maxSlots[i] > 0) parts.push(`L${i + 1} ${state.spellSlots[i] ?? 0}/${maxSlots[i]}`);
      }
      this.slotsEl.style.display = parts.length > 0 ? 'block' : 'none';
      this.slotsEl.textContent = `Slots: ${parts.join(' · ')}`;
    } else {
      this.slotsEl.style.display = 'none';
    }

    // Class-feature resource chips (Second Wind 2/2, Rage 2/2, Channel Divinity 1/2, …).
    const chips = state.features
      .map((f) => f.resourceChipText)
      .filter((s): s is string => !!s);
    if (chips.length > 0) {
      this.featureChipsEl.style.display = 'block';
      this.featureChipsEl.textContent = chips.join(' · ');
    } else {
      this.featureChipsEl.style.display = 'none';
    }

    // Concentration is now folded into the unified status row beneath, so
    // this dedicated chip stays hidden — kept in the DOM to avoid layout
    // shift if anything else queries it.
    this.concentrationEl.style.display = 'none';

    // Status row: conditions, buffs, ongoing effects, concentration.
    this.renderStatusChips(state.statusChips);

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

    const { mode, actionUsed, bonusActionUsed, movesLeft, moveMode, availableActions: aa } = state;
    const btn = (label: string, bg: string, onClick: () => void) => this.makeBtn(label, bg, onClick);

    // Cunning Action (Rogue L2+): Dash / Disengage / Hide are spent as a
    // Bonus Action, so they render BLUE (the bonus-action accent) instead of
    // GREEN (the action accent). The server's `spendCunningOrAction` helper
    // mirrors the same fallback behaviour.
    const hasCunningAction = (this.playerDef.defaultFeatureIds ?? []).includes('cunning-action');
    const BONUS_BLUE = '#1a3a5a';

    if (mode === 'exploring') {
      const atkEl = this.makeTwoLineBtn('ATTACK', state.mainAttackName, '#1a4a1e', aa.canAttack ? this.callbacks.onAttack : () => {});
      atkEl.disabled = !aa.canAttack;
      this.actionArea.prepend(atkEl);

      const throwExEl = this.makeBtn('THROW', '#1a4a1e', state.throwableItems.length > 0 ? () => { this.pickerOpen = true; this.refreshActions(state); } : () => {});
      throwExEl.disabled = state.throwableItems.length === 0;
      this.actionArea.prepend(throwExEl);

      if (aa.canShortRest)
        this.actionArea.prepend(btn('SHORT REST', '#1a2a3a', this.callbacks.onShortRest));

      // Hide is available during exploring too — lets a Rogue set up a Sneak
      // Attack opener that triggers combat with Advantage on the first roll.
      const hideColor = hasCunningAction ? BONUS_BLUE : '#1a3a1a';
      if (aa.canHide) this.actionArea.prepend(btn('HIDE', hideColor, this.callbacks.onHide));

      // SEARCH — green Action button. Free during exploration; the same
      // button surfaces during combat as a full-Action cost below. Engine
      // side resolves adjacent secrets, hidden NPCs, and corpse-search
      // payloads on a single Perception roll.
      const searchExEl = btn('SEARCH', '#1a4a1e', this.callbacks.onSearch);
      searchExEl.disabled = !aa.canSearch;
      this.actionArea.prepend(searchExEl);

      // Player-owned summons during exploration — no action economy, just
      // click DIRECT to move them.
      for (const summon of state.summons) {
        this.actionArea.prepend(this.makeBtn(`DIRECT ${summon.name.toUpperCase()}`, '#2a3a55', () => this.callbacks.onCommandSummon(summon.id)));
      }

      const moveExEl = this.makeBtn('MOVE', moveMode ? '#5a4800' : '#3a3000', this.callbacks.onToggleMoveMode);
      this.actionArea.appendChild(moveExEl);

      // TALK — opens an inline speech-bubble input near the player so the
      // player can address the currently-selected target. Disabled when no
      // target is selected (the bubble has no recipient to wrap into a
      // `sayto`). Sits above MOVE in the action stack.
      const talkExEl = this.makeBtn('TALK', '#1a3a4a', this.callbacks.onTalk);
      talkExEl.disabled = !state.hasSelectedTarget;
      this.actionArea.appendChild(talkExEl);

      // CAST — shortcut to the Spells tab of the Character Sheet so a caster
      // can pick a spell without first opening CHARACTER and switching tabs.
      // Sits directly above TALK; same teal as TALK. Caster-only.
      if (this.playerDef.spellcastingAbility) {
        this.actionArea.appendChild(this.makeBtn('CAST', '#1a3a4a', this.callbacks.onOpenSpells));
      }

      // LEVEL UP and LONG REST sit above the MOVE button. The action area uses
      // `flex-direction: column-reverse`, so a later DOM child renders higher.
      if (aa.canLevelUp) {
        this.actionArea.appendChild(this.makeBtn('★ LEVEL UP', '#3a2a5a', this.callbacks.onLevelUp));
      }
      if (aa.canLongRest) {
        this.actionArea.appendChild(this.makeBtn('☾ LONG REST', '#1a2a4a', this.callbacks.onLongRest));
      }

    } else if (mode === 'player_turn') {
      const GREEN = '#1a4a1e';

      const atkEl = this.makeTwoLineBtn('ATTACK', state.mainAttackName, GREEN, aa.canAttack ? this.callbacks.onAttack : () => {});
      atkEl.disabled = !aa.canAttack;
      this.actionArea.prepend(atkEl);

      const throwEl = this.makeBtn('THROW', GREEN, !actionUsed && state.throwableItems.length > 0 ? () => { this.pickerOpen = true; this.refreshActions(state); } : () => {});
      throwEl.disabled = actionUsed || state.throwableItems.length === 0;
      this.actionArea.prepend(throwEl);

      // With Cunning Action, Dash / Disengage / Hide colour as Bonus Action
      // (blue) and their eligibility flows through the server's `canDash` /
      // `canDisengage` / `canHide` (which permit either economy when the
      // feature is known and at least one of the two is free).
      const dashDisColor = hasCunningAction ? BONUS_BLUE : GREEN;

      const disEl = this.makeBtn('DISENGAGE', dashDisColor, this.callbacks.onDisengage);
      disEl.disabled = !aa.canDisengage;
      this.actionArea.prepend(disEl);

      if (aa.canDetach) {
        const detEl = this.makeBtn('DETACH', GREEN, this.callbacks.onDetach);
        this.actionArea.prepend(detEl);
      }

      const dodEl = this.makeBtn('DODGE', GREEN, this.callbacks.onDodge);
      dodEl.disabled = actionUsed;
      this.actionArea.prepend(dodEl);

      const dashEl = this.makeBtn('DASH', dashDisColor, this.callbacks.onDash);
      dashEl.disabled = !aa.canDash;
      this.actionArea.prepend(dashEl);

      // Class-specific features — iterate the character's known features and
      // render one button per feature that has a button UI. The server's
      // `usableFeatureIds` decides which are clickable; the rest grey out.
      const usable = new Set(aa.usableFeatureIds);
      for (const feat of state.features) {
        if (!feat.buttonLabel) continue;
        const featEl = this.makeBtn(feat.buttonLabel, feat.buttonColor, () => this.callbacks.onUseFeature(feat.id));
        featEl.disabled = !usable.has(feat.id);
        this.actionArea.prepend(featEl);
      }

      // Player-owned summons (Mage Hand, Unseen Servant). One DIRECT button
      // per summon — costs an Action when invoked.
      for (const summon of state.summons) {
        const sEl = this.makeBtn(`DIRECT ${summon.name.toUpperCase()}`, '#2a3a55', () => this.callbacks.onCommandSummon(summon.id));
        sEl.disabled = actionUsed;
        this.actionArea.prepend(sEl);
      }

      if (aa.canHide) {
        const hideColor = hasCunningAction ? BONUS_BLUE : '#1a3a1a';
        this.actionArea.prepend(btn('HIDE', hideColor, this.callbacks.onHide));
      }

      // SEARCH — green Action button. Costs a full Action in combat (no
      // Cunning Action fast-track per SRD); greys out once the Action has
      // been spent this turn.
      const searchEl = btn('SEARCH', GREEN, this.callbacks.onSearch);
      searchEl.disabled = !aa.canSearch;
      this.actionArea.prepend(searchEl);

      const moveEl = this.makeBtn('MOVE', moveMode ? '#5a4800' : '#3a3000', this.callbacks.onToggleMoveMode);
      moveEl.disabled = movesLeft <= 0;
      this.actionArea.appendChild(moveEl);

      // TALK — no action-economy cost (free-action speech). Mirrors the
      // exploring-mode placement above the MOVE button; disabled when no
      // target is selected so the line has somewhere to route.
      const talkEl = this.makeBtn('TALK', '#1a3a4a', this.callbacks.onTalk);
      talkEl.disabled = !state.hasSelectedTarget;
      this.actionArea.appendChild(talkEl);

      // CAST — opens the Spells tab directly. Same teal as TALK; placed
      // above it. Caster-only. The Spells tab itself enforces action
      // economy + slot availability, so we don't pre-disable the button.
      if (this.playerDef.spellcastingAbility) {
        this.actionArea.appendChild(this.makeBtn('CAST', '#1a3a4a', this.callbacks.onOpenSpells));
      }
      // RELEASE — drops the active concentration spell at will. SRD: ending
      // concentration is free (no action), so this stays free of the
      // action-economy gates. Visible only when concentrating.
      if (state.concentratingOn) {
        const label = state.concentratingOnName
          ? `RELEASE ${state.concentratingOnName.toUpperCase()}`
          : 'RELEASE CONCENTRATION';
        this.actionArea.appendChild(this.makeBtn(label, '#3a2a4a', this.callbacks.onReleaseConcentration));
      }

    } else if (mode === 'death_saves') {
      this.actionArea.prepend(btn('ROLL DEATH SAVE', '#5a1a1a', this.callbacks.onDeathSave));
    }
  }

  /** Render the unified status row beneath HP / slots / features —
   *  conditions, buffs, debuffs, ongoing effects, concentration. Hides the
   *  row entirely when nothing applies. */
  private renderStatusChips(chips: import("./PlayerStatus").PlayerStatusChip[]): void {
    if (!chips || chips.length === 0) {
      this.statusEl.style.display = 'none';
      this.statusEl.replaceChildren();
      return;
    }
    this.statusEl.style.display = 'flex';
    // Wipe + rebuild rather than diffing: chip count is tiny (single-digit
    // typically) and any pop-in is invisible at panel render cadence.
    this.statusEl.replaceChildren();
    for (const c of chips) {
      const palette = STATUS_TONE_COLOR[c.tone];
      const chip = document.createElement('span');
      chip.textContent = c.label;
      if (c.tooltip) chip.title = c.tooltip;
      chip.style.cssText = `
        background:${palette.bg};
        color:${palette.text};
        border:1px solid ${palette.border};
        padding:1px 6px;
        font-size:9px;
        line-height:1.5;
        white-space:nowrap;
      `;
      this.statusEl.appendChild(chip);
    }
  }

  private renderPicker(): void {
    const items = this.lastActionState!.throwableItems.slice(0, MAX_PICKER_SLOTS);
    for (const item of [...items].reverse()) {
      this.actionArea.prepend(this.makeBtn(item.name, '#1e2e1e', () => {
        this.pickerOpen = false;
        this.callbacks.onThrow(item.id);
        if (this.lastActionState) this.refreshActions(this.lastActionState);
      }, '10px'));
    }
    this.actionArea.prepend(this.makeBtn('↩ CANCEL', '#2a1a1a', () => {
      this.pickerOpen = false;
      if (this.lastActionState) this.refreshActions(this.lastActionState);
    }));
  }

  private makeBtn(label: string, bg: string, onClick: () => void, fontSize = '11px'): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'gui-btn';
    b.textContent = label;
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
    b.innerHTML = `${escHtml(label)}<br><span style="font-size:9px;color:#bbccdd;opacity:0.85;">(${escHtml(subtitle)})</span>`;
    b.onclick = onClick;
    return b;
  }

  destroy(): void {
    this.offResize();
    this.el.remove();
  }
}
