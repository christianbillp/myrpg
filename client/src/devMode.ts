/**
 * DevMode — client-side dev/test toggles persisted in localStorage and
 * spliced into the next encounter's session-create request. Read by:
 *   - `OverlayManager.showIntroIfNeeded` for `disableSupertitle`
 *   - Every `gameClient.createSession` call site for the server-relevant flags
 *
 * The `enabled` getter is a legacy gate for the [DEV] buttons scattered through
 * the UI (see CLAUDE.md). The new feature toggles live in their own getters
 * + setters so the Configuration scene can render them independently.
 */
import type { DevFlags } from "../../shared/types";

const KEY_DEV_MODE = 'myrpg_dev_mode';
const KEY_DISABLE_AIGM = 'myrpg_disable_aigm';
const KEY_DISABLE_SUPERTITLE = 'myrpg_dev_disable_supertitle';
const KEY_UNLIMITED_SPELL_SLOTS = 'myrpg_dev_unlimited_spell_slots';
const KEY_UNLOCK_ALL_SPELLS = 'myrpg_dev_unlock_all_spells';
const KEY_UNLIMITED_ACTIONS = 'myrpg_dev_unlimited_actions';
const KEY_SHOW_DELETE_SAVE  = 'myrpg_dev_show_delete_save';
const KEY_ALLOW_RETRY_CHECKS = 'myrpg_dev_allow_retry_checks';
const KEY_COMPLETE_PRIMARY_OBJECTIVE = 'myrpg_dev_complete_primary_objective';
const KEY_SHOW_DEVTOOLS_PANEL = 'myrpg_dev_show_devtools_panel';
const KEY_CLEAN_MODE_ON_START = 'myrpg_dev_clean_mode_on_start';

function readUrlParam(name: string): boolean | null {
  const param = new URLSearchParams(window.location.search).get(name);
  if (param === 'true') return true;
  if (param === 'false') return false;
  return null;
}

function readBoolStorage(key: string): boolean {
  return localStorage.getItem(key) === 'true';
}

function writeBoolStorage(key: string, value: boolean): void {
  if (value) localStorage.setItem(key, 'true');
  else localStorage.removeItem(key);
}

export const DevMode = {
  get enabled(): boolean {
    const urlOverride = readUrlParam('dev');
    if (urlOverride !== null) return urlOverride;
    const stored = localStorage.getItem(KEY_DEV_MODE);
    return stored === null ? true : stored === 'true';
  },
  /**
   * When true, the client short-circuits AIGM requests with a canned silent
   * reply instead of calling the server. Used to validate that an encounter
   * plays end-to-end on the deterministic layer alone (US-068 acceptance
   * criterion). Toggle via `?disableAIGM=true` URL param or by setting
   * `localStorage.myrpg_disable_aigm = 'true'`.
   */
  get disableAIGM(): boolean {
    const urlOverride = readUrlParam('disableAIGM');
    if (urlOverride !== null) return urlOverride;
    return localStorage.getItem(KEY_DISABLE_AIGM) === 'true';
  },

  // ── Development Mode toggles (Configuration scene) ──────────────────────
  get disableSupertitle(): boolean      { return readBoolStorage(KEY_DISABLE_SUPERTITLE); },
  set disableSupertitle(v: boolean)     { writeBoolStorage(KEY_DISABLE_SUPERTITLE, v); },
  get unlimitedSpellSlots(): boolean    { return readBoolStorage(KEY_UNLIMITED_SPELL_SLOTS); },
  set unlimitedSpellSlots(v: boolean)   { writeBoolStorage(KEY_UNLIMITED_SPELL_SLOTS, v); },
  get unlockAllSpells(): boolean        { return readBoolStorage(KEY_UNLOCK_ALL_SPELLS); },
  set unlockAllSpells(v: boolean)       { writeBoolStorage(KEY_UNLOCK_ALL_SPELLS, v); },
  get unlimitedActions(): boolean       { return readBoolStorage(KEY_UNLIMITED_ACTIONS); },
  set unlimitedActions(v: boolean)      { writeBoolStorage(KEY_UNLIMITED_ACTIONS, v); },
  get showDeleteSaveButton(): boolean   { return readBoolStorage(KEY_SHOW_DELETE_SAVE); },
  set showDeleteSaveButton(v: boolean)  { writeBoolStorage(KEY_SHOW_DELETE_SAVE, v); },
  get allowRetryChecks(): boolean       { return readBoolStorage(KEY_ALLOW_RETRY_CHECKS); },
  set allowRetryChecks(v: boolean)      { writeBoolStorage(KEY_ALLOW_RETRY_CHECKS, v); },
  get completePrimaryObjective(): boolean   { return readBoolStorage(KEY_COMPLETE_PRIMARY_OBJECTIVE); },
  set completePrimaryObjective(v: boolean)  { writeBoolStorage(KEY_COMPLETE_PRIMARY_OBJECTIVE, v); },
  get showDevToolsPanel(): boolean          { return readBoolStorage(KEY_SHOW_DEVTOOLS_PANEL); },
  set showDevToolsPanel(v: boolean)         { writeBoolStorage(KEY_SHOW_DEVTOOLS_PANEL, v); },
  /** Clean Mode — server-side effect (wipes saves on boot). Mirrored
   *  to localStorage so the Configuration screen renders the toggle
   *  in its saved state without an extra GET. The actual wipe happens
   *  on the server when its persisted `devFlags.cleanModeOnStart` is
   *  true; this client flag is purely UI-state. */
  get cleanModeOnStart(): boolean           { return readBoolStorage(KEY_CLEAN_MODE_ON_START); },
  set cleanModeOnStart(v: boolean)          { writeBoolStorage(KEY_CLEAN_MODE_ON_START, v); },

  /** Snapshot the current flags for inclusion in a `CreateSessionRequest`.
   *  Only set fields that are TRUE so the request stays lean. Returns
   *  `undefined` when no dev flags are active, so the server never sees a
   *  hollow `devFlags: {}` object. */
  snapshotDevFlags(): DevFlags | undefined {
    const flags: DevFlags = {};
    if (this.disableSupertitle)    flags.disableSupertitle = true;
    if (this.unlimitedSpellSlots)  flags.unlimitedSpellSlots = true;
    if (this.unlockAllSpells)      flags.unlockAllSpells = true;
    if (this.unlimitedActions)     flags.unlimitedActions = true;
    if (this.showDeleteSaveButton) flags.showDeleteSaveButton = true;
    if (this.allowRetryChecks)     flags.allowRetryChecks = true;
    if (this.completePrimaryObjective) flags.completePrimaryObjective = true;
    if (this.showDevToolsPanel)    flags.showDevToolsPanel = true;
    // cleanModeOnStart is intentionally NOT snapshotted into per-session
    // devFlags — it's a server-startup flag, not a per-session override.
    return Object.keys(flags).length === 0 ? undefined : flags;
  },
};
