/**
 * Self-buff registry tests. Verifies the data-driven buffs derive the legacy
 * fields the rest of the engine reads, apply/strip conditions, and that
 * concentration end (removeBuffsForSpell) cleans them up + recomputes.
 */
import { describe, it, expect } from "vitest";
import type { GameContext } from "./GameContext.js";
import type { PlayerDef } from "./types.js";
import { applySelfBuff, removeBuffsForSpell, recomputeBuffs } from "./Buffs.js";

function mkCtx() {
  const player = {
    activeBuffs: [] as NonNullable<GameContext["state"]["player"]["activeBuffs"]>,
    conditions: [] as string[],
    equippedSlots: { armorId: null, weaponId: null, shieldId: null },
    mageArmor: false,
    shieldActive: false,
    magicWeaponBonus: 0,
    speedBonus: 0,
    seeInvisible: false,
  };
  const playerDef = { dex: 14, str: 10 } as unknown as PlayerDef;
  const ctx = { state: { player }, playerDef, defs: { equipment: [] } } as unknown as GameContext;
  return { ctx, player, playerDef };
}

describe("self-buff registry", () => {
  it("derives legacy fields from buff modifiers", () => {
    const { ctx, player, playerDef } = mkCtx();
    applySelfBuff(ctx, { spellId: "see-invisibility", modifiers: [{ type: "flag", name: "see-invisible" }] });
    applySelfBuff(ctx, { spellId: "longstrider", modifiers: [{ type: "speed-bonus", value: 10 }] });
    applySelfBuff(ctx, { spellId: "magic-weapon", modifiers: [{ type: "weapon-bonus", value: 2 }], concentration: true });
    expect(player.seeInvisible).toBe(true);
    expect(player.speedBonus).toBe(10);
    expect(player.magicWeaponBonus).toBe(2);
    expect(playerDef.mainAttack?.magicWeaponBonus).toBe(2); // rebuilt onto the attack
  });

  it("applies and strips player conditions (Blur)", () => {
    const { ctx, player } = mkCtx();
    applySelfBuff(ctx, { spellId: "blur", playerConditions: ["blurred"], concentration: true });
    expect(player.conditions).toContain("blurred");
    removeBuffsForSpell(ctx, "blur");
    expect(player.conditions).not.toContain("blurred");
    expect(player.activeBuffs).toHaveLength(0);
  });

  it("removeBuffsForSpell resets derived fields and leaves other buffs intact", () => {
    const { ctx, player } = mkCtx();
    applySelfBuff(ctx, { spellId: "magic-weapon", modifiers: [{ type: "weapon-bonus", value: 3 }], concentration: true });
    applySelfBuff(ctx, { spellId: "longstrider", modifiers: [{ type: "speed-bonus", value: 10 }] });
    removeBuffsForSpell(ctx, "magic-weapon");
    expect(player.magicWeaponBonus).toBe(0);  // reset
    expect(player.speedBonus).toBe(10);        // unrelated buff survives
    expect(player.activeBuffs?.map((b) => b.spellId)).toEqual(["longstrider"]);
  });

  it("re-casting the same buff replaces rather than duplicates", () => {
    const { ctx, player } = mkCtx();
    applySelfBuff(ctx, { spellId: "magic-weapon", modifiers: [{ type: "weapon-bonus", value: 1 }], concentration: true });
    applySelfBuff(ctx, { spellId: "magic-weapon", modifiers: [{ type: "weapon-bonus", value: 3 }], concentration: true });
    expect(player.activeBuffs).toHaveLength(1);
    expect(player.magicWeaponBonus).toBe(3);
  });

  it("removeBuffsForSpell is a no-op when no matching buff", () => {
    const { ctx, player } = mkCtx();
    removeBuffsForSpell(ctx, "nothing");
    expect(player.activeBuffs).toHaveLength(0);
    recomputeBuffs(ctx);
    expect(player.magicWeaponBonus).toBe(0);
  });
});
