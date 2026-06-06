/**
 * Unit tests for the modifier aggregator — the data-driven layer that replaces
 * scattered `includes(featId)` branches. Verifies feats + features both
 * contribute, the typed queries resolve, and the legacy AC/attack booleans are
 * derived from the aggregated modifiers.
 */
import { describe, it, expect } from "vitest";
import type { FeatDef, FeatureDef, PlayerDef } from "./types.js";
import { collectModifiers, applyModifiers, critFloor, hasModifierFlag, hasAdvantageOn } from "./Modifiers.js";

const feat = (id: string, modifiers: FeatDef["modifiers"]): FeatDef =>
  ({ id, name: id, category: "general", prerequisites: { minLevel: null, minAbilityScore: null, requiresFeature: null, repeatable: false }, description: "", effects: {}, modifiers } as FeatDef);
const feature = (id: string, modifiers: FeatureDef["modifiers"]): FeatureDef =>
  ({ id, name: id, classId: "x", minLevel: 1, description: "", cost: { kind: "passive" }, modifiers } as FeatureDef);
const player = (featIds: string[], featureIds: string[]): PlayerDef =>
  ({ featIds, defaultFeatureIds: featureIds } as unknown as PlayerDef);

const FEATS: FeatDef[] = [
  feat("savage-attacker", [{ type: "flag", name: "savage-attacker" }]),
  feat("defense", [{ type: "flag", name: "fighting-style-defense" }]),
  feat("alert", [{ type: "advantage", on: "initiative" }]),
];
const FEATURES: FeatureDef[] = [
  feature("improved-critical", [{ type: "crit-range", min: 19 }]),
  feature("superior-critical", [{ type: "crit-range", min: 18 }]),
  feature("potent-cantrip", [{ type: "flag", name: "potent-cantrip" }]),
  feature("remarkable-athlete", [{ type: "advantage", on: "initiative" }]),
  feature("plain", undefined),
];

describe("modifier aggregator", () => {
  it("collects modifiers from both feats and class features", () => {
    const p = player(["savage-attacker"], ["improved-critical", "plain"]);
    const mods = collectModifiers(p, FEATS, FEATURES);
    expect(mods).toHaveLength(2);
    expect(mods.some((m) => m.type === "flag" && m.name === "savage-attacker")).toBe(true);
    expect(mods.some((m) => m.type === "crit-range")).toBe(true);
  });

  it("critFloor defaults to 20 and takes the lowest crit-range min", () => {
    const none = player([], []); applyModifiers(none, FEATS, FEATURES);
    expect(critFloor(none)).toBe(20);
    const imp = player([], ["improved-critical"]); applyModifiers(imp, FEATS, FEATURES);
    expect(critFloor(imp)).toBe(19);
    const both = player([], ["improved-critical", "superior-critical"]); applyModifiers(both, FEATS, FEATURES);
    expect(critFloor(both)).toBe(18);
  });

  it("hasModifierFlag / hasAdvantageOn answer from the aggregated list", () => {
    const p = player(["alert"], ["potent-cantrip"]); applyModifiers(p, FEATS, FEATURES);
    expect(hasModifierFlag(p, "potent-cantrip")).toBe(true);
    expect(hasModifierFlag(p, "savage-attacker")).toBe(false);
    expect(hasAdvantageOn(p, "initiative")).toBe(true);
    expect(hasAdvantageOn(p, "attack")).toBe(false);
  });

  it("advantage key narrows checks/saves", () => {
    const p = player([], []); p.modifiers = [{ type: "advantage", on: "check", key: "athletics" }];
    expect(hasAdvantageOn(p, "check", "athletics")).toBe(true);
    expect(hasAdvantageOn(p, "check", "stealth")).toBe(false);
    expect(hasAdvantageOn(p, "check")).toBe(true); // any check
  });

  it("applyModifiers derives the legacy AC/attack booleans from flags", () => {
    const p = player(["savage-attacker", "defense"], []);
    applyModifiers(p, FEATS, FEATURES);
    expect(p.savageAttacker).toBe(true);
    expect(p.fightingStyleDefense).toBe(true);
    const q = player([], []);
    applyModifiers(q, FEATS, FEATURES);
    expect(q.savageAttacker).toBe(false);
    expect(q.fightingStyleDefense).toBe(false);
  });
});
