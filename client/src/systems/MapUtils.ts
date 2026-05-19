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
