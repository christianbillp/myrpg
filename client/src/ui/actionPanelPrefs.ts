/**
 * Action-button visibility preferences (Panel Setup).
 *
 * The Player Panel's Action Buttons are built ad-hoc by label; this module gives
 * each a **stable id** (so a visibility preference survives re-renders and label
 * changes) and persists the set of hidden ids globally in localStorage — the
 * same pattern as the panel-width pref.
 *
 * The `ACTION_BUTTON_CATALOG` is the list the Panel Setup Overlay renders a
 * "Visible in panel" toggle for. ROLL DEATH SAVE is intentionally absent: it's a
 * forced prompt with no alternative, so it must never be hideable.
 */
const HIDDEN_KEY = 'myrpg_hidden_action_buttons';
const COMPACT_KEY = 'myrpg_panel_compact_view';

export interface ActionButtonCatalogEntry {
  id: string;
  label: string;
  glyph: string;
  description: string;
}

/** Every toggleable Action Button, in panel order. Dynamic buttons collapse to
 *  a family id: `gear` (SET <gear>), `summon` (DIRECT <summon>), `release`
 *  (RELEASE <spell>), `feature` (all class-feature buttons). */
export const ACTION_BUTTON_CATALOG: ReadonlyArray<ActionButtonCatalogEntry> = [
  { id: 'attack', label: 'Attack', glyph: '⚔', description: 'Strike with your equipped weapon — auto-routes between melee and ranged.' },
  { id: 'throw', label: 'Throw', glyph: '➶', description: 'Hurl an inventory item at a target; proper thrown weapons use their stats.' },
  { id: 'dodge', label: 'Dodge', glyph: '❖', description: 'Until your next turn, attackers have disadvantage and you have advantage on DEX saves.' },
  { id: 'dash', label: 'Dash', glyph: '»', description: 'Gain extra movement equal to your Speed for the turn.' },
  { id: 'disengage', label: 'Disengage', glyph: '↩', description: 'Your movement no longer provokes opportunity attacks this turn.' },
  { id: 'grapple', label: 'Grapple', glyph: '✊', description: 'Seize an adjacent creature with an Unarmed Strike (it becomes Grappled).' },
  { id: 'shove', label: 'Shove', glyph: '🤚', description: 'Push an adjacent creature 5 ft away.' },
  { id: 'shove-prone', label: 'Shove Prone', glyph: '⤓', description: 'Knock an adjacent creature Prone.' },
  { id: 'help', label: 'Help', glyph: '🤝', description: 'Give an ally advantage on their next attack against an adjacent enemy.' },
  { id: 'ready', label: 'Ready', glyph: '⏳', description: 'Prepare an action to trigger on a condition you specify.' },
  { id: 'study', label: 'Study', glyph: '📖', description: 'Recall lore or analyse something — the GM adjudicates the check.' },
  { id: 'utilize', label: 'Utilize', glyph: '🛠', description: 'Use an object or interact with the environment — GM-adjudicated.' },
  { id: 'influence', label: 'Influence', glyph: '💬', description: 'Persuade, deceive, or intimidate a creature — GM-adjudicated.' },
  { id: 'magic', label: 'Magic', glyph: '🪄', description: 'Channel magic into a feature within reach (perform a rite) — or, with nothing nearby, an improvised magical effect the GM adjudicates.' },
  { id: 'search', label: 'Search', glyph: '⚲', description: 'Look for hidden creatures, traps, or clues nearby.' },
  { id: 'hide', label: 'Hide', glyph: '◐', description: 'Attempt to become unseen with a Stealth check.' },
  { id: 'short-rest', label: 'Short Rest', glyph: '☕', description: 'Spend Hit Dice to recover HP over a short rest.' },
  { id: 'knock-out', label: 'Knock Out', glyph: '☄', description: 'Toggle non-lethal melee — reduce foes to 0 HP as Unconscious instead of dead.' },
  { id: 'detach', label: 'Detach', glyph: '⤴', description: 'Break free of a grapple or restraint.' },
  { id: 'escape', label: 'Escape', glyph: '⛓', description: 'Escape a monster grapple — Athletics or Acrobatics vs the escape DC.' },
  { id: 'toggle-light', label: 'Light / Douse', glyph: '🕯', description: 'Light a carried torch or lantern (or douse it). Pushes back darkness around you.' },
  { id: 'disarm-trap', label: 'Disarm Trap', glyph: '⚠', description: 'Attempt to disarm a discovered, armed trap on an adjacent tile.' },
  { id: 'gear', label: 'Deploy Gear (Set)', glyph: '⬡', description: 'Deploy area-denial gear (caltrops, ball bearings) onto a tile.' },
  { id: 'attune', label: 'Attune', glyph: '✶', description: 'Attune to a held magic item that requires attunement (max 3).' },
  { id: 'level-up', label: 'Level Up', glyph: '★', description: 'Spend earned XP to advance to the next level.' },
  { id: 'long-rest', label: 'Long Rest', glyph: '☾', description: 'Rest ~8 hours to recover HP, spell slots, and per-rest features.' },
  { id: 'move', label: 'Move', glyph: '⤧', description: 'Toggle move mode, then click a tile to walk there.' },
  { id: 'talk', label: 'Talk', glyph: '❝', description: 'Speak a line to the currently-selected creature.' },
  { id: 'cast', label: 'Cast', glyph: '✦', description: 'Open your spells to cast one (casters only).' },
  { id: 'summon', label: 'Direct Summon', glyph: '➤', description: 'Command a summoned creature you control (Mage Hand, Unseen Servant, …).' },
  { id: 'release', label: 'Release Concentration', glyph: '✧', description: 'End concentration on the spell you are maintaining (free).' },
  { id: 'feature', label: 'Class Feature Buttons', glyph: '✦', description: 'Your class-feature actions (Second Wind, Rage, Channel Divinity, …).' },
];

/** The SRD 5.2.1 core actions that have a panel button — Attack, Dash,
 *  Disengage, Dodge, Help, Hide, Influence, Ready, Search, Study, Utilize.
 *  Panel Setup lists these under "Basic Actions" (sorted alphabetically);
 *  everything else (game-specific or class actions, and `cast` — this game's
 *  spell-casting button) goes under "Other Actions". */
export const BASIC_ACTION_IDS: ReadonlySet<string> = new Set<string>([
  'attack', 'dash', 'disengage', 'dodge', 'help', 'hide',
  'influence', 'magic', 'ready', 'search', 'study', 'utilize',
]);

const LABEL_TO_ID: Readonly<Record<string, string>> = {
  ATTACK: 'attack', THROW: 'throw', DODGE: 'dodge', DASH: 'dash', DISENGAGE: 'disengage',
  GRAPPLE: 'grapple', SHOVE: 'shove', 'SHOVE PRONE': 'shove-prone', HELP: 'help', READY: 'ready',
  STUDY: 'study', UTILIZE: 'utilize', INFLUENCE: 'influence', SEARCH: 'search', HIDE: 'hide',
  'SHORT REST': 'short-rest', 'KNOCK OUT': 'knock-out', DETACH: 'detach', ESCAPE: 'escape', LIGHT: 'toggle-light', DOUSE: 'toggle-light', ATTUNE: 'attune',
  '★ LEVEL UP': 'level-up', '☾ LONG REST': 'long-rest', MOVE: 'move', TALK: 'talk', CAST: 'cast',
  'DISARM TRAP': 'disarm-trap',
};

/** Stable id for an Action Button label. Dynamic labels collapse to a family id;
 *  an unknown label returns '' (never hideable — always shown). Class-feature
 *  buttons are assigned `feature` explicitly at their call site, not here. */
export function actionIdForLabel(label: string): string {
  if (LABEL_TO_ID[label]) return LABEL_TO_ID[label];
  if (label.startsWith('SET ')) return 'gear';
  if (label.startsWith('DIRECT ')) return 'summon';
  if (label.startsWith('RELEASE ')) return 'release';
  return '';
}

const GLYPH_BY_ID: Readonly<Record<string, string>> =
  Object.fromEntries(ACTION_BUTTON_CATALOG.map((e) => [e.id, e.glyph]));

/** Catalog glyph for an action id — used as the compact-view icon fallback for
 *  buttons whose label has no `ACTION_ICONS` entry (gear/summon/release/feature). */
export function glyphForActionId(id: string): string {
  return GLYPH_BY_ID[id] ?? '';
}

/** Compact View — when on, the Player Panel renders icon-only square buttons. */
export function readCompactView(): boolean {
  return localStorage.getItem(COMPACT_KEY) === 'true';
}

export function writeCompactView(on: boolean): void {
  if (on) localStorage.setItem(COMPACT_KEY, 'true');
  else localStorage.removeItem(COMPACT_KEY);
}

export function readHiddenActions(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function writeHiddenActions(hidden: Set<string>): void {
  if (hidden.size === 0) localStorage.removeItem(HIDDEN_KEY);
  else localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
}

/** Flip one action's visibility and persist. `hidden = true` hides it. */
export function setActionHidden(id: string, hidden: boolean): void {
  const s = readHiddenActions();
  if (hidden) s.add(id); else s.delete(id);
  writeHiddenActions(s);
}
