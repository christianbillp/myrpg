/**
 * Self-buff registry tests. Verifies the data-driven buffs derive the legacy
 * fields the rest of the engine reads, apply/strip conditions, and that
 * concentration end (removeBuffsForSpell) cleans them up + recomputes.
 */
import { describe, it, expect } from "vitest";
import type { GameContext } from "./GameContext.js";
import type { PlayerDef, ActiveBuff } from "./types.js";
import { applySelfBuff, removeBuffsForSpell, recomputeBuffs, applyBuffTo, removeSpellBuffsFrom } from "./Buffs.js";

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
    expeditiousRetreat: false,
    enhancedAbility: undefined as undefined | "str" | "dex" | "con" | "int" | "wis" | "cha",
    mirrorImages: 0,
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

  it("derives the expeditious-retreat flag and clears it on concentration end", () => {
    const { ctx, player } = mkCtx();
    applySelfBuff(ctx, { spellId: "expeditious-retreat", modifiers: [{ type: "flag", name: "expeditious-retreat" }], concentration: true });
    expect(player.expeditiousRetreat).toBe(true);
    removeBuffsForSpell(ctx, "expeditious-retreat");
    expect(player.expeditiousRetreat).toBe(false);
  });

  it("projects the enhanced-ability modifier onto enhancedAbility and clears it on end", () => {
    const { ctx, player } = mkCtx();
    applySelfBuff(ctx, { spellId: "enhance-ability", modifiers: [{ type: "enhanced-ability", ability: "con" }], concentration: true });
    expect(player.enhancedAbility).toBe("con");
    removeBuffsForSpell(ctx, "enhance-ability");
    expect(player.enhancedAbility).toBeUndefined();
  });

  it("applies and strips player conditions (Blur)", () => {
    const { ctx, player } = mkCtx();
    applySelfBuff(ctx, { spellId: "blur", conditions: ["blurred"], concentration: true });
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

  it("Mage Armor: the flag buff derives mageArmor + AC, cleared on removal", () => {
    const { ctx, player, playerDef } = mkCtx();
    applySelfBuff(ctx, { spellId: "mage-armor", modifiers: [{ type: "flag", name: "mage-armor" }] });
    expect(player.mageArmor).toBe(true);
    expect(playerDef.ac).toBe(15); // 13 + DEX(+2)
    removeBuffsForSpell(ctx, "mage-armor");
    expect(player.mageArmor).toBe(false);
    expect(playerDef.ac).toBe(12); // 10 + DEX(+2)
  });

  it("Mirror Image: charges derive mirrorImages and clear at zero", () => {
    const { ctx, player } = mkCtx();
    applySelfBuff(ctx, { spellId: "mirror-image", charges: 3 });
    expect(player.mirrorImages).toBe(3);
    const buff = player.activeBuffs!.find((b) => b.spellId === "mirror-image")!;
    buff.charges = 2;
    recomputeBuffs(ctx);
    expect(player.mirrorImages).toBe(2);
    removeBuffsForSpell(ctx, "mirror-image");
    expect(player.mirrorImages).toBe(0);
  });

  it("creature-agnostic: a buff applied to an NPC carries + clears its condition", () => {
    const npc = { conditions: [] as string[], activeBuffs: [] as ActiveBuff[] };
    applyBuffTo(npc, { spellId: "invisibility", conditions: ["invisible"], concentration: true });
    expect(npc.conditions).toContain("invisible");
    expect(npc.activeBuffs).toHaveLength(1);
    expect(removeSpellBuffsFrom(npc, "invisibility")).toBe(true);
    expect(npc.conditions).not.toContain("invisible");
    expect(npc.activeBuffs).toHaveLength(0);
    expect(removeSpellBuffsFrom(npc, "invisibility")).toBe(false); // idempotent
  });

  it("removeBuffsForSpell is a no-op when no matching buff", () => {
    const { ctx, player } = mkCtx();
    removeBuffsForSpell(ctx, "nothing");
    expect(player.activeBuffs).toHaveLength(0);
    recomputeBuffs(ctx);
    expect(player.magicWeaponBonus).toBe(0);
  });
});
