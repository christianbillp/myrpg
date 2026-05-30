/**
 * Currency — SRD 5.2.1 coin system. The game's canonical unit is the Copper
 * Piece (CP) so all internal arithmetic stays in integers; display layers
 * split CP back into the five SRD denominations.
 *
 * Coin values (SRD 5.2.1, Equipment → Coins):
 *   1 PP = 1000 CP   (Platinum Piece — 10 GP)
 *   1 GP =  100 CP   (Gold Piece — base coin of the table)
 *   1 EP =   50 CP   (Electrum Piece — 1/2 GP)
 *   1 SP =   10 CP   (Silver Piece — 1/10 GP)
 *   1 CP =    1 CP   (Copper Piece)
 */

export const CP_PER_SP = 10;
export const CP_PER_EP = 50;
export const CP_PER_GP = 100;
export const CP_PER_PP = 1000;

export interface CoinPurse {
  pp?: number;
  gp?: number;
  ep?: number;
  sp?: number;
  cp?: number;
}

/** Total a multi-denomination input down to a single integer CP value. Used
 *  at edges where the AI GM or designer authors a purse like
 *  `{ gp: 2, sp: 5 }`. Missing fields are treated as zero. */
export function purseToCp(p: CoinPurse): number {
  return (p.pp ?? 0) * CP_PER_PP
       + (p.gp ?? 0) * CP_PER_GP
       + (p.ep ?? 0) * CP_PER_EP
       + (p.sp ?? 0) * CP_PER_SP
       + (p.cp ?? 0);
}

/** Greedy split of a CP balance into PP / GP / EP / SP / CP. Electrum is
 *  always emitted as zero — the SRD allows EP to exist as a found coin but
 *  the make-change algorithm never needs it (5 SP is the cleaner split). */
export interface SplitCoins { pp: number; gp: number; ep: number; sp: number; cp: number; }
export function splitCp(cp: number): SplitCoins {
  let rem = Math.max(0, Math.floor(cp));
  const pp = Math.floor(rem / CP_PER_PP); rem -= pp * CP_PER_PP;
  const gp = Math.floor(rem / CP_PER_GP); rem -= gp * CP_PER_GP;
  const sp = Math.floor(rem / CP_PER_SP); rem -= sp * CP_PER_SP;
  return { pp, gp, ep: 0, sp, cp: rem };
}

/** Format a CP balance as the SRD-style coin string. Skips zero-value
 *  denominations so a 14.25-GP balance reads "14 GP · 2 SP · 5 CP" rather
 *  than "0 PP · 14 GP · 0 EP · 2 SP · 5 CP". A zero balance reads "0 CP". */
export function formatCoins(cp: number): string {
  const s = splitCp(cp);
  const parts: string[] = [];
  if (s.pp) parts.push(`${s.pp} PP`);
  if (s.gp) parts.push(`${s.gp} GP`);
  if (s.ep) parts.push(`${s.ep} EP`);
  if (s.sp) parts.push(`${s.sp} SP`);
  if (s.cp) parts.push(`${s.cp} CP`);
  return parts.length === 0 ? "0 CP" : parts.join(" · ");
}

/** Compact "X GP Y SP Z CP" style with no separator dots — handy for inline
 *  log strings where ` · ` reads awkwardly. */
export function formatCoinsCompact(cp: number): string {
  const s = splitCp(cp);
  const parts: string[] = [];
  if (s.pp) parts.push(`${s.pp} PP`);
  if (s.gp) parts.push(`${s.gp} GP`);
  if (s.sp) parts.push(`${s.sp} SP`);
  if (s.cp) parts.push(`${s.cp} CP`);
  return parts.length === 0 ? "0 CP" : parts.join(" ");
}

/** Equivalent value in GP rendered to two decimal places — for tooltips
 *  and summary lines that want a single scalar ("Total: 14.25 GP"). */
export function cpToGpString(cp: number): string {
  return (cp / CP_PER_GP).toFixed(2);
}
