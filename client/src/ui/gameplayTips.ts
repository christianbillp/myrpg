/**
 * Gameplay-tip convention for quest/objective text. Quests read immersive
 * (in-character) first; any out-of-character mechanics hint is wrapped by the
 * author in a `[[TIP: ...]]` marker so the UI can pull it out and render it as a
 * clearly-labelled gameplay tip rather than letting it bleed into the fiction.
 *
 *   "Free your kin. [[TIP: Stand next to each captive and use the Help action.]]"
 *      → body: "Free your kin."   tips: ["Stand next to each captive and use the Help action."]
 *
 * Used by the OBJECTIVE line (Player Panel) and the Quest Log so the same
 * authored string renders the IC part one way and the OOC tip another.
 */
const TIP_RE = /\[\[TIP:\s*([\s\S]*?)\]\]/g;

export interface ParsedObjective {
  /** The in-character text, with every `[[TIP: …]]` removed and spacing tidied. */
  body: string;
  /** The out-of-character gameplay tips, in order. */
  tips: string[];
}

export function splitGameplayTips(text: string): ParsedObjective {
  const tips: string[] = [];
  const body = text
    .replace(TIP_RE, (_m, t: string) => { tips.push(t.trim()); return ''; })
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return { body, tips };
}

export function escapeTipHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The accent + glyph that mark a tip as out-of-character throughout the UI. */
export const TIP_COLOR = '#7aadcc';
export const TIP_GLYPH = '💡';
