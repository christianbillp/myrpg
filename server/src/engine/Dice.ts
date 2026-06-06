export function d(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

export function d20(): number { return d(20); }

export function mod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function rollAdvantage(): { result: number; rolls: [number, number] } {
  const a = d20(), b = d20();
  return { result: Math.max(a, b), rolls: [a, b] };
}

export function rollDisadvantage(): { result: number; rolls: [number, number] } {
  const a = d20(), b = d20();
  return { result: Math.min(a, b), rolls: [a, b] };
}

/**
 * SRD Halfling "Luck": when a player rolls a natural 1 on the d20 of a D20 Test
 * (attack roll, ability check, or saving throw), the die is rerolled once and
 * the new roll must be used. A no-op unless `luck` is set and the resolved
 * natural die is a 1 — so it composes after Advantage/Disadvantage selection.
 * Pass the existing roll `label` to get a luck-annotated label back; omit it
 * for roll sites that don't surface one.
 */
export function applyHalflingLuck(
  natural: number,
  luck: boolean | undefined,
  label?: string,
): { natural: number; label: string } {
  if (!luck || natural !== 1) return { natural, label: label ?? '' };
  const reroll = d20();
  return { natural: reroll, label: label !== undefined ? `${label}⟲luck(1→${reroll})` : '' };
}
