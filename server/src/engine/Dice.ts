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
