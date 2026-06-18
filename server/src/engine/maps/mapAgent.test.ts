/**
 * Integration test for the agentic build loop with a SCRIPTED model (no API).
 * Verifies the tool dispatch, the feedback loop, error surfacing, the op budget,
 * and the connectivity auto-repair on finish.
 */
import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgenticBuild, type MessageCreator } from "./mapAgent.js";
import type { GameDefs } from "../types.js";
import { MapCanvas } from "./MapCanvas.js";
import { passableRegions } from "./mapOps.js";

/** Build a fake Anthropic that replays a fixed script of tool calls, one
 *  assistant message per `create` call. Each script entry is a list of
 *  tool_use blocks to emit that turn. */
function scriptedModel(script: Array<Array<{ name: string; input: Record<string, unknown> }>>): MessageCreator {
  let turn = 0;
  return {
    messages: {
      create: async (): Promise<Anthropic.Message> => {
        const calls = script[Math.min(turn, script.length - 1)];
        turn++;
        return {
          id: `msg_${turn}`,
          type: "message",
          role: "assistant",
          model: "test",
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 } as never,
          content: calls.map((c, i) => ({ type: "tool_use", id: `tu_${turn}_${i}`, name: c.name, input: c.input })),
        } as unknown as Anthropic.Message;
      },
    },
  };
}

const DEFS = { activeSetting: null } as unknown as GameDefs;

describe("runAgenticBuild", () => {
  it("builds a two-room map and auto-connects it on finish", async () => {
    const model = scriptedModel([
      [{ name: "begin_map", input: { width: 24, height: 16, baseTerrain: "void", name: "Twin Cells", description: "Two stone chambers." } }],
      [{ name: "stamp_room", input: { x: 2, y: 2, w: 6, h: 5, floor: "stone_floor", doorways: [{ x: 7, y: 4 }] } }],
      [{ name: "stamp_room", input: { x: 15, y: 8, w: 6, h: 5, floor: "stone_floor", doorways: [{ x: 15, y: 10 }] } }],
      [{ name: "finish", input: { name: "Twin Cells", description: "Two stone chambers linked by a passage." } }],
    ]);
    const map = await runAgenticBuild(model, DEFS, { prompt: "two rooms" });
    expect(map.name).toBe("Twin Cells");
    expect(map.terrainData.length).toBe(24 * 16);
    // After auto-repair the two room interiors share one connected region.
    const c = canvasFrom(map);
    const { sizes } = passableRegions(c);
    expect(sizes.length).toBe(1);
  });

  it("surfaces an op error but keeps going (out-of-bounds room is rejected, map still finishes)", async () => {
    const model = scriptedModel([
      [{ name: "begin_map", input: { width: 20, height: 14, baseTerrain: "grassland", name: "Field", description: "Open grass." } }],
      [{ name: "stamp_room", input: { x: 50, y: 50, w: 6, h: 5, floor: "stone_floor" } }], // out of bounds → error
      [{ name: "place_building", input: { x: 4, y: 4, w: 6, h: 5, doorSide: "S" } }],
      [{ name: "finish", input: { name: "Field Post", description: "A grass field with a hut." } }],
    ]);
    const map = await runAgenticBuild(model, DEFS, { prompt: "a hut in a field" });
    expect(map.name).toBe("Field Post");
    // The valid building still landed (zone recorded).
    expect(map.zones?.some((z) => z.name === "building")).toBe(true);
  });

  it("stamps a registered set-piece via stamp_feature", async () => {
    const model = scriptedModel([
      [{ name: "begin_map", input: { width: 20, height: 16, baseTerrain: "grassland", name: "Outpost", description: "A grass field." } }],
      [{ name: "stamp_feature", input: { feature: "watchtower", x: 6, y: 5, w: 7, h: 7 } }],
      [{ name: "finish", input: { name: "Border Outpost", description: "A watchtower on the frontier." } }],
    ]);
    const map = await runAgenticBuild(model, DEFS, { prompt: "a watchtower" });
    // The recipe's zones came through, so the set-piece landed via the agent loop.
    expect(map.zones?.some((z) => z.name === "watchtower")).toBe(true);
    expect(map.zones?.some((z) => z.name === "watchtower courtyard")).toBe(true);
  });

  it("throws if the model never calls begin_map", async () => {
    const model = scriptedModel([[{ name: "finish", input: { name: "x", description: "y" } }]]);
    await expect(runAgenticBuild(model, DEFS, { prompt: "nothing" })).rejects.toThrow(/begin_map/);
  });

  it("derives tilesets from the materials actually used (cave map declares cave tileset)", async () => {
    const model = scriptedModel([
      [{ name: "begin_map", input: { width: 20, height: 14, baseTerrain: "void", name: "Hollow", description: "A dark cavern." } }],
      [{ name: "stamp_room", input: { x: 3, y: 3, w: 10, h: 7, floor: "cave_dust", walls: false } }],
      [{ name: "wall_around_floor", input: {} }],
      [{ name: "finish", input: { name: "The Hollow", description: "A dust-floored cavern." } }],
    ]);
    const map = await runAgenticBuild(model, DEFS, { prompt: "a cavern" });
    expect(map.tilesets.some((t) => t.source.includes("cave_and_urban_floors"))).toBe(true);
  });
});

/** Rebuild a MapCanvas from a ComposedMap's flat arrays for connectivity checks. */
function canvasFrom(map: { width: number; height: number; terrainData: number[]; objectData: number[] }): MapCanvas {
  const c = new MapCanvas({ width: map.width, height: map.height, seed: 1 });
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    c.setGround(x, y, map.terrainData[y * map.width + x]);
    c.setObject(x, y, map.objectData[y * map.width + x]);
  }
  return c;
}
