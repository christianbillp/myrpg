/**
 * SRD Mage "Protective Magic" — Shield half (US-117, mage-monster-plan.md
 * slice 3). A reaction-cast Shield against an attack roll, spent from the
 * shared 3/day pool seeded on `NpcState.reactionUses`: +5 AC vs the
 * triggering attack, persisting until the start of the NPC's next turn via
 * the `shielded` TURN_CONDITION (read by every attack path through
 * `shieldAcBonus`). Counterspell, the pool's other half, lands in slice 6.
 */
import { describe, it, expect } from 'vitest';
import { doAttack } from './CombatActions.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { TURN_CONDITIONS, shieldAcBonus } from './ConditionSystem.js';
import type { MonsterDef, PlayerAttack } from './types.js';

const SWORD: PlayerAttack = {
  name: 'Sword', statKey: 'str', damageDice: 1, damageSides: 8, damageType: 'slashing',
  savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false,
  push: false, topple: false,
};

function mageling(): MonsterDef {
  return {
    id: 'mageling', name: 'Mageling', type: 'Medium Humanoid', maxHp: 30, ac: 1,
    str: 9, dex: 14, con: 11, int: 17, wis: 12, cha: 11,
    proficiencyBonus: 3, initiativeBonus: 2, stealthBonus: 2, passivePerception: 14,
    speed: 30, attacks: [], xp: 2300, cr: '6', color: 0, tokenAsset: 'x.svg', size: 'medium',
    reactions: [{ kind: 'protective-magic', usesPerDay: 3 }],
  } as MonsterDef;
}

function scenario(opts: { str: number; poolLeft: number }) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 0, tileY: 0 },
    playerDef: { mainAttack: SWORD, str: opts.str, proficiencyBonus: 2 },
    monsters: [mageling()],
    npcs: [makeNpc({
      id: 'mage_x', defId: 'mageling', tileX: 1, tileY: 0, disposition: 'enemy',
      hp: 30, maxHp: 30,
      reactionUses: { 'protective-magic': opts.poolLeft },
    })],
  });
  r.state.environment = { lightLevel: 'bright' };
  r.state.traps = [];
  return r;
}

const logText = (logs: Array<{ left: string }>) => logs.map((l) => l.left).join('\n');

describe('Protective Magic — Shield (US-117 slice 3)', () => {
  it('a hit that the +5 cannot beat still lands, but spends the reaction + pool and applies `shielded`', () => {
    // STR 30 (+10) + prof 2 vs AC 1: every hit total ≥ 13 also beats AC 6,
    // so the Shield is cast and wasted. Retry past natural-1 misses.
    for (let i = 0; i < 60; i++) {
      const { ctx, state, events, logs } = scenario({ str: 30, poolLeft: 3 });
      doAttack(ctx, 'mage_x', events);
      const npc = state.npcs[0];
      if (npc.hp === npc.maxHp) continue; // nat-1 miss — no hit, no trigger
      if (logText(logs).includes('Critical hit')) continue; // nat 20 — crits bypass Shield (SRD)
      expect(logText(logs)).toContain('casts Shield — +5 AC, but the strike lands anyway (Protective Magic 2 left)');
      expect(npc.reactionUses?.['protective-magic']).toBe(2);
      expect(npc.reactionUsed).toBe(true);
      expect(npc.conditions).toContain('shielded');
      return;
    }
    throw new Error('attack never landed in 60 tries');
  });

  it('flips a marginal hit into a miss (no damage) and logs the deflection', () => {
    // STR 1 (−5) vs AC 1 → +5 turns rolls 6–10 into misses (~25%/try).
    for (let i = 0; i < 200; i++) {
      const { ctx, state, events, logs } = scenario({ str: 1, poolLeft: 3 });
      doAttack(ctx, 'mage_x', events);
      const npc = state.npcs[0];
      if (!logText(logs).includes('turns the strike aside')) continue;
      expect(npc.hp).toBe(npc.maxHp); // the flipped hit dealt no damage
      expect(npc.reactionUses?.['protective-magic']).toBe(2);
      expect(npc.conditions).toContain('shielded');
      return;
    }
    throw new Error('no shield-deflection observed in 200 tries');
  });

  it('does not trigger with an empty pool — the hit lands at base AC', () => {
    for (let i = 0; i < 60; i++) {
      const { ctx, state, events, logs } = scenario({ str: 30, poolLeft: 0 });
      doAttack(ctx, 'mage_x', events);
      const npc = state.npcs[0];
      if (npc.hp === npc.maxHp) continue; // nat-1 miss
      expect(logText(logs)).not.toContain('casts Shield');
      expect(npc.conditions).not.toContain('shielded');
      return;
    }
    throw new Error('attack never landed in 60 tries');
  });

  it('`shielded` grants +5 AC to later attacks and clears at the start of its own turn', () => {
    expect(shieldAcBonus(['shielded'])).toBe(5);
    expect(shieldAcBonus([])).toBe(0);
    // TURN_CONDITIONS membership is what the NPC turn runners filter on —
    // it guarantees the SRD "until the start of its next turn" expiry.
    expect(TURN_CONDITIONS).toContain('shielded');
  });
});
