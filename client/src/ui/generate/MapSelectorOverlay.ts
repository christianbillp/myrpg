import Phaser from "phaser";
import { tilesetTextureKey } from "../../scenes/BootScene";
import type { SavedMapDef } from "../../net/types";
import type { MapPreviewData } from "../MapPreviewOverlay";
import { decodeTileGid, TILE_VOID_GID } from "../../../../shared/tileGid";

/**
 * Modal overlay listing previously-saved maps as clickable cards. Each card
 * shows a thumbnail rendered with the map's own tilesets plus the map's name
 * and short description. Selecting a card resolves the overlay via `onSelect`
 * with a `MapPreviewData` ready to slot into the encounter builder.
 *
 * The overlay mirrors `MapPreviewOverlay` in layout (centred backdrop + panel
 * with CLOSE in the bottom-right) but renders many small thumbnails instead
 * of one large map.
 */
const PANEL_W = 1100;
const PANEL_H = 700;
const HEADER_H = 90;
const FOOTER_H = 70;
const CARD_PAD = 16;
const CARD_W = 240;
const CARD_H = 220;
const CARD_THUMB_H = 132;
const CARD_TILE_PX = 6;

export class MapSelectorOverlay {
  private readonly scene: Phaser.Scene;
  private readonly container: Phaser.GameObjects.Container;
  private readonly listContainer: Phaser.GameObjects.Container;
  private readonly fallbackTilesetKey: string;
  private wheelHandler?: (
    pointer: Phaser.Input.Pointer,
    gameObjects: Phaser.GameObjects.GameObject[],
    deltaX: number,
    deltaY: number,
  ) => void;
  private scrollY = 0;
  private maxScroll = 0;

  constructor(
    scene: Phaser.Scene,
    maps: SavedMapDef[],
    callbacks: { onSelect: (map: MapPreviewData) => void; onClose: () => void },
  ) {
    this.scene = scene;
    const w = scene.scale.width;
    const h = scene.scale.height;

    this.fallbackTilesetKey = pickTilesetKey(scene);

    this.container = scene.add.container(0, 0).setDepth(1000);

    const backdrop = scene.add.rectangle(w / 2, h / 2, w, h, 0x000000, 0.75).setInteractive();
    backdrop.on("pointerdown", () => { /* swallow clicks behind the panel */ });
    this.container.add(backdrop);

    const panel = scene.add.rectangle(w / 2, h / 2, PANEL_W, PANEL_H, 0x141426)
      .setStrokeStyle(2, 0x88ccaa);
    this.container.add(panel);

    const top = h / 2 - PANEL_H / 2;
    const left = w / 2 - PANEL_W / 2;

    const headerTag = scene.add.text(w / 2, top + 22, "SELECT MAP", {
      fontSize: "11px", color: "#88ccaa", fontFamily: "monospace", letterSpacing: 2,
    }).setOrigin(0.5, 0);
    this.container.add(headerTag);

    const sub = scene.add.text(w / 2, top + 44, `${maps.length} saved map${maps.length === 1 ? "" : "s"}`, {
      fontSize: "13px", color: "#aabbcc", fontFamily: "monospace",
    }).setOrigin(0.5, 0);
    this.container.add(sub);

    const listTop = top + HEADER_H;
    const listH = PANEL_H - HEADER_H - FOOTER_H;
    const listLeft = left + 24;
    const listRight = left + PANEL_W - 24;
    const listW = listRight - listLeft;

    // Invisible hit-target catches wheel events for scrolling the card grid.
    const viewportHit = scene.add.rectangle(
      w / 2, listTop + listH / 2, listW, listH, 0x000000, 0,
    ).setInteractive();
    this.container.add(viewportHit);

    this.listContainer = scene.add.container(listLeft, listTop);
    this.container.add(this.listContainer);

    const maskShape = scene.make.graphics({ x: 0, y: 0 }, false);
    maskShape.fillStyle(0xffffff);
    maskShape.fillRect(listLeft, listTop, listW, listH);
    this.listContainer.setMask(maskShape.createGeometryMask());

    if (maps.length === 0) {
      const empty = scene.add.text(listW / 2, listH / 2, "No saved maps yet.\nCompose a map and press SAVE to add one.", {
        fontSize: "13px", color: "#556677", fontFamily: "monospace", align: "center",
      }).setOrigin(0.5);
      this.listContainer.add(empty);
    } else {
      this.renderCards(maps, listW, callbacks.onSelect);
    }

    // Wheel-scroll the card grid when the pointer is over the viewport.
    this.wheelHandler = (pointer, _objs, _dx, deltaY) => {
      if (
        pointer.x < listLeft || pointer.x > listRight ||
        pointer.y < listTop || pointer.y > listTop + listH
      ) return;
      if (this.maxScroll <= 0) return;
      this.scrollY = Phaser.Math.Clamp(this.scrollY + deltaY, 0, this.maxScroll);
      this.listContainer.y = listTop - this.scrollY;
    };
    scene.input.on("wheel", this.wheelHandler);

    // CLOSE button (bottom-right).
    const closeX = left + PANEL_W - 130;
    const closeY = top + PANEL_H - 36;
    const closeBg = scene.add.rectangle(closeX, closeY, 220, 40, 0x222233)
      .setStrokeStyle(2, 0x556677).setInteractive({ useHandCursor: true });
    const closeLabel = scene.add.text(closeX, closeY, "CLOSE", {
      fontSize: "13px", color: "#aabbcc", fontFamily: "monospace",
    }).setOrigin(0.5);
    closeBg.on("pointerdown", () => callbacks.onClose());
    this.container.add(closeBg);
    this.container.add(closeLabel);
  }

  destroy(): void {
    if (this.wheelHandler) this.scene.input.off("wheel", this.wheelHandler);
    this.container.destroy();
  }

  private renderCards(
    maps: SavedMapDef[],
    listW: number,
    onSelect: (map: MapPreviewData) => void,
  ): void {
    const cardsPerRow = Math.max(1, Math.floor((listW + CARD_PAD) / (CARD_W + CARD_PAD)));
    const rowGap = CARD_PAD;
    const usedRowW = cardsPerRow * CARD_W + (cardsPerRow - 1) * CARD_PAD;
    const leftPad = Math.max(0, Math.floor((listW - usedRowW) / 2));

    maps.forEach((m, idx) => {
      const col = idx % cardsPerRow;
      const row = Math.floor(idx / cardsPerRow);
      const cx = leftPad + col * (CARD_W + CARD_PAD);
      const cy = row * (CARD_H + rowGap);
      this.renderCard(m, cx, cy, onSelect);
    });

    const rows = Math.ceil(maps.length / cardsPerRow);
    const totalH = rows * CARD_H + (rows - 1) * rowGap;
    const visibleH = PANEL_H - HEADER_H - FOOTER_H;
    this.maxScroll = Math.max(0, totalH - visibleH);
  }

  private renderCard(
    map: SavedMapDef,
    x: number,
    y: number,
    onSelect: (map: MapPreviewData) => void,
  ): void {
    const bg = this.scene.add.rectangle(x + CARD_W / 2, y + CARD_H / 2, CARD_W, CARD_H, 0x1a1a2e)
      .setStrokeStyle(1, 0x334455).setInteractive({ useHandCursor: true });
    bg.on("pointerover", () => bg.setStrokeStyle(2, 0x88ccaa));
    bg.on("pointerout",  () => bg.setStrokeStyle(1, 0x334455));
    bg.on("pointerdown", () => onSelect(savedMapToPreview(map)));
    this.listContainer.add(bg);

    const thumbCx = x + CARD_W / 2;
    const thumbCy = y + 8 + CARD_THUMB_H / 2;
    this.renderThumbnail(map, thumbCx, thumbCy);

    const titleY = y + 8 + CARD_THUMB_H + 8;
    const title = this.scene.add.text(x + 10, titleY, map.name, {
      fontSize: "13px", color: "#e2b96f", fontFamily: "monospace",
      wordWrap: { width: CARD_W - 20 },
    }).setOrigin(0, 0);
    this.listContainer.add(title);

    const desc = this.scene.add.text(x + 10, titleY + 20, map.mapdescription || "", {
      fontSize: "10px", color: "#8899aa", fontFamily: "sans-serif",
      wordWrap: { width: CARD_W - 20 }, lineSpacing: 2,
    }).setOrigin(0, 0);
    this.listContainer.add(desc);
  }

  private renderThumbnail(map: SavedMapDef, cx: number, cy: number): void {
    const maxW = CARD_W - 20;
    const maxH = CARD_THUMB_H;
    const tileSize = Math.min(
      Math.floor(maxW / map.cols),
      Math.floor(maxH / map.rows),
      CARD_TILE_PX,
    );
    const thumbW = tileSize * map.cols;
    const thumbH = tileSize * map.rows;
    const startX = cx - thumbW / 2;
    const startY = cy - thumbH / 2;

    // Backing rect — surfaces gaps if a tile fails to render.
    const back = this.scene.add.rectangle(cx, cy, thumbW + 2, thumbH + 2, 0x0a0e16)
      .setStrokeStyle(1, 0x2a3340);
    this.listContainer.add(back);

    // Per-map tileset routing — sorted descending so the highest firstgid ≤ gid wins.
    const routing = (map.tilesets ?? [])
      .map((ts) => ({ firstgid: ts.firstgid, key: tilesetTextureKey(ts.imageUrl) }))
      .sort((a, b) => b.firstgid - a.firstgid);
    const owners = routing.length > 0 ? routing : [{ firstgid: 1, key: this.fallbackTilesetKey }];

    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const tx = startX + c * tileSize + tileSize / 2;
        const ty = startY + r * tileSize + tileSize / 2;
        const groundGid = map.gidGrid[r]?.[c] ?? 0;
        if (groundGid > 0) this.drawTile(tx, ty, tileSize, groundGid, owners);
        const objectGid = map.objectGidGrid?.[r]?.[c] ?? 0;
        if (objectGid > 0) this.drawTile(tx, ty, tileSize, objectGid, owners);
      }
    }
  }

  private drawTile(
    tx: number, ty: number, size: number, rawGid: number,
    owners: Array<{ firstgid: number; key: string }>,
  ): void {
    const dec = decodeTileGid(rawGid);
    if (dec.gid === TILE_VOID_GID) {
      this.listContainer.add(
        this.scene.add.rectangle(tx, ty, size, size, 0x000000),
      );
      return;
    }
    const owner = owners.find((t) => dec.gid >= t.firstgid);
    if (!owner || !this.scene.textures.exists(owner.key)) return;
    const frame = dec.gid - owner.firstgid;
    const img = this.scene.add.image(tx, ty, owner.key, frame)
      .setDisplaySize(size, size);
    if (dec.angle !== 0) img.setAngle(dec.angle);
    if (dec.flipX) img.setFlipX(true);
    if (dec.flipY) img.setFlipY(true);
    this.listContainer.add(img);
  }
}

/** Convert a server-side SavedMapDef into the MapPreviewData shape the encounter builder consumes. */
function savedMapToPreview(saved: SavedMapDef): MapPreviewData {
  const terrainData: number[] = [];
  for (const row of saved.gidGrid) terrainData.push(...row);
  const objectData: number[] = [];
  if (saved.objectGidGrid) {
    for (const row of saved.objectGidGrid) objectData.push(...row);
  } else {
    for (let i = 0; i < terrainData.length; i++) objectData.push(0);
  }
  return {
    mapId: saved.id,
    width: saved.cols,
    height: saved.rows,
    terrainData,
    objectData,
    name: saved.name,
    description: saved.mapdescription,
    tilesets: saved.tilesets.map((t) => ({
      firstgid: t.firstgid,
      source: `../tilesets/${(t.imageUrl.split("/").pop() ?? "").replace(/\.png$/i, ".tsj")}`,
    })),
  };
}

function pickTilesetKey(scene: Phaser.Scene): string {
  const maps = (scene.registry.get("maps") as SavedMapDef[] | undefined) ?? [];
  for (const m of maps) {
    const url = m.tilesets?.[0]?.imageUrl;
    if (url) return tilesetTextureKey(url);
  }
  return tilesetTextureKey("/tilesets/scribble.png");
}
