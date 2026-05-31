// Single source of truth for "can the player take action X right now?".
// Both computeAvailableActions (UI hint) and the action handlers (server
// enforcement) call into these — never re-derive the same preconditions.

import type { GameContext } from './GameContext.js';
import { isIncapacitated } from './ConditionSystem.js';
import { chebyshev } from './EnemyAI.js';
import { isHostileTo } from './FactionRelations.js';
import { PLAYER_FACTION_ID } from '../../../shared/types.js';

/** Can the player spend their Action right now (any Action — Attack, Dash, etc.)? */
export function canSpendAction(ctx: GameContext): boolean {
  const s = ctx.state;
  return s.phase === 'player_turn'
    && !s.player.actionUsed
    && !isIncapacitated(s.player.conditions);
}

/** Can the player spend their Bonus Action right now? */
export function canSpendBonusAction(ctx: GameContext): boolean {
  const s = ctx.state;
  return s.phase === 'player_turn'
    && !s.player.bonusActionUsed
    && !isIncapacitated(s.player.conditions);
}

/** Are there any living enemies the player can be targeted by / can target? */
export function hasLivingEnemies(ctx: GameContext): boolean {
  const s = ctx.state;
  const partyView = { factionId: PLAYER_FACTION_ID } as const;
  return s.npcs.some((n) => n.hp > 0
    && isHostileTo(s, partyView, { factionId: n.factionId, disposition: n.disposition }));
}

/**
 * True when the player has Cunning Action (Rogue level 2+): Hide is a Bonus Action.
 * Before level 2, a Rogue still has Hide available but it costs the full Action.
 */
export function hasCunningAction(ctx: GameContext): boolean {
  return ctx.playerDef.sneakAttackDice > 0 && ctx.playerDef.level >= 2;
}

/** Can the player Hide right now? Cost depends on phase + Cunning Action.
 *  SRD 5.2.1: Hide is a general Action available to every character — the
 *  earlier Rogue-only restriction was a UI carve-out that we've dropped so
 *  Wizards / Clerics / non-rogues can also conceal themselves before an
 *  encounter starts or set up a Cast-from-cover opener. */
export function canHide(ctx: GameContext): boolean {
  const s = ctx.state;
  if (s.player.conditions.includes('hidden')) return false;
  // Exploring: no action economy and no enemy gate — the player can hide
  // proactively, e.g. to set up a Sneak Attack opener against currently-
  // neutral NPCs (bandits, etc.) before turning them hostile.
  if (s.phase === 'exploring') return true;
  if (s.phase !== 'player_turn') return false;
  // In combat: must have something to hide from, and pay the right resource.
  if (!hasLivingEnemies(ctx)) return false;
  return hasCunningAction(ctx) ? canSpendBonusAction(ctx) : canSpendAction(ctx);
}

/**
 * Can the player use the given class feature right now?
 *
 * Eligibility chain:
 *   1. The character must know the feature (its id appears in `defaultFeatureIds`).
 *   2. The feature must have enough of its resource remaining (or be `unlimited`).
 *   3. Action economy must match the feature's `cost` (reactions are handled
 *      separately by the resolvers that trigger them, never via this guard).
 *   4. Feature-specific situational checks (e.g. Second Wind requires below-max HP)
 *      — kept short here; complex preconditions belong in the handler.
 */
export function canUseFeature(ctx: GameContext, featureId: string): boolean {
  const s = ctx.state;
  const knowsIt = ctx.playerDef.defaultFeatureIds?.includes(featureId);
  if (!knowsIt) return false;
  if (isIncapacitated(s.player.conditions)) return false;
  const feat = ctx.defs.features.find((f) => f.id === featureId);
  if (!feat) return false;

  // Resource pool gate.
  if (feat.resource && feat.resource.kind !== 'unlimited') {
    const remaining = s.player.resources[featureId] ?? 0;
    if (remaining <= 0) return false;
  }

  // Action-economy gate.
  switch (feat.cost.kind) {
    case 'action':       if (!canSpendAction(ctx)) return false; break;
    case 'bonus-action': if (!canSpendBonusAction(ctx)) return false; break;
    case 'reaction':     return false;  // Reactive features fire from resolvers, not from this guard.
    case 'free':
    case 'attack-time':
    case 'passive':      /* no economy cost */ break;
  }

  // Feature-specific situational rules (kept minimal; per-feature exotica
  // belong in the handler, not here — this is just so the UI can grey out the
  // button when there's literally no point in clicking it).
  if (featureId === 'second-wind') {
    if (s.player.hp >= ctx.playerDef.maxHp) return false;
  }
  if (featureId === 'action-surge') {
    // Only meaningful during the player's combat turn AFTER the Action has
    // been spent — Surging before using the Action is wasted economy.
    if (s.phase !== 'player_turn') return false;
    if (!s.player.actionUsed) return false;
  }

  return true;
}

/** All feature ids the character can use right now — used to populate the UI. */
export function usableFeatureIds(ctx: GameContext): string[] {
  const ids = ctx.playerDef.defaultFeatureIds ?? [];
  return ids.filter((id) => canUseFeature(ctx, id));
}

/** Can the player Dash this turn? Rogues L2+ may spend a Bonus Action via Cunning Action instead. */
export function canDash(ctx: GameContext): boolean {
  return hasCunningAction(ctx)
    ? (canSpendBonusAction(ctx) || canSpendAction(ctx))
    : canSpendAction(ctx);
}

/** Can the player Dodge this turn? */
export function canDodge(ctx: GameContext): boolean { return canSpendAction(ctx); }

/** Can the player take the SEARCH action right now? Always free during
 *  exploration; in combat it costs the full Action (no Cunning Action
 *  fast-track per SRD — Search is not on the Bonus Action list). */
export function canSearch(ctx: GameContext): boolean {
  const s = ctx.state;
  if (s.phase === 'exploring') return true;
  if (s.phase !== 'player_turn') return false;
  return canSpendAction(ctx);
}

/** Can the player Disengage this turn? Requires a living enemy to be meaningful. Rogues L2+ may spend a Bonus Action via Cunning Action instead. */
export function canDisengage(ctx: GameContext): boolean {
  if (!hasLivingEnemies(ctx)) return false;
  return hasCunningAction(ctx)
    ? (canSpendBonusAction(ctx) || canSpendAction(ctx))
    : canSpendAction(ctx);
}

/** Can the player Detach an attached creature this turn? */
export function canDetach(ctx: GameContext): boolean {
  return canSpendAction(ctx) && ctx.state.player.ongoingEffects.some((oe) => oe.kind === 'attach');
}

/** Can the player take a Short Rest right now (always in exploring phase)? */
export function canShortRest(ctx: GameContext): boolean {
  const s = ctx.state;
  const hitDiceRemaining = ctx.playerDef.level - s.player.hitDiceUsed;
  return s.phase === 'exploring'
    && s.player.hp > 0
    && s.player.hp < ctx.playerDef.maxHp
    && hitDiceRemaining > 0;
}

/**
 * Maximum tile distance at which the player's equipped weapon can attack:
 *   - melee weapon → 1 tile (5 ft reach)
 *   - ranged weapon → floor(rangeLong / 5) tiles
 *   - thrown attacks are NOT considered here (they use the THROW button / tool)
 */
export function playerAttackReachTiles(ctx: GameContext): number {
  const atk = ctx.playerDef.mainAttack;
  if (atk.rangeLong && atk.rangeLong > 0) return Math.floor(atk.rangeLong / 5);
  return 1;
}

/**
 * Can the player attack the given target (or, if none, the currently selected target)?
 * In `exploring` phase, this triggers combat — no action-economy check applies.
 * In `player_turn`, the player must have an Action available and the target must
 * be within the equipped weapon's reach. Ranged weapons must also have ammunition
 * remaining in inventory.
 */
export function canAttackTarget(ctx: GameContext, targetId?: string): boolean {
  const s = ctx.state;
  const id = targetId ?? s.selectedTargetId;
  if (!id) return false;
  const target = s.npcs.find((n) => n.id === id && n.hp > 0 && n.disposition !== 'ally');
  if (!target) return false;
  const dist = chebyshev(s.player.tileX, s.player.tileY, target.tileX, target.tileY);
  const reach = playerAttackReachTiles(ctx);
  if (dist > reach) return false;

  const atk = ctx.playerDef.mainAttack;
  if (atk.ammunitionType) {
    const hasAmmo = s.player.inventoryIds.some((id) => id === atk.ammunitionType);
    if (!hasAmmo) return false;
  }

  if (s.phase === 'exploring') return true;
  return canSpendAction(ctx);
}

// ── Spellcasting guards ─────────────────────────────────────────────────────

/**
 * Can the player cast the given spell right now, given the spell's casting
 * time, the player's available actions/reactions, and the slot pool? This is
 * the pure-eligibility check — target/range validation is the resolver's job.
 */
export function canCastSpell(ctx: GameContext, spellId: string): boolean {
  const s = ctx.state;
  if (!ctx.playerDef.spellcastingAbility) return false;
  if (isIncapacitated(s.player.conditions)) return false;

  const spell = ctx.defs.spells.find((sp) => sp.id === spellId);
  if (!spell) return false;

  // Spell must be known: a cantrip the character knows, or a currently-prepared L1+ spell.
  const known = spell.level === 0
    ? ctx.playerDef.defaultCantripIds?.includes(spellId)
    : s.player.preparedSpellIds.includes(spellId);
  if (!known) return false;

  // Slot pool — cantrips skip this entirely.
  if (spell.level > 0) {
    const slot = s.player.spellSlots[spell.level - 1] ?? 0;
    if (slot <= 0) return false;
  }

  // Action economy gated by castingTime.
  switch (spell.castingTime) {
    case 'action':
      if (s.phase === 'exploring') return true;
      return canSpendAction(ctx);
    case 'bonus-action':
      return canSpendBonusAction(ctx);
    case 'reaction':
      // Reactions are interrupt-only — not directly castable from the player UI.
      // They fire automatically through resolver paths (Shield on hit, Feather Fall on fall).
      return false;
    default:
      // Ritual or longer casting times: exploring-only out-of-combat utility.
      return s.phase === 'exploring';
  }
}

/** Compute the full list of spell ids the player can cast right now. Used for UI. */
export function castableSpellIds(ctx: GameContext): string[] {
  if (!ctx.playerDef.spellcastingAbility) return [];
  const ids: string[] = [];
  for (const id of ctx.playerDef.defaultCantripIds ?? []) {
    if (canCastSpell(ctx, id)) ids.push(id);
  }
  for (const id of ctx.state.player.preparedSpellIds) {
    if (canCastSpell(ctx, id)) ids.push(id);
  }
  return ids;
}
