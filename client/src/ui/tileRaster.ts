/**
 * Client-side SVG → tileset rasterisation for the Tile Generator.
 *
 * The map renderer samples tiles as frames out of a PNG spritesheet, but the
 * AIGM produces tiles as SVG. Rather than add a server-side raster library, we
 * rasterise here: each SVG is drawn into a canvas via a `data:` URL (which is
 * same-origin, so the canvas is never tainted and `toDataURL` works), and the
 * whole `generated` tileset is composited into one sheet to upload.
 */

/** Render an SVG string into a `size`×`size` canvas. */
export function rasterizeSvg(svg: string, size: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("2D canvas unavailable")); return; }
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error("Failed to render SVG"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

/**
 * Composite a list of tile SVGs (in gid order) into one spritesheet, row-major
 * across `columns`. Returns a PNG data URL — the server strips the prefix.
 */
export async function assembleSpritesheet(svgs: string[], size: number, columns: number): Promise<string> {
  const rows = Math.max(1, Math.ceil(svgs.length / columns));
  const sheet = document.createElement("canvas");
  sheet.width = columns * size;
  sheet.height = rows * size;
  const ctx = sheet.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  for (let i = 0; i < svgs.length; i++) {
    const frame = await rasterizeSvg(svgs[i], size);
    ctx.drawImage(frame, (i % columns) * size, Math.floor(i / columns) * size);
  }
  return sheet.toDataURL("image/png");
}
