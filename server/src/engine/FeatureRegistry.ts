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
import type { GameEvent } from './types.js';
import { canUseFeature } from './ActionGuards.js';
import { playerSecondWind } from './CombatSystem.js';

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
