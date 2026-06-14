/**
 * Combat-log entry shape.
 *
 * Extracted from the original god-file `shared/types.ts` (now a barrel that
 * re-exports every domain module under `shared/types/`).
 */


export type LogEntryStyle = 'normal' | 'hit' | 'crit' | 'kill' | 'heal' | 'status' | 'header' | 'miss'
  /** US-129 ambient NPC-to-NPC banter — rendered dimmed/italic so it reads as
   *  overheard background chatter, not a directed line or a mechanical beat. */
  | 'ambient';

export interface LogEntry {
  left: string;
  right?: string;
  style?: LogEntryStyle;
}
