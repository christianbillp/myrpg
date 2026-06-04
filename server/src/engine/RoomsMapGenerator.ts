import { GameMap } from './types.js';
import { floodFillCount, blockGridsFromPassable } from './MapUtils.js';

interface Room { x: number; y: number; w: number; h: number; }

export function generateRoomsMap(): GameMap {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = tryGenerate();
    if (result) return result;
  }
  return fallback();
}

function tryGenerate(): GameMap | null {
  const cols = 22 + Math.floor(Math.random() * 8);
  const rows = 22 + Math.floor(Math.random() * 8);
  const passable: boolean[][] = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false),
  );

  const rooms: Room[] = [];
  const target = 4 + Math.floor(Math.random() * 4);

  for (let i = 0; i < target * 20 && rooms.length < target; i++) {
    const w = 3 + Math.floor(Math.random() * 6);
    const h = 3 + Math.floor(Math.random() * 4);
    const x = 1 + Math.floor(Math.random() * (cols - w - 2));
    const y = 1 + Math.floor(Math.random() * (rows - h - 2));
    const overlaps = rooms.some(
      (r) => x <= r.x + r.w && x + w >= r.x && y <= r.y + r.h && y + h >= r.y,
    );
    if (overlaps) continue;
    rooms.push({ x, y, w, h });
    for (let ry = y; ry < y + h; ry++)
      for (let rx = x; rx < x + w; rx++)
        passable[ry][rx] = true;
  }

  if (rooms.length < 2) return null;
  rooms.sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2));
  for (let i = 0; i < rooms.length - 1; i++) carveCorridor(passable, rooms[i], rooms[i + 1]);

  let startR = -1, startC = -1;
  outer: for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c]) { startR = r; startC = c; break outer; }
  if (startR === -1) return null;

  let total = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (passable[r][c]) total++;

  if (floodFillCount(passable, rows, cols, startR, startC) !== total) return null;
  return { cols, rows, ...blockGridsFromPassable(passable) };
}

function carveCorridor(passable: boolean[][], a: Room, b: Room): void {
  const ax = Math.floor(a.x + a.w / 2), ay = Math.floor(a.y + a.h / 2);
  const bx = Math.floor(b.x + b.w / 2), by = Math.floor(b.y + b.h / 2);
  for (let cx = Math.min(ax, bx); cx <= Math.max(ax, bx); cx++) passable[ay][cx] = true;
  for (let cy = Math.min(ay, by); cy <= Math.max(ay, by); cy++) passable[cy][bx] = true;
}

function fallback(): GameMap {
  const cols = 22, rows = 22;
  const passable: boolean[][] = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false),
  );
  for (let r = 2; r < 7; r++) for (let c = 2; c < 8; c++) passable[r][c] = true;
  for (let r = 2; r < 7; r++) for (let c = 14; c < 20; c++) passable[r][c] = true;
  for (let r = 14; r < 20; r++) for (let c = 2; c < 8; c++) passable[r][c] = true;
  for (let r = 14; r < 20; r++) for (let c = 14; c < 20; c++) passable[r][c] = true;
  for (let cx = 2; cx <= 17; cx++) passable[4][cx] = true;
  for (let cy = 4; cy <= 17; cy++) passable[cy][17] = true;
  for (let cx = 5; cx <= 17; cx++) passable[17][cx] = true;
  return { cols, rows, ...blockGridsFromPassable(passable) };
}
