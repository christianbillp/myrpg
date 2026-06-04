/** Convert a procedural generator's `passable` working grid (true = walkable)
 *  into the GameMap blocking grids. Procedurally-generated walls block both
 *  movement and sight, so the two grids are identical (independent copies). */
export function blockGridsFromPassable(passable: boolean[][]): {
  blocksMovement: boolean[][];
  blocksSight: boolean[][];
} {
  const blocksMovement = passable.map((row) => row.map((p) => !p));
  return { blocksMovement, blocksSight: blocksMovement.map((row) => [...row]) };
}

export function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function floodFillCount(
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
