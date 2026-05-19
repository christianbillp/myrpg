export function d(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

export function d20(): number {
  return d(20);
}

export function rollAdvantage(): { result: number; rolls: [number, number] } {
  const rolls: [number, number] = [d20(), d20()];
  return { result: Math.max(...rolls), rolls };
}

export function rollDisadvantage(): { result: number; rolls: [number, number] } {
  const rolls: [number, number] = [d20(), d20()];
  return { result: Math.min(...rolls), rolls };
}

export function mod(score: number): number {
  return Math.floor((score - 10) / 2);
}
