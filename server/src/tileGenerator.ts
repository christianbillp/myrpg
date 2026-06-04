/**
 * Tile generator — the AIGM authors a single map tile as inline SVG plus a
 * suggested legend classification (movement / sight / cover / layer / tags).
 *
 * Why SVG: the game renders tiles as frames sampled out of a tileset PNG
 * spritesheet, and there is no image-generation model in the loop. Claude can
 * reliably emit vector markup, so it writes a 128×128 SVG; the CLIENT then
 * rasterises it onto a canvas and composites it into the shared `generated`
 * tileset (no server-side raster dependency). Mirrors `generateMap`'s forced
 * tool-call + zod-validation pattern.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/** Edge length (px) of a generated tile — matches the scribble tileset so
 *  generated tiles render at the same scale on a map. */
export const GENERATED_TILE_SIZE = 128;
/** Columns in the assembled `generated` spritesheet. Shared with the client so
 *  the uploaded PNG and the server-built `.tsj` agree on the frame grid. */
export const GENERATED_TILE_COLUMNS = 8;

export interface GeneratedTile {
  svg: string;
  suggested: {
    name: string;
    layer: "ground" | "object";
    blocksMovement: boolean;
    blocksSight: boolean;
    cover?: "half" | "three-quarters" | "total";
    obscurance?: "lightly" | "heavily";
    tags: string[];
    description: string;
  };
}

const SubmitTileSchema = z.object({
  svg: z.string(),
  name: z.string(),
  layer: z.enum(["ground", "object"]),
  blocksMovement: z.boolean(),
  blocksSight: z.boolean(),
  cover: z.enum(["half", "three-quarters", "total"]).optional(),
  obscurance: z.enum(["lightly", "heavily"]).optional(),
  tags: z.array(z.string()).default([]),
  description: z.string().default(""),
});

const SYSTEM = `You design a single tile for a top-down 2D RPG map and submit it via the submit_tile tool.

STYLE — MATCH THE REFERENCE TILESET:
- The user message includes an image of the game's existing tileset. Your tile MUST match it: the same art style, line treatment, level of detail, and colour palette, so it sits seamlessly beside those tiles on the same map. Sample your colours from the reference; do not introduce a clashing palette or a different rendering style.

PERSPECTIVE — STRICTLY TOP-DOWN:
- Bird's-eye view, as if a camera looks straight down at the ground. NEVER isometric, NEVER side-on/elevation, no horizon line, no vanishing-point perspective, no cast shadows implying a light angle. Objects (trees, walls, crates) are drawn from directly above.

THE IMAGE (svg field):
- A self-contained SVG, exactly: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GENERATED_TILE_SIZE} ${GENERATED_TILE_SIZE}" width="${GENERATED_TILE_SIZE}" height="${GENERATED_TILE_SIZE}"> ... </svg>
- Fill the whole 128×128 square edge-to-edge (no transparent margins for ground tiles) and keep the edges visually continuous so the tile can repeat seamlessly across a map.
- A handful of shapes; readable at small size.
- Use ONLY <rect>, <circle>, <ellipse>, <path>, <polygon>, <line>, <g>, and solid/linearGradient fills. NO <text>, NO <image>, NO external URLs, NO <script>, NO filters.
- Object tiles (a tree, a crate, a wall) may sit on a transparent background so they overlay terrain; ground tiles (grass, stone floor, water) must be opaque and fill the square.

THE CLASSIFICATION:
- name: short snake_case id, e.g. "mossy_stone_floor", "pine_tree".
- layer: "ground" for walkable terrain/floors/water; "object" for things placed on top (trees, walls, furniture, rubble).
- blocksMovement: true if a creature cannot walk onto it (wall, tree, chasm, deep water).
- blocksSight: true if it blocks line of sight (solid wall, dense canopy). A chasm or low rubble blocks movement but NOT sight; a glass wall blocks sight but not movement.
- cover (optional): "half" (+2 AC), "three-quarters" (+5 AC), or "total" for things creatures shelter behind (low wall = half, large rock/tree = three-quarters, solid wall = total).
- obscurance (optional): "lightly" (smoke, underbrush) or "heavily" (thick fog, dense foliage).
- tags: a few free-form classification words.
- description: one sentence describing the tile (shown to AI map generators).

Keep the SVG compact. Submit exactly one tile.`;

function buildSubmitTool(): Anthropic.Tool {
  return {
    name: "submit_tile",
    description: "Submit the generated tile's SVG image and its gameplay classification.",
    input_schema: {
      type: "object",
      properties: {
        svg: { type: "string", description: "The full inline SVG markup for the 128×128 tile." },
        name: { type: "string", description: "Short snake_case tile id." },
        layer: { type: "string", enum: ["ground", "object"] },
        blocksMovement: { type: "boolean" },
        blocksSight: { type: "boolean" },
        cover: { type: "string", enum: ["half", "three-quarters", "total"] },
        obscurance: { type: "string", enum: ["lightly", "heavily"] },
        tags: { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
      required: ["svg", "name", "layer", "blocksMovement", "blocksSight"],
    },
  };
}

/** Strip anything we never want rendered, even though a raster <img> wouldn't
 *  execute it: scripts, foreignObject, external/event hooks. Defensive only. */
function sanitizeSvg(svg: string): string {
  let s = svg.trim();
  const open = s.indexOf("<svg");
  const close = s.lastIndexOf("</svg>");
  if (open >= 0 && close > open) s = s.slice(open, close + "</svg>".length);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/(href|xlink:href)\s*=\s*"(?!#)[^"]*"/gi, "");
  return s;
}

/** Optional vision reference: the existing tileset PNG, so the model matches
 *  its art style + palette. */
export interface TileStyleReference {
  base64: string;
  mediaType: "image/png" | "image/jpeg";
}

export async function generateTile(
  anthropic: Anthropic,
  description: string,
  reference?: TileStyleReference,
): Promise<GeneratedTile> {
  const content: Anthropic.ContentBlockParam[] = [];
  if (reference) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: reference.mediaType, data: reference.base64 },
    });
    content.push({ type: "text", text: "Above is the existing tileset. Match its art style and palette exactly, top-down." });
  }
  content.push({ type: "text", text: `Design this tile, matching the reference tileset's style:\n\n${description}` });

  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM,
    tools: [buildSubmitTool()],
    tool_choice: { type: "tool", name: "submit_tile" },
    messages: [{ role: "user", content }],
  });

  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Model did not return a tile.");
  const p = SubmitTileSchema.parse(block.input);

  const svg = sanitizeSvg(p.svg);
  if (!svg.startsWith("<svg")) throw new Error("Model did not return valid SVG markup.");

  return {
    svg,
    suggested: {
      name: p.name.trim() || "generated_tile",
      layer: p.layer,
      blocksMovement: p.blocksMovement,
      blocksSight: p.blocksSight,
      ...(p.cover ? { cover: p.cover } : {}),
      ...(p.obscurance ? { obscurance: p.obscurance } : {}),
      tags: p.tags.filter((t) => typeof t === "string"),
      description: p.description,
    },
  };
}
