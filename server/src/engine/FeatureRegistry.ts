// Class-feature handler registry.
//
// Each entry maps a FeatureDef.handler string to a function that resolves the
// mechanical effect of using that feature (consume resource, apply effect,
// update state, log narrative). New class features are added by:
//   1. Authoring `server/data/features/{id}.json` (data shape — see SpellDef
//      sibling).
//   2. Registering a handler here keyed on the JSON's `handler` field.
//
// Resource consumption is the handler's responsibility — the dispatcher
// (`doUseFeature` below) only validates eligibility via `canUseFeature`.
//
// Reactive features (Shield, Uncanny Dodge) don't go through this dispatcher;
// they fire from inside the relevant resolver (CombatFlow, etc.). The registry
// still owns their resource bookkeeping when applicable.

import type { GameContext } from './GameContext.js';
import { combatantDisplayName } from './DisplayNames.js';
import type { GameEvent } from './types.js';
import { canUseFeature, playerArmorSpeedPenaltyFt } from './ActionGuards.js';
import { speedAfterExhaustion } from './ConditionSystem.js';
import { applySelfBuff } from './Buffs.js';
import { applyCloudsJaunt } from './GiantGifts.js';
import { playerSecondWind } from './CombatSystem.js';
import { spellSaveDC, spellMod, npcSaveMod } from './SpellSystem.js';

import { chebyshev } from './EnemyAI.js';
import { d, d20 } from './Dice.js';

export interface FeatureUseAction {
  targetId?: string;
  tile?: { x: number; y: number };
}

export type FeatureHandler = (
  ctx: GameContext,
  featureId: string,
  action: FeatureUseAction,
  events: GameEvent[],
) => void;

const handlers: Record<string, FeatureHandler> = {};

export function registerFeatureHandler(id: string, fn: FeatureHandler): void {
  handlers[id] = fn;
}

/**
 * Dispatcher entry point — used by `GameEngine.useFeature`. Validates with
 * the shared `canUseFeature` guard (so the UI and the server agree on what's
 * legal), then runs the registered handler. Unknown / handler-less features
 * silently no-op.
 */
export function doUseFeature(
  ctx: GameContext,
  featureId: string,
  action: FeatureUseAction,
  events: GameEvent[],
): void {
  if (!canUseFeature(ctx, featureId)) return;
  const feat = ctx.defs.features.find((f) => f.id === featureId);
  if (!feat?.handler) return;
  const fn = handlers[feat.handler];
  if (!fn) return;
  fn(ctx, featureId, action, events);
}

// ── Handlers ────────────────────────────────────────────────────────────────

registerFeatureHandler('second-wind', (ctx, featureId) => {
  const s = ctx.state;
  const { healed, logs } = playerSecondWind(ctx.playerDef.level);
  const before = s.player.hp;
  s.player.hp = Math.min(ctx.playerDef.maxHp, s.player.hp + healed);
  s.player.resources[featureId] = Math.max(0, (s.player.resources[featureId] ?? 0) - 1);
  ctx.addLogs([
    ...logs,
    { left: `HP: ${before} → ${s.player.hp}/${ctx.playerDef.maxHp} (${s.player.resources[featureId]} uses left)`, style: 'status' },
  ]);
  s.player.bonusActionUsed = true;
});

/**
 * Magical Cunning (Warlock L2). A 1-minute rite that regains expended Pact
 * Magic spell slots, up to half the maximum (round up). Once per Long Rest.
 */
registerFeatureHandler('magical-cunning', (ctx, featureId) => {
  const s = ctx.state;
  const pact = s.player.pactMagic;
  if (!pact) return;
  const restored = Math.min(pact.max - pact.remaining, Math.ceil(pact.max / 2));
  pact.remaining += restored;
  s.player.resources[featureId] = Math.max(0, (s.player.resources[featureId] ?? 0) - 1);
  ctx.addLog({
    left: `${ctx.playerDef.name} performs an esoteric rite — regains ${restored} Pact Magic slot${restored === 1 ? '' : 's'} (${s.player.resources[featureId]} use left).`,
    style: 'status',
  });
});

/**
 * Action Surge (Fighter L2+). Refreshes the Action this turn — the player
 * may take one more Action (the SRD excludes the Magic action; we don't
 * model that constraint yet because the engine has no concept of "the second
 * Action this turn cannot be Magic" — revisit if it ever matters in practice).
 * Consumes 1 use from the short-rest pool. Refilled on Short or Long Rest.
 */
registerFeatureHandler('action-surge', (ctx, featureId) => {
  const s = ctx.state;
  s.player.actionUsed = false;
  s.player.resources[featureId] = Math.max(0, (s.player.resources[featureId] ?? 0) - 1);
  const remaining = s.player.resources[featureId] ?? 0;
  ctx.addLog({
    left: `${ctx.playerDef.name} uses Action Surge — additional Action this turn (${remaining}/1 left until short rest)`,
    style: 'status',
  });
});

/**
 * Steady Aim (Rogue L3). Spends a Bonus Action to grant the rogue
 * Advantage on their next attack this turn; afterwards their Speed is
 * 0 until end of turn. The "haven't moved" prerequisite is checked by
 * `canUseFeature` (gates the button); this handler just sets the
 * one-shot flag the attack resolver consults and zeroes `movesLeft`.
 */
registerFeatureHandler('steady-aim', (ctx) => {
  const s = ctx.state;
  s.player.steadyAim = true;
  s.player.bonusActionUsed = true;
  s.player.movesLeft = 0;
  ctx.addLog({
    left: `${ctx.playerDef.name} steadies their aim — Advantage on the next attack this turn`,
    style: 'status',
  });
});

/**
 * Adrenaline Rush (Orc species, US-122). A Bonus Action that takes the Dash
 * action (extra movement equal to Speed, after exhaustion + armor reductions —
 * mirroring `doDash`) and grants Temporary Hit Points equal to the Proficiency
 * Bonus. Temp HP does not stack — keep the higher pool. Uses = PB, refilled on
 * a Short or Long Rest (the static `resource.max` of 2 matches PB at the level
 * band, same precedent as Channel Divinity).
 */
registerFeatureHandler('adrenaline-rush', (ctx, featureId) => {
  const s = ctx.state;
  const dashFt = Math.max(0, speedAfterExhaustion(ctx.playerDef.speed + (s.player.speedBonus ?? 0), s.player.exhaustionLevel ?? 0) - playerArmorSpeedPenaltyFt(ctx));
  s.player.movesLeft += dashFt / 5;
  if (!s.player.conditions.includes('dashing')) s.player.conditions.push('dashing');
  const pb = ctx.playerDef.proficiencyBonus;
  s.player.tempHp = Math.max(s.player.tempHp, pb);
  s.player.resources[featureId] = Math.max(0, (s.player.resources[featureId] ?? 0) - 1);
  s.player.bonusActionUsed = true;
  ctx.addLog({
    left: `${ctx.playerDef.name} surges with adrenaline — Dash (+${dashFt / 5} tiles) and ${pb} Temp HP (${s.player.resources[featureId]} uses left)`,
    style: 'status',
  });
});

/**
 * Stonecunning (Dwarf species, US-122). A Bonus Action that grants Tremorsense
 * 60 ft via a self-buff (`sense` modifier → `recomputeBuffs` → `buffSenses`,
 * overlaid by the Vision layer). Uses = PB, refilled on a Long Rest. SRD ties
 * this to touching a stone surface; the map has no stone-surface tile concept,
 * so that prerequisite is not modelled.
 */
registerFeatureHandler('stonecunning', (ctx, featureId) => {
  const s = ctx.state;
  applySelfBuff(ctx, { spellId: 'stonecunning', modifiers: [{ type: 'sense', sense: 'tremorsense', range: 60 }] });
  s.player.resources[featureId] = Math.max(0, (s.player.resources[featureId] ?? 0) - 1);
  s.player.bonusActionUsed = true;
  ctx.addLog({
    left: `${ctx.playerDef.name} reads the trembling stone — Tremorsense 60 ft (${s.player.resources[featureId]} uses left)`,
    style: 'status',
  });
});

/**
 * Large Form (Goliath species L5+, US-122). A Bonus Action that turns the
 * Goliath Large and grants +10 ft Speed via a self-buff (`size` + `speed-bonus`
 * modifiers → `recomputeBuffs`). Once per Long Rest. SRD also grants Advantage
 * on Strength checks for the duration; ability checks have no advantage-source
 * consumer yet, so that rider is not modelled (mirrors the Action Surge "no
 * Magic action" gap — documented, not silently dropped).
 */
registerFeatureHandler('large-form', (ctx, featureId) => {
  const s = ctx.state;
  applySelfBuff(ctx, { spellId: 'large-form', modifiers: [{ type: 'size', size: 'large' }, { type: 'speed-bonus', value: 10 }] });
  s.player.resources[featureId] = Math.max(0, (s.player.resources[featureId] ?? 0) - 1);
  s.player.bonusActionUsed = true;
  ctx.addLog({
    left: `${ctx.playerDef.name} swells to Large — +10 ft Speed and the reach to grapple bigger foes`,
    style: 'status',
  });
});

/**
 * Cloud's Jaunt (Goliath Giant Ancestry, US-122). A Bonus Action teleport up to
 * 30 ft to a chosen tile. The client sends the destination as `action.tile`;
 * the gift validates range / passability / occupancy and spends a shared use.
 */
registerFeatureHandler('clouds-jaunt', (ctx, _featureId, action) => {
  applyCloudsJaunt(ctx, action.tile);
});

// ── Cleric Channel Divinity (US-120) ─────────────────────────────────────────
// The three options below share one pool held on the `channel-divinity` feature
// (gated in `canUseFeature`). Each spends one use from that shared key.

const CHANNEL_DIVINITY_RANGE_TILES = 6;  // 30 ft

function spendChannelDivinity(ctx: GameContext): void {
  const r = ctx.state.player.resources;
  r['channel-divinity'] = Math.max(0, (r['channel-divinity'] ?? 0) - 1);
}

/** SRD Turn Undead — each Undead of your choice within 30 ft makes a WIS save
 *  or is Frightened + Incapacitated. We affect every undead in range. */
registerFeatureHandler('turn-undead', (ctx) => {
  const s = ctx.state;
  const dc = spellSaveDC(ctx);
  const targets = s.npcs.filter((n) => {
    if (n.hp <= 0) return false;
    const def = ctx.resolveMonsterDef(n.defId);
    if (!def || !def.type.toLowerCase().includes('undead')) return false;
    return chebyshev(s.player.tileX, s.player.tileY, n.tileX, n.tileY) <= CHANNEL_DIVINITY_RANGE_TILES;
  });
  if (targets.length === 0) {
    ctx.addLog({ left: `${ctx.playerDef.name} channels Turn Undead — no Undead within range`, style: 'status' });
    return;  // don't waste a use on an empty censure
  }
  ctx.addLog({ left: `${ctx.playerDef.name} presents a Holy Symbol — Turn Undead (DC ${dc})`, style: 'header' });
  for (const npc of targets) {
    const def = ctx.resolveMonsterDef(npc.defId)!;
    const roll = d20();
    const bonus = npcSaveMod(npc, def, 'wis');
    const total = roll + bonus;
    const right = `WIS d20(${roll})+${bonus}=${total} vs DC ${dc}`;
    if (total < dc) {
      for (const c of ['frightened', 'incapacitated']) {
        if (!npc.conditions.includes(c)) npc.conditions.push(c);
      }
      ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} is turned — Frightened & Incapacitated`, right, style: 'status' });
    } else {
      ctx.addLog({ left: `${combatantDisplayName(npc, s.npcs)} resists`, right, style: 'normal' });
    }
  }
  spendChannelDivinity(ctx);
  s.player.actionUsed = true;
});

/** SRD Divine Spark — roll d8s + WIS mod; heal the selected ally/self, or force
 *  a CON save on the selected enemy for Radiant damage (half on success). */
registerFeatureHandler('divine-spark', (ctx) => {
  const s = ctx.state;
  const tid = s.selectedTargetId;
  const lvl = ctx.playerDef.level;
  const dice = lvl >= 18 ? 4 : lvl >= 13 ? 3 : lvl >= 7 ? 2 : 1;
  let rolled = 0;
  for (let i = 0; i < dice; i++) rolled += d(8);
  const amount = Math.max(1, rolled + spellMod(ctx));

  const ally = tid && tid !== 'player' ? s.npcs.find((n) => n.id === tid && n.disposition === 'ally') : undefined;
  const enemy = tid && tid !== 'player' ? s.npcs.find((n) => n.id === tid && n.hp > 0 && n.disposition !== 'ally') : undefined;

  // Heal mode — self or a chosen ally.
  if (tid === 'player' || ally) {
    if (ally) {
      const before = ally.hp;
      ally.hp = Math.min(ally.maxHp, ally.hp + amount);
      if (before <= 0 && ally.hp > 0) ally.conditions = ally.conditions.filter((c) => c !== 'unconscious' && c !== 'stable');
      ctx.addLog({ left: `${ctx.playerDef.name} channels Divine Spark — ${combatantDisplayName(ally, s.npcs)} regains ${ally.hp - before} HP`, style: 'heal' });
    } else {
      const before = s.player.hp;
      s.player.hp = Math.min(ctx.playerDef.maxHp, s.player.hp + amount);
      ctx.addLog({ left: `${ctx.playerDef.name} channels Divine Spark — regains ${s.player.hp - before} HP`, style: 'heal' });
    }
    spendChannelDivinity(ctx);
    s.player.actionUsed = true;
    return;
  }

  // Damage mode — the selected enemy makes a CON save for half.
  if (!enemy) {
    ctx.addLog({ left: `Divine Spark: select a creature within 30 feet first.`, style: 'miss' });
    return;
  }
  const def = ctx.resolveMonsterDef(enemy.defId);
  if (!def) return;
  if (chebyshev(s.player.tileX, s.player.tileY, enemy.tileX, enemy.tileY) > CHANNEL_DIVINITY_RANGE_TILES) {
    ctx.addLog({ left: `Divine Spark: ${combatantDisplayName(enemy, s.npcs)} is out of range`, style: 'miss' });
    return;
  }
  const dc = spellSaveDC(ctx);
  const roll = d20();
  const bonus = npcSaveMod(enemy, def, 'con');
  const total = roll + bonus;
  const saved = total >= dc;
  const { finalDamage, log } = ctx.resistMod(saved ? Math.floor(amount / 2) : amount, 'radiant', def, enemy.name);
  const before = enemy.hp;
  enemy.hp = Math.max(0, enemy.hp - finalDamage);
  ctx.addLog({ left: `Divine Spark sears ${combatantDisplayName(enemy, s.npcs)} for ${finalDamage} radiant${saved ? ' (save)' : ''}`, right: `CON d20(${roll})+${bonus}=${total} vs DC ${dc}`, style: 'hit' });
  if (log) ctx.addLog(log);
  if (enemy.hp <= 0 && before > 0) ctx.killWithReward(enemy, def, `☠ ${combatantDisplayName(enemy, s.npcs)} is unmade by radiant fire!`);
  spendChannelDivinity(ctx);
  s.player.actionUsed = true;
});

/** SRD Life Domain Preserve Life — restore 5×level HP split among Bloodied
 *  creatures (self + allies) within 30 ft, none above half their max HP. */
registerFeatureHandler('preserve-life', (ctx) => {
  const s = ctx.state;
  let pool = 5 * ctx.playerDef.level;
  const isBloodied = (hp: number, maxHp: number) => hp <= Math.floor(maxHp / 2);

  // Heal targets in priority order: self first, then bloodied allies in range.
  const healOne = (cur: number, maxHp: number): number => {
    const half = Math.floor(maxHp / 2);
    if (cur >= half) return cur;                 // already at/above half — skip
    const grant = Math.min(pool, half - cur);
    pool -= grant;
    return cur + grant;
  };

  let healedAny = false;
  if (pool > 0 && isBloodied(s.player.hp, ctx.playerDef.maxHp)) {
    const before = s.player.hp;
    s.player.hp = healOne(s.player.hp, ctx.playerDef.maxHp);
    if (s.player.hp > before) { healedAny = true; ctx.addLog({ left: `Preserve Life — ${ctx.playerDef.name} regains ${s.player.hp - before} HP`, style: 'heal' }); }
  }
  for (const npc of s.npcs) {
    if (pool <= 0) break;
    if (npc.disposition !== 'ally' || npc.hp <= 0) continue;
    if (chebyshev(s.player.tileX, s.player.tileY, npc.tileX, npc.tileY) > CHANNEL_DIVINITY_RANGE_TILES) continue;
    if (!isBloodied(npc.hp, npc.maxHp)) continue;
    const before = npc.hp;
    npc.hp = healOne(npc.hp, npc.maxHp);
    if (npc.hp > before) { healedAny = true; ctx.addLog({ left: `Preserve Life — ${combatantDisplayName(npc, s.npcs)} regains ${npc.hp - before} HP`, style: 'heal' }); }
  }

  if (!healedAny) {
    ctx.addLog({ left: `Preserve Life — no Bloodied creatures within range to heal`, style: 'status' });
    return;  // don't spend a use when it would do nothing
  }
  spendChannelDivinity(ctx);
  s.player.actionUsed = true;
});
