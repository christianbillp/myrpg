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

function floodFillCount(
  passable: boolean[][],
  rows: number,
  cols: number,
  startR: number,
  startC: number,
): number {
  const visited: boolean[][] = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false),
  );
  const queue: [number, number][] = [[startR, startC]];
  visited[startR][startC] = true;
  let count = 0;
  const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  while (queue.length > 0) {
    const [cy, cx] = queue.shift()!;
    count++;
    for (const [dr, dc] of dirs) {
      const nr = cy + dr, nc = cx + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && passable[nr][nc] && !visited[nr][nc]) {
        visited[nr][nc] = true;
        queue.push([nr, nc]);
      }
    }
  }
  return count;
}
