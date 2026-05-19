import { floodFillCount } from "./MapUtils";

export interface GameMap {
  cols: number;
  rows: number;
  passable: boolean[][];
}

export function generateMap(): GameMap {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = tryGenerate();
    if (result) return result;
  }
  const size = 15;
  return {
    cols: size,
    rows: size,
    passable: Array.from({ length: size }, () => new Array<boolean>(size).fill(true)),
  };
}

function tryGenerate(): GameMap | null {
  const size = 10 + Math.floor(Math.random() * 21); // 10..30
  const wallFraction = 0.2 + Math.random() * 0.2;   // 20..40%
  const wallTarget = Math.floor(size * size * wallFraction);

  const passable: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(true),
  );

  let placed = 0;
  let tries = 0;
  while (placed < wallTarget && tries < wallTarget * 10) {
    tries++;
    const r = Math.floor(Math.random() * size);
    const c = Math.floor(Math.random() * size);
    if (passable[r][c]) {
      passable[r][c] = false;
      placed++;
    }
  }

  let startR = -1, startC = -1;
  outer: for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (passable[r][c]) { startR = r; startC = c; break outer; }
    }
  }
  if (startR === -1) return null;

  let totalPassable = 0;
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (passable[r][c]) totalPassable++;

  if (floodFillCount(passable, size, size, startR, startC) !== totalPassable) return null;

  return { cols: size, rows: size, passable };
}
