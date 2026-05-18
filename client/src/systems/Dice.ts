export function d(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

export function d20(): number {
  return d(20);
}

export function rollAdvantage(): number {
  return Math.max(d20(), d20());
}

export function rollDisadvantage(): number {
  return Math.min(d20(), d20());
}

export function mod(score: number): number {
  return Math.floor((score - 10) / 2);
}
